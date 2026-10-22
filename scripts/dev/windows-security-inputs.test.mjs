import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectInputs} from './windows-security-inputs.mjs';

test('immutable routing supports security-only, combined, and squash trees without stale pins', () => {
  const repo = mkdtempSync(join(tmpdir(), 'windows-ci-routing-'));
  const git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git';
  const run = args => execFileSync(git, args, {cwd: repo, encoding: 'utf8', stdio: 'pipe'}).trim();
  const commit = () => {run(['add', '.']); run(['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture']); return run(['rev-parse', 'HEAD']);};
  try {
    run(['init', '-q']); writeFileSync(join(repo, 'security'), 'fixture'); const security = commit();
    assert.deepEqual(selectInputs(repo, security, security, git), {buildSHA: security, securitySHA: security, currentTree: false});
    mkdirSync(join(repo, 'backend/hexbot-core/src'), {recursive: true});
    writeFileSync(join(repo, 'backend/hexbot-core/src/native_selection.rs'), 'fixture'); const partial = commit();
    assert.throws(() => selectInputs(repo, partial, security, git), /Partial/);
    writeFileSync(join(repo, 'backend/hexbot-core/src/windows_node_path.rs'), 'fixture'); const combined = commit();
    const missing = 'a'.repeat(40);
    assert.equal(selectInputs(repo, combined, missing, git).currentTree, true);
    assert.throws(() => selectInputs(repo, security, combined, git), /Checkout differs/);
    run(['checkout', '--orphan', 'squash']); const squash = commit();
    const selected = selectInputs(repo, squash, missing, git);
    assert.equal(selected.buildSHA, squash); assert.equal(selected.securitySHA, squash);
    assert.equal(selected.guardedTree, run(['rev-parse', `${squash}^{tree}`]));
  } finally {rmSync(repo, {recursive: true, force: true});}
});
