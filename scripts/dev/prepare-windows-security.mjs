// Nonpublishing CI only. Production source retains its unsupported-OS guard.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, rmSync, realpathSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const baseSHA = '74250404820380490678f7ebc6507a492801c411';
const dependencySquashSHA = '3405bd2854ba534b527202481a34f6d69d63033f';
const guard = Buffer.from('#[cfg(not(any(target_os = "macos", target_os = "linux")))]\ncompile_error!("The Hexbot daemon supports macOS and Linux only");\n');
export function stripUnsupportedGuard(before) {
  const start = before.indexOf(guard);
  assert(start >= 0 && before.indexOf(guard,start + guard.length) === -1, 'Expected exactly one exact unsupported-platform guard byte pattern');
  return Buffer.concat([before.subarray(0,start),before.subarray(start + guard.length)]);
}
export function validateCurrentTree(read) {
  for (const [path, pattern] of [
    ['backend/hexbot-core/src/native_selection.rs', /pub fn selected\(/],
    ['backend/hexbot-core/src/windows_node_path.rs', /pub fn node_path\(/],
    ['backend/hexbot-core/src/windows_sandbox.rs', /pub const UNAVAILABLE:/],
    ['backend/hexbot-core/src/credentials.rs', /pub fn require_supported_execution\(/],
  ]) assert.match(read(path), pattern, `Missing combined Windows interface: ${path}`);
}
function main() {
  const [destination, buildInput, securityInput = 'HEAD', mode] = process.argv.slice(2);
  const currentTree = mode === '--current-tree';
  assert(mode === undefined || currentTree, 'Unknown source preparation mode');
  assert(destination && isAbsolute(destination), 'Pass an absolute disposable worktree path');
  assert(/^[a-f0-9]{40}$/.test(buildInput ?? ''), 'Pin a full immutable build SHA');
  assert(securityInput === 'HEAD' || /^[a-f0-9]{40}$/.test(securityInput), 'Pin a full security SHA or use HEAD');
  if (currentTree) assert(securityInput === buildInput, 'Current-tree mode requires two identical explicit immutable SHAs');
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
  const ancestor = (parent, child) => {
    try { run(['merge-base','--is-ancestor',parent,child]); return true; }
    catch (error) { if (error.status !== 1) throw error; return false; }
  };
  const buildSHA = sha(buildInput), securitySHA = sha(securityInput);
  const ancestry = parent => {
    let present = true;
    try { run(['cat-file','-e',`${parent}^{commit}`]); }
    catch (error) { if (error.status !== 128 && error.status !== 1) throw error; present = false; }
    return {sha:parent,present,build:present && ancestor(parent,buildSHA),security:present && ancestor(parent,securitySHA)};
  };
  // Both names identify the reviewed #132 dependency. Squash-main source can
  // descend from its main commit without retaining the original branch history.
  const baselineAncestry = [ancestry(baseSHA),ancestry(dependencySquashSHA)];
  if (!currentTree) assert(baselineAncestry.some(base => base.build && base.security), 'Historical combination requires a shared recorded dependency ancestor');
  if (currentTree) validateCurrentTree(path => run(['show',`${buildSHA}:${path}`]));
  const needsSecurityDelta = !currentTree && !ancestor(securitySHA,buildSHA);
  let appliedSecurityPatch = false;
  let patchBaseSHA = null;
  if (needsSecurityDelta) {
    const bases = run(['merge-base','--all',buildSHA,securitySHA]).split('\n');
    assert(bases.length === 1 && /^[a-f0-9]{40}$/.test(bases[0]), 'Expected one unambiguous patch merge base');
    patchBaseSHA = bases[0];
    assert(baselineAncestry.some(base => base.present && ancestor(base.sha,patchBaseSHA)), 'Patch base must include a recorded dependency ancestor');
    // A metadata-only security child may not be an ancestor of the build, but
    // its empty tree delta must leave that build exactly unchanged.
    appliedSecurityPatch = run(['rev-parse',`${patchBaseSHA}^{tree}`]) !== run(['rev-parse',`${securitySHA}^{tree}`]);
  }
  const patch = join(tmpdir(),`hexbot-security-${process.pid}-${createHash('sha256').update(destination).digest('hex').slice(0,12)}.patch`);
  let created = false;
  try {
    run(['-c','core.autocrlf=false','worktree','add','--detach',destination,buildSHA]);
    created = true;
    if (appliedSecurityPatch) {
      run(['diff','--binary','--full-index',`--output=${patch}`,patchBaseSHA,securitySHA]);
      run(['apply','--3way','--index',patch],destination);
    }
    const guardedTree = run(['write-tree'],destination);
    if (!appliedSecurityPatch) assert.equal(guardedTree,run(['rev-parse',`${buildSHA}^{tree}`]),'Source without a security delta must remain exactly the pinned build tree');
    const source = join(destination,'backend/hexbot-core/src/lib.rs');
    const before = readFileSync(source);
    const after = stripUnsupportedGuard(before);
    writeFileSync(source,after);
    console.error(run(['diff','--','backend/hexbot-core/src/lib.rs'],destination));
    run(['add','backend/hexbot-core/src/lib.rs'],destination);
    const record = {
      sourceDir:destination, sourceMode:currentTree ? 'current-tree' : 'historical-combination',
      buildSHA, securitySHA, baseSHA, dependencySquashSHA, baselineAncestry, patchBaseSHA, appliedSecurityPatch,
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
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main();
