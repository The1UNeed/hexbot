// Read-only CI routing. Source preparation and guard removal have one owner.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCurrentTree} from './prepare-windows-security.mjs';

export const buildTrailer = 'Hexbot-Windows-Build:';
const metadataLines = message => message.split(/\r?\n/).filter(line => /^\s*Hexbot-Windows-Build(?:\s|:|$)/i.test(line));
export function recordedBuild(message) {
  const lines = metadataLines(message);
  assert.equal(lines.length, 1, 'Security-only source needs exactly one Hexbot-Windows-Build trailer');
  const match = /^Hexbot-Windows-Build: ([a-f0-9]{40})$/.exec(lines[0]);
  assert(match, 'Build trailer must contain exactly one full immutable commit SHA');
  return match[1];
}
export function selectInputs(repo, sourceSHA, git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git') {
  assert(isAbsolute(repo) && isAbsolute(git), 'Source and trusted Git paths must be absolute');
  assert(/^[a-f0-9]{40}$/.test(sourceSHA ?? ''), 'Source must be a full immutable SHA');
  const raw = args => execFileSync(git, args, {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const run = args => raw(args).trim();
  assert.equal(run(['rev-parse', 'HEAD']), sourceSHA, 'Checkout differs from event source SHA');
  const read = (sha, path) => {
    assert.match(run(['ls-tree', sha, '--', path]), /^100644 blob [a-f0-9]{40}\t/, 'Interface must be a regular source file');
    return run(['show', `${sha}:${path}`]);
  };
  const guardedTree = run(['rev-parse', `${sourceSHA}^{tree}`]);
  const markers = ['native_selection.rs', 'windows_node_path.rs'].map(file => Boolean(run(['ls-tree', sourceSHA, '--', `backend/hexbot-core/src/${file}`])));
  assert(markers.every(Boolean) || markers.every(value => !value), 'Partial Windows build contract');
  if (markers.every(Boolean)) {
    validateCurrentTree(path => read(sourceSHA, path));
    return {buildSHA: sourceSHA, securitySHA: sourceSHA, guardedTree, currentTree: true};
  }
  assert.match(read(sourceSHA, 'backend/hexbot-core/src/windows_sandbox.rs'), /pub const UNAVAILABLE:/);
  assert.match(read(sourceSHA, 'backend/hexbot-core/src/credentials.rs'), /pub fn require_supported_execution\(/);
  // Search immutable first-parent history only. The first recorded candidate
  // is authoritative: invalid syntax, objects or interfaces must fail closed.
  let buildSHA, metadataSHA;
  for (const commit of run(['rev-list', '--first-parent', sourceSHA]).split('\n')) {
    const message = raw(['show', '-s', '--format=%B', commit]);
    if (!metadataLines(message).length) continue;
    buildSHA = recordedBuild(message);
    metadataSHA = commit;
    break;
  }
  assert(metadataSHA, 'Security-only source needs exactly one recorded Hexbot-Windows-Build trailer in its first-parent history');
  assert.equal(run(['rev-parse', '--verify', `${buildSHA}^{commit}`]), buildSHA);
  validateCurrentTree(path => read(buildSHA, path));
  // Historical ancestry, unique merge base, and conflicting deltas are checked
  // by the shared preparation helper. No branch names or latest defaults.
  return {buildSHA, securitySHA: sourceSHA, metadataSHA, currentTree: false};
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  assert.equal(process.argv.length, 4, 'Pass exactly the absolute checkout and immutable event SHA');
  if (process.platform === 'win32') assert(process.env.HEXBOT_CI_GIT, 'Windows CI must select trusted absolute Git');
  console.log(JSON.stringify(selectInputs(...process.argv.slice(2))));
}
