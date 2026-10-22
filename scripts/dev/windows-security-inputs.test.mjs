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
    assert.deepEqual(selectInputs(repo, metadata, git), {buildSHA: combined, securitySHA: metadata, currentTree: false});
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
