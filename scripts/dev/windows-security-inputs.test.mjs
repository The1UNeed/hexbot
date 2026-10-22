import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordedBuild, selectInputs} from './windows-security-inputs.mjs';

test('security metadata accepts one literal immutable SHA and rejects executable, duplicate or missing inputs', () => {
  const sha = 'a'.repeat(40);
  assert.equal(recordedBuild(`fix: refusal\n\nHexbot-Windows-Build: ${sha}\n`), sha);
  for (const value of ['', `Hexbot-Windows-Build: HEAD`, `Hexbot-Windows-Build: ${sha};echo nope`, `Hexbot-Windows-Build: ${sha}\nHexbot-Windows-Build: ${sha}`, `Hexbot-Windows-Build: ${sha.toUpperCase()}`, `Hexbot-Windows-Build: ${sha} extra`])
    assert.throws(() => recordedBuild(value));
});

test('immutable routing supports metadata-only security, combined, and unrelated squash trees', () => {
  const repo = mkdtempSync(join(tmpdir(), 'windows-ci-routing-'));
  const git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git';
  const run = args => execFileSync(git, args, {cwd: repo, encoding: 'utf8', stdio: 'pipe'}).trim();
  const commit = message => {run(['add', '.']); run(['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '--allow-empty', '-qm', message]); return run(['rev-parse', 'HEAD']);};
  const source = join(repo, 'backend/hexbot-core/src');
  const write = (file, content) => writeFileSync(join(source, file), content);
  try {
    run(['init', '-q']); mkdirSync(source, {recursive: true});
    write('windows_sandbox.rs', 'pub const UNAVAILABLE:'); write('credentials.rs', 'pub fn require_supported_execution(');
    const security = commit('security foundation');
    assert.throws(() => selectInputs(repo, security, git), /exactly one/);
    write('native_selection.rs', 'pub fn selected('); const partial = commit('partial');
    assert.throws(() => selectInputs(repo, partial, git), /Partial/);
    write('windows_node_path.rs', 'pub fn node_path('); const combined = commit('build foundation');
    assert.equal(selectInputs(repo, combined, git).currentTree, true);
    assert.throws(() => selectInputs(repo, security, git), /Checkout differs/);
    run(['checkout', '--detach', security]);
    const metadata = commit(`fix(ci): record reviewed Windows probe input\n\nHexbot-Windows-Build: ${combined}`);
    assert.equal(run(['rev-parse', `${security}^{tree}`]), run(['rev-parse', `${metadata}^{tree}`]), 'Metadata commit must not change the source tree');
    assert.deepEqual(selectInputs(repo, metadata, git), {buildSHA: combined, securitySHA: metadata, metadataSHA: metadata, currentTree: false});
    const missing = commit(`fix: missing object\n\nHexbot-Windows-Build: ${'a'.repeat(40)}`);
    assert.throws(() => selectInputs(repo, missing, git));
    const stale = commit(`fix: missing build contract\n\nHexbot-Windows-Build: ${security}`);
    assert.throws(() => selectInputs(repo, stale, git));
    run(['checkout', '--detach', combined]);
    run(['checkout', '--orphan', 'squash']); const squash = commit('synthetic build squash without trailers or old dependency');
    const selected = selectInputs(repo, squash, git);
    assert.equal(selected.buildSHA, squash); assert.equal(selected.securitySHA, squash);
    assert.equal(selected.guardedTree, run(['rev-parse', `${squash}^{tree}`]));
    const alias = join(repo, 'source-alias');
    symlinkSync(fileURLToPath(new URL('.', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const stdout = execFileSync(process.execPath, [join(alias, 'windows-security-inputs.mjs'), repo, squash], {
      encoding: 'utf8', env: {...process.env, HEXBOT_CI_GIT: git},
    });
    assert.deepEqual(JSON.parse(stdout), selected);
  } finally {rmSync(repo, {recursive: true, force: true});}
});

test('source descendants inherit the nearest first-parent immutable pin without bypassing bad metadata', () => {
  const repo = mkdtempSync(join(tmpdir(), 'windows-pin-history-'));
  const git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git';
  const run = (args, input) => execFileSync(git, args, {cwd:repo, encoding:'utf8', stdio:['pipe','pipe','pipe'], input}).trim();
  const commit = message => {run(['add','.']); run(['-c','user.name=CI','-c','user.email=ci@example.invalid','commit','--allow-empty','--cleanup=verbatim','-qm',message]); return run(['rev-parse','HEAD']);};
  const checkout = sha => run(['checkout','--detach',sha]);
  const mergeCommit = (tree, parents, message) => run(['-c','user.name=CI','-c','user.email=ci@example.invalid','commit-tree',tree,...parents.flatMap(sha => ['-p',sha])],message);
  const source = join(repo,'backend/hexbot-core/src');
  try {
    run(['init','-q']); mkdirSync(source,{recursive:true});
    writeFileSync(join(source,'windows_sandbox.rs'),'pub const UNAVAILABLE:');
    writeFileSync(join(source,'credentials.rs'),'pub fn require_supported_execution(');
    const root = commit('security source with no recorded pin');
    writeFileSync(join(source,'native_selection.rs'),'pub fn selected(');
    writeFileSync(join(source,'windows_node_path.rs'),'pub fn node_path(');
    const build = commit('combined build');
    const nextBuild = mergeCommit(run(['rev-parse',`${build}^{tree}`]),[build],'another immutable build');
    checkout(root);
    const pin = commit(`record build\n\nHexbot-Windows-Build: ${build}`);
    writeFileSync(join(source,'credentials.rs'),'pub fn require_supported_execution(\n// ordinary core edit');
    const child = commit('ordinary core edit without a trailer');
    assert.deepEqual(selectInputs(repo,child,git),{buildSHA:build,securitySHA:child,metadataSHA:pin,currentTree:false});
    // A second-parent pin must not replace the source's first-parent choice.
    checkout(root);
    const sidePin = commit(`side branch pin\n\nHexbot-Windows-Build: ${nextBuild}`);
    const merged = mergeCommit(run(['rev-parse',`${child}^{tree}`]),[child,sidePin],'merge a side branch');
    checkout(merged);
    assert.equal(selectInputs(repo,merged,git).metadataSHA,pin);
    assert.equal(selectInputs(repo,merged,git).buildSHA,build);
    const nearest = commit(`new reviewed build\n\nHexbot-Windows-Build: ${nextBuild}`);
    mkdirSync(join(repo,'backend/pi-runtime'),{recursive:true});
    writeFileSync(join(repo,'backend/pi-runtime/credential-policy.json'),'{}');
    const later = commit('ordinary Pi follow-up without a trailer');
    assert.deepEqual(selectInputs(repo,later,git),{buildSHA:nextBuild,securitySHA:later,metadataSHA:nearest,currentTree:false});
    for (const message of [
      'Hexbot-Windows-Build: HEAD',
      `Hexbot-Windows-Build: ${build}\nHexbot-Windows-Build: ${nextBuild}`,
      ` Hexbot-Windows-Build: ${build}`,
      `Hexbot-Windows-Build: ${'a'.repeat(40)}`,
      `Hexbot-Windows-Build: ${root}`,
    ]) {
      checkout(later);
      const bad = commit(message);
      assert.throws(() => selectInputs(repo,bad,git));
      const afterBad = commit('ordinary edit after invalid metadata');
      assert.throws(() => selectInputs(repo,afterBad,git),'Do not search past a bad recorded pin');
    }
    // A pin present only on a merge's second parent is not recorded history.
    const noFirstParentPin = mergeCommit(run(['rev-parse',`${root}^{tree}`]),[root,sidePin],'merge without a first-parent pin');
    checkout(noFirstParentPin);
    assert.throws(() => selectInputs(repo,noFirstParentPin,git));
    checkout(nextBuild);
    assert.equal(selectInputs(repo,nextBuild,git).currentTree,true);
  } finally {rmSync(repo,{recursive:true,force:true});}
});
