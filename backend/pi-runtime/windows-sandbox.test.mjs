import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {cleanupIsolatedCommand, isolatedCommand, isolationAvailable} from './isolation.ts';
import {createWindowsShellOperations} from './windows-shell.ts';
import {shellEnvironment} from './extension.ts';
import {windows, nullDevice} from './test-support.mjs';

const built = fileURLToPath(new URL('../hexbot-core/target/debug/hexbot.exe', import.meta.url));
const helper = process.env.HEXBOT_DAEMON_EXECUTABLE ?? (existsSync(built) ? built : undefined);
const required = process.env.HEXBOT_REQUIRE_SANDBOX_TESTS === '1';

test('real Windows sandbox bridge confines PowerShell and cleans permissions after completion, timeout and abort', {skip:!windows || !helper && !required && 'build the native daemon to run AppContainer integration', timeout:120000}, async t => {
  assert(helper && existsSync(helper), 'HEXBOT_DAEMON_EXECUTABLE must name the built daemon');
  const previous = {HEXBOT_DAEMON_EXECUTABLE:process.env.HEXBOT_DAEMON_EXECUTABLE, GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM:process.env.GIT_CONFIG_NOSYSTEM};
  t.after(() => {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}});
  process.env.HEXBOT_DAEMON_EXECUTABLE = helper;
  process.env.GIT_CONFIG_GLOBAL = nullDevice; process.env.GIT_CONFIG_NOSYSTEM = '1';
  assert.equal(isolationAvailable(), true, 'the real native containment probe must pass');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hexbot-pi-appcontainer-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const home = join(root, 'home'), work = join(root, 'work'), output = join(home, 'profiles/owl/artifacts');
  mkdirSync(join(work, '.git'), {recursive:true}); mkdirSync(output, {recursive:true});
  writeFileSync(join(work, '.git/config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(work, '.env'), 'private'); writeFileSync(join(home, 'config.yaml'), 'keep');
  writeFileSync(join(work, 'plain.txt'), 'readable'); writeFileSync(join(root, 'outside.txt'), 'outside');
  const quote = path => "'" + path.replaceAll("'", "''") + "'";
  const run = async (command, writable = [work, output], opts = {}) => {
    let text = '';
    const wrapped = isolatedCommand(command, home, [output], writable, [work, output]);
    const result = await createWindowsShellOperations({cleanup:cleanupIsolatedCommand}).exec(wrapped, work, {env:shellEnvironment(process.env), onData:data => text += data, timeout:30, ...opts});
    return {...result, text};
  };
  const check = await run(`$ErrorActionPreference='Stop';
if ([IO.File]::ReadAllText(${quote(join(work, 'plain.txt'))}) -ne 'readable') {exit 10};
try {[IO.File]::ReadAllText(${quote(join(work, '.env'))}) | Out-Null; exit 11} catch {};
try {[IO.File]::WriteAllText(${quote(join(work, '.git/config'))}, 'bad'); exit 12} catch {};
try {[IO.File]::WriteAllText(${quote(join(root, 'outside.txt'))}, 'bad'); exit 13} catch {};
[IO.File]::WriteAllText(${quote(join(work, 'result.txt'))}, 'written');
[IO.File]::WriteAllText(${quote(join(output, 'result.txt'))}, 'output');
Write-Output 'sandbox works 🦉'`);
  assert.equal(check.exitCode, 0, check.text);
  assert.match(check.text, /sandbox works 🦉/);
  assert.equal(readFileSync(join(work, 'result.txt'), 'utf8'), 'written');
  assert.equal(readFileSync(join(output, 'result.txt'), 'utf8'), 'output');
  assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'outside');
  const manual = await run(`try {[IO.File]::WriteAllText(${quote(join(work, 'manual.txt'))}, 'bad'); exit 11} catch {}; Write-Output 'read only'`, []);
  assert.equal(manual.exitCode, 0, manual.text);
  assert.equal(existsSync(join(work, 'manual.txt')), false);
  await assert.rejects(run('Start-Sleep -Seconds 30', [work], {timeout:0.5}), /timeout:/);
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 500);
  try {await assert.rejects(run('Start-Sleep -Seconds 30', [work], {signal:controller.signal}), /aborted/);} finally {clearTimeout(abort);}
  const leases = join(home, 'runtime/windows-sandbox');
  assert.deepEqual(existsSync(leases) ? readdirSync(leases) : [], [], 'all capability leases must be removed');
  // Successful and cancelled calls leave ordinary owner writes available.
  writeFileSync(join(work, 'after.txt'), 'owner');
});

test('each Windows shell step owns detached descendants through normal exit, timeout and abort', {skip:!windows || !helper && !required && 'build the native process helper to run Job integration', timeout:60000}, async t => {
  assert(helper && existsSync(helper), 'HEXBOT_DAEMON_EXECUTABLE must name the built daemon');
  const previous = process.env.HEXBOT_DAEMON_EXECUTABLE;
  t.after(() => {if (previous === undefined) delete process.env.HEXBOT_DAEMON_EXECUTABLE; else process.env.HEXBOT_DAEMON_EXECUTABLE = previous;});
  process.env.HEXBOT_DAEMON_EXECUTABLE = helper;
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'hexbot-pi-jobs-')));
  t.after(() => rmSync(cwd, {recursive:true, force:true}));
  const {powerShellArgs, powerShellExecutable} = await import('./windows-shell.ts');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const args = powerShellArgs('Start-Sleep -Seconds 30').map(quote).join(',');
  const start = redirects => `$child=Start-Process -FilePath ${quote(powerShellExecutable())} -ArgumentList @(${args}) -PassThru -NoNewWindow ${redirects}; Write-Output ('CHILD=' + $child.Id);`;
  const alive = pid => {try {process.kill(pid, 0); return true;} catch (error) {if (error.code === 'ESRCH') return false; throw error;}};
  for (const detached of [false, true]) {
    let output = '';
    const redirect = detached ? `-RedirectStandardOutput ${quote(join(cwd,'child.out'))} -RedirectStandardError ${quote(join(cwd,'child.err'))}` : '';
    const result = await createWindowsShellOperations().exec(start(redirect) + ' exit 0', cwd, {env:process.env, timeout:20, onData:data => output += data});
    assert.equal(result.exitCode, 0, output);
    const pid = Number(output.match(/CHILD=(\d+)/)?.[1]);
    assert(pid, output); assert.equal(alive(pid), false, `normal completion left descendant ${pid} running`);
  }
  for (const mode of ['timeout', 'abort']) {
    let output = '';
    const controller = new AbortController();
    const result = createWindowsShellOperations().exec(start('') + ' Start-Sleep -Seconds 30', cwd, {env:process.env, timeout:mode === 'timeout' ? 10 : 20, signal:controller.signal, onData:data => {
      output += data;
      if (mode === 'abort' && /CHILD=\d+/.test(output)) controller.abort();
    }});
    await assert.rejects(result, mode === 'abort' ? /aborted/ : /timeout:/);
    const pid = Number(output.match(/CHILD=(\d+)/)?.[1]);
    assert(pid, output); assert.equal(alive(pid), false, `${mode} left descendant ${pid} running`);
  }
});
