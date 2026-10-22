// Read-only selection of immutable CI inputs. Guard removal belongs to prepare-windows-security.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function selectInputs(repo, sourceSHA, fallbackBuildSHA, git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git') {
  assert(isAbsolute(repo) && isAbsolute(git), 'Source and trusted Git paths must be absolute');
  for (const sha of [sourceSHA, fallbackBuildSHA]) assert(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Inputs must be full immutable SHAs');
  const run = args => execFileSync(git, args, {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  assert.equal(run(['rev-parse', 'HEAD']), sourceSHA, 'Checkout differs from event source SHA');
  const guardedTree = run(['rev-parse', `${sourceSHA}^{tree}`]);
  const markers = ['native_selection.rs', 'windows_node_path.rs'].map(file => {
    const entry = run(['ls-tree', sourceSHA, '--', `backend/hexbot-core/src/${file}`]);
    assert(!entry || /^100644 blob [a-f0-9]{40}\t/.test(entry), 'Build interface must be a regular source file');
    return Boolean(entry);
  });
  assert(markers.every(Boolean) || markers.every(value => !value), 'Partial Windows build contract');
  if (markers.every(Boolean)) return {buildSHA: sourceSHA, securitySHA: sourceSHA, guardedTree, currentTree: true};
  assert.equal(run(['rev-parse', '--verify', `${fallbackBuildSHA}^{commit}`]), fallbackBuildSHA);
  return {buildSHA: fallbackBuildSHA, securitySHA: sourceSHA, currentTree: false};
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  if (process.platform === 'win32') assert(process.env.HEXBOT_CI_GIT, 'Windows CI must select trusted absolute Git');
  console.log(JSON.stringify(selectInputs(...process.argv.slice(2))));
}
