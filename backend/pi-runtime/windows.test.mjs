import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, parse} from 'node:path';
import {tmpdir} from 'node:os';
import hexbot, {canonicalPath, credentialPath, protectedPath, shellEnvironment, writeDenial} from './extension.ts';
import {gitExecutable, gitScanEnvironment, globalGitConfigs, isolationAvailable, isolatedCommand, policyRoot, within, workspaceProtected} from './isolation.ts';
import {nullDevice, windows} from './test-support.mjs';

function workspace(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hexbot-win32-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const home = join(root, 'home'), cwd = join(root, 'work');
  mkdirSync(home); mkdirSync(cwd);
  return {root, home, cwd};
}

test('containment compares path components and accepts roots with trailing separators', t => {
  const {root, cwd} = workspace(t);
  assert.equal(within(join(cwd, 'note.txt'), [cwd]), true);
  assert.equal(within(join(cwd, 'note.txt'), [cwd + '/']), true);
  assert.equal(within(cwd + '-other', [cwd]), false);
  assert.equal(within(root, [cwd]), false);
  assert.equal(within(cwd, [parse(cwd).root]), true);
});

test('owner Git scan settings are whitelisted and kept out of command environments', () => {
  const inherited = {HOME:'owner-home', GIT_CONFIG_GLOBAL:'owner-config', GIT_CONFIG_NOSYSTEM:'1', NODE_OPTIONS:'untrusted', GIT_CONFIG_COUNT:'1'};
  const env = {HEXBOT_GIT_SCAN_ENV:JSON.stringify(inherited), GIT_CONFIG_GLOBAL:'sanitized'};
  assert.deepEqual(gitScanEnvironment(env), {HOME:'owner-home', GIT_CONFIG_GLOBAL:'owner-config', GIT_CONFIG_NOSYSTEM:'1'});
  assert.deepEqual(shellEnvironment(env), {});
  assert.throws(() => gitScanEnvironment({HEXBOT_GIT_SCAN_ENV:'[]'}), /owner Git scan settings/);
});

test('Windows drive, UNC and mixed separator paths retain their roots', {skip:!windows}, t => {
  const {home, cwd} = workspace(t);
  writeFileSync(join(home, 'auth.json'), 'private');
  for (const path of [join(home, 'auth.json'), join(home, 'auth.json').replaceAll('\\', '/'), home + '\\AUTH.JSON', home + '\\auth.json. ', '\\\\?\\' + home + '\\auth.json']) {
    assert.equal(canonicalPath(path, cwd), canonicalPath(join(home, 'auth.json'), cwd), path);
    assert.equal(credentialPath(path, home), true, path);
  }
  assert.equal(canonicalPath('C:\\uncreated\\a', cwd), 'C:\\uncreated\\a');
  assert.equal(canonicalPath('\\\\localhost\\missing-share\\', cwd), '\\\\localhost\\missing-share\\');
  assert.equal(within('D:\\outside', ['C:\\']), false);
  assert.equal(protectedPath(home + '\\..\\project\\.GIT\\config', home), true);
  for (const path of ['C:relative', 'C:', home + '\\auth.json:secret', '\\\\.\\PhysicalDrive0']) assert.throws(() => canonicalPath(path, cwd), /Windows/);
});

test('Windows junctions preserve parent traversal and cannot hide Git or credential targets', {skip:!windows}, t => {
  const {root, home, cwd} = workspace(t);
  const target = join(root, 'target');
  mkdirSync(join(target, 'nested'), {recursive:true});
  writeFileSync(join(target, '.env'), 'secret');
  symlinkSync(join(target, 'nested'), join(cwd, 'junction'), 'junction');
  assert.equal(canonicalPath(cwd + '\\junction\\..\\.env', cwd), join(target, '.env'));
  assert.equal(credentialPath(cwd + '\\junction\\..\\.env', home), true);
  mkdirSync(join(target, 'repo.git/objects'), {recursive:true});
  writeFileSync(join(target, 'repo.git/HEAD'), 'ref: refs/heads/main\n');
  symlinkSync(join(target, 'repo.git'), join(cwd, 'metadata'), 'junction');
  assert.match(writeDenial('metadata/config', cwd, home), /Git metadata/);
});

test('Windows Git and credential policy uses native profile and program directories', {skip:!windows}, t => {
  const {home, cwd} = workspace(t);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    assert.equal(policyRoot('%LOCALAPPDATA%/Microsoft/Credentials'), join(local, 'Microsoft/Credentials'));
    assert.equal(credentialPath(join(local, 'Google/Chrome/User Data/Default/Cookies'), home), true);
    assert.equal(credentialPath(join(local, 'Microsoft/Credentials/token'), home), true);
  }
  assert.equal(policyRoot('%HEXBOT_MISSING_TEST_ENV%/x'), undefined);
  assert.deepEqual(globalGitConfigs({USERPROFILE:home, GIT_CONFIG_NOSYSTEM:'1'}), [join(home, '.gitconfig'), join(home, '.config/git/config')]);
  assert.deepEqual(globalGitConfigs({HOME:cwd, USERPROFILE:home, GIT_CONFIG_NOSYSTEM:'1'}), [join(cwd, '.gitconfig'), join(cwd, '.config/git/config')]);
  assert.deepEqual(globalGitConfigs({ProgramFiles:'C:\\Program Files', ProgramData:'C:\\ProgramData'}), ['C:\\Program Files\\Git\\etc\\gitconfig', 'C:\\ProgramData\\Git\\config']);
  assert.deepEqual(globalGitConfigs({HOME:cwd, USERPROFILE:home, PROGRAMFILES:'C:\\Program Files', PROGRAMDATA:'C:\\ProgramData', GIT_CONFIG_NOSYSTEM:'false'}).slice(-2), ['C:\\Program Files\\Git\\etc\\gitconfig', 'C:\\ProgramData\\Git\\config']);
  assert.deepEqual(globalGitConfigs({LOCALAPPDATA:'C:\\Users\\Alex\\AppData\\Local'}), ['C:\\Users\\Alex\\AppData\\Local\\Programs\\Git\\etc\\gitconfig']);
  assert.equal(within(join(home, 'note.txt'), [home.toUpperCase()]), true);
  for (const key of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC']) if (process.env[key]) assert.equal(shellEnvironment(process.env)[key], process.env[key]);
});

test('per-user Git system configuration keeps its configured workspace hooks read-only', {skip:!windows}, t => {
  const {root, home, cwd} = workspace(t);
  const git = gitExecutable();
  execFileSync(git, ['init', '-q', cwd]);
  const local = join(root, 'local');
  mkdirSync(join(local, 'Programs/Git/etc'), {recursive:true});
  writeFileSync(join(local, 'Programs/Git/etc/gitconfig'), '[core]\n\thooksPath = .githooks\n');
  mkdirSync(join(cwd, '.githooks'));
  const env = {...process.env, LOCALAPPDATA:local, GIT_CONFIG_GLOBAL:nullDevice};
  delete env.GIT_CONFIG_NOSYSTEM; delete env.GIT_CONFIG_SYSTEM;
  assert(globalGitConfigs(env).includes(join(local, 'Programs/Git/etc/gitconfig')));
  const scan = workspaceProtected([cwd], undefined, env);
  assert.match(writeDenial('.githooks/pre-commit', cwd, home, [], scan), /Git metadata is read-only/);
  assert.equal(writeDenial('notes.txt', cwd, home, [], scan), undefined);
});

test('native Windows shell preserves approvals and environment and fails closed without its process helper', {skip:!windows, timeout:30000}, async t => {
  const {root, home, cwd} = workspace(t);
  const sandboxed = isolationAvailable();
  if (!sandboxed) assert.equal(isolatedCommand('Write-Output ok', home, [], [cwd]), 'Write-Output ok');
  const previousConfig = process.env.HEXBOT_SESSION_CONFIG, previousSecret = process.env.HEXBOT_WINDOWS_SECRET;
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL, previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  t.after(() => { for (const [key, value] of Object.entries({HEXBOT_SESSION_CONFIG:previousConfig, HEXBOT_WINDOWS_SECRET:previousSecret, GIT_CONFIG_GLOBAL:previousGlobal, GIT_CONFIG_NOSYSTEM:previousNoSystem})) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.GIT_CONFIG_GLOBAL = nullDevice; process.env.GIT_CONFIG_NOSYSTEM = '1';
  const config = {home, cwd, tools:[], prompt:'Frozen Windows prompt', enabledToolsets:['terminal'], provider:'test', model:'test'};
  const configPath = join(root, 'session.json'); writeFileSync(configPath, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = configPath; process.env.HEXBOT_WINDOWS_SECRET = 'hidden-provider-secret';
  const handlers = {}, tools = {}, approvals = [];
  const settings = {...config, approvalMode:'manual'};
  let choice = 'deny';
  const ctx = {ui:{async input() {return JSON.stringify({result:settings});}, async select(title) {approvals.push(JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length))); return choice;}}};
  hexbot({on:(name, handler) => handlers[name] = handler, registerTool:tool => tools[tool.name] = tool, registerProvider() {}});
  assert.equal(tools.bash.name, 'bash');
  assert.match(tools.bash.description, /PowerShell/);
  const command = 'Write-Output "Windows works 🦉"; Write-Output $env:HEXBOT_WINDOWS_SECRET';
  let id = 0;
  const gate = (input, callId = String(++id)) => handlers.tool_call({toolName:'bash', input, toolCallId:callId}, ctx);
  for (const mode of ['manual', 'smart']) {
    settings.approvalMode = mode; choice = 'deny';
    assert.equal((await gate({command, full_access:true})).block, true);
    assert.match(approvals.at(-1).reason, sandboxed ? /outside OS containment/ : /no OS sandbox/);
    assert.equal(approvals.at(-1).review, undefined);
    choice = 'once'; const callId = String(++id);
    assert.equal(await gate({command}, callId), undefined);
    if (!process.env.HEXBOT_DAEMON_EXECUTABLE) {
      await assert.rejects(tools.bash.execute(callId, {command}, undefined, undefined, ctx), /native Hexbot process helper is unavailable/);
      continue;
    }
    const result = await tools.bash.execute(callId, {command}, undefined, undefined, ctx);
    assert.equal(result.structuredContent.exit_code, 0);
    assert.match(result.structuredContent.output, /Windows works/);
    assert.doesNotMatch(JSON.stringify(result), /hidden-provider-secret|ran in the sandbox/);
    settings.canAsk = false;
    const unattended = await gate({command});
    if (sandboxed) assert.equal(unattended, undefined);
    else assert.match(unattended.reason, /visible section/);
    delete settings.canAsk;
  }
  // Changes during the user card must invalidate the original grant.
  const select = ctx.ui.select;
  ctx.ui.select = async title => {const answer = await select(title); settings.cwd = root; return answer;};
  const changed = String(++id); assert.match((await gate({command, full_access:true}, changed)).reason, /working directory changed/);
  await assert.rejects(tools.bash.execute(changed, {command}, undefined, undefined, ctx), /Try again/);
  settings.cwd = cwd; ctx.ui.select = select;
  if (!process.env.HEXBOT_DAEMON_EXECUTABLE) return;
  settings.approvalMode = 'off'; choice = 'deny';
  const bypass = String(++id); await gate({command}, bypass);
  assert.match((await tools.bash.execute(bypass, {command}, undefined, undefined, ctx)).structuredContent.output, /hidden-provider-secret/);
  const limit = String(++id); await gate({command:'Start-Sleep -Seconds 30', timeout:0.1}, limit);
  await assert.rejects(tools.bash.execute(limit, {command:'Start-Sleep -Seconds 30', timeout:0.1}, undefined, undefined, ctx), /timed out/);
});

test('a missing native process helper cannot run even an approved Windows command', {skip:!windows}, t => {
  const {cwd} = workspace(t);
  const marker = join(cwd, 'unowned.txt');
  const env = {...process.env}; delete env.HEXBOT_DAEMON_EXECUTABLE;
  const script = `const {createWindowsShellOperations}=await import(${JSON.stringify(new URL('./windows-shell.ts', import.meta.url).href)}); try {await createWindowsShellOperations().exec(${JSON.stringify(`[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'bad')`)}, ${JSON.stringify(cwd)}, {onData(){}}); process.exitCode=1;} catch(error) {if(!/native Hexbot process helper is unavailable/.test(error.message)) throw error; console.log('refused');}`;
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env, encoding:'utf8'}), /refused/);
  assert.equal(existsSync(marker), false);
});
