// Nonpublishing CI only. Production source retains its unsupported-OS guard.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';

const baseSHA = '74250404820380490678f7ebc6507a492801c411';
const guard = Buffer.from('#[cfg(not(any(target_os = "macos", target_os = "linux")))]\ncompile_error!("The Hexbot daemon supports macOS and Linux only");\n');
export function stripUnsupportedGuard(before) {
  const start = before.indexOf(guard);
  assert(start >= 0 && before.indexOf(guard,start + guard.length) === -1, 'Expected exactly one exact unsupported-platform guard byte pattern');
  return Buffer.concat([before.subarray(0,start),before.subarray(start + guard.length)]);
}
function main() {
const [destination, buildInput, securityInput = 'HEAD'] = process.argv.slice(2);
assert(destination && isAbsolute(destination), 'Pass an absolute disposable worktree path');
assert(/^[a-f0-9]{40}$/.test(buildInput ?? ''), 'Pin a full immutable build SHA');
assert(securityInput === 'HEAD' || /^[a-f0-9]{40}$/.test(securityInput), 'Pin a full security SHA or use HEAD');
assert(!existsSync(destination), 'Disposable worktree must not exist');
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const git = process.env.HEXBOT_CI_GIT ?? (process.platform === 'win32' ? undefined : '/usr/bin/git');
assert(git && isAbsolute(git), 'HEXBOT_CI_GIT must name a trusted absolute Git executable');
const run = (args, cwd = repo) => execFileSync(git,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sha = input => {
  const value = run(['rev-parse','--verify',`${input}^{commit}`]);
  assert(/^[a-f0-9]{40}$/.test(value));
  return value;
};
const buildSHA = sha(buildInput), securitySHA = sha(securityInput);
run(['merge-base','--is-ancestor',baseSHA,buildSHA]);
run(['merge-base','--is-ancestor',baseSHA,securitySHA]);
let appliedSecurityPatch = false;
try { run(['merge-base','--is-ancestor',securitySHA,buildSHA]); }
catch (error) { if (error.status !== 1) throw error; appliedSecurityPatch = true; }
const patch = join(tmpdir(),`hexbot-security-${process.pid}-${createHash('sha256').update(destination).digest('hex').slice(0,12)}.patch`);
let created = false;
try {
  run(['-c','core.autocrlf=false','worktree','add','--detach',destination,buildSHA]);
  created = true;
  if (appliedSecurityPatch) {
    run(['diff','--binary','--full-index',`--output=${patch}`,baseSHA,securitySHA]);
    run(['apply','--3way','--index',patch],destination);
  }
  const guardedTree = run(['write-tree'],destination);
  const source = join(destination,'backend/hexbot-core/src/lib.rs');
  const before = readFileSync(source);
  const after = stripUnsupportedGuard(before);
  writeFileSync(source,after);
  const guardDiff = run(['diff','--','backend/hexbot-core/src/lib.rs'],destination);
  console.error(guardDiff);
  run(['add','backend/hexbot-core/src/lib.rs'],destination);
  const record = {
    sourceDir:destination, buildSHA, securitySHA, baseSHA, appliedSecurityPatch,
    guardedTree, probeTree:run(['write-tree'],destination),
    guardBeforeSHA256:createHash('sha256').update(before).digest('hex'),
    guardAfterSHA256:createHash('sha256').update(after).digest('hex'),
  };
  console.error('Disposable native refusal inputs:',JSON.stringify(record));
  console.log(JSON.stringify(record));
} catch (error) {
  if (created) run(['worktree','remove','--force',destination]);
  throw error;
} finally {
  rmSync(patch,{force:true});
}

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
