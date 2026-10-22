import assert from 'node:assert/strict';
import test from 'node:test';
import {stripUnsupportedGuard, validateCurrentTree} from './prepare-windows-security.mjs';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const guard = '#[cfg(not(any(target_os = "macos", target_os = "linux")))]\ncompile_error!("The Hexbot daemon supports macOS and Linux only");\n';
test('disposable source edit removes only one exact guard and preserves all other bytes', () => {
  const before = Buffer.from('//! keep\n\n' + guard + '\nmod keep;\n');
  assert.deepEqual(stripUnsupportedGuard(before),Buffer.from('//! keep\n\n\nmod keep;\n'));
  assert.equal(before.includes(Buffer.from(guard)),true,'input bytes must not be mutated');
  for (const text of ['',guard.replaceAll('\n','\r\n'),guard.replace('Linux only','Linux'),guard + guard]) {
    assert.throws(() => stripUnsupportedGuard(Buffer.from(text)),/exactly one exact/);
  }
});

test('current-tree requires both build and refusal interfaces', () => {
  assert.throws(() => validateCurrentTree(() => ''),/Missing combined Windows interface/);
});

test('current-tree preserves a squash source exactly without historical dependency ancestry', t => {
  const root = mkdtempSync(join(tmpdir(),'hexbot-source-copy-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const repo = join(root,'repo'), destination = join(root,'copy');
  mkdirSync(join(repo,'scripts/dev'),{recursive:true});
  mkdirSync(join(repo,'backend/hexbot-core/src'),{recursive:true});
  const helper = join(repo,'scripts/dev/prepare-windows-security.mjs');
  copyFileSync(new URL('./prepare-windows-security.mjs',import.meta.url),helper);
  for (const [file, text] of Object.entries({
    'native_selection.rs':'pub fn selected(',
    'windows_node_path.rs':'pub fn node_path(',
    'windows_sandbox.rs':'pub const UNAVAILABLE:',
    'credentials.rs':'pub fn require_supported_execution(',
    'lib.rs':'//! preserve\n'+guard+'\nmod preserve;\n',
  })) writeFileSync(join(repo,'backend/hexbot-core/src',file),text);
  const git = process.env.HEXBOT_CI_GIT ?? '/usr/bin/git';
  const run = args => execFileSync(git,args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  run(['init','-q']);
  run(['add','.']);
  run(['-c','user.name=Hexbot test','-c','user.email=test@invalid','commit','-qm','synthetic squash source']);
  const source = run(['rev-parse','HEAD']);
  const output = execFileSync(process.execPath,[helper,destination,source,source,'--current-tree'],{cwd:repo,encoding:'utf8',env:{...process.env,HEXBOT_CI_GIT:git},stdio:['ignore','pipe','pipe']});
  const record = JSON.parse(output);
  assert.equal(record.guardedTree,run(['rev-parse',`${source}^{tree}`]));
  assert.equal(record.appliedSecurityPatch,false);
  assert.equal(record.patchBaseSHA,null);
  assert(record.baselineAncestry.every(base => !base.build && !base.security));
  assert.equal(record.sourceMode,'current-tree');
  assert(readFileSync(join(repo,'backend/hexbot-core/src/lib.rs'),'utf8').includes(guard));
  assert.equal(readFileSync(join(destination,'backend/hexbot-core/src/lib.rs'),'utf8'),'//! preserve\n\nmod preserve;\n');
  run(['worktree','remove','--force',destination]);
});
