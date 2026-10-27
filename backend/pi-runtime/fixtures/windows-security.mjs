// Run natively in Windows CI. Other platforms exercise gate logic only, using
// a simulated platform after importing Pi; they do not validate Windows paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, delimiter, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const trustedModuleRoot = fileURLToPath(new URL('../',import.meta.url));
const trustedRoots = [resolve(trustedModuleRoot),fs.realpathSync(trustedModuleRoot)];

const simulated = process.argv.includes('--simulate-windows');
if (simulated) Object.defineProperty(process, 'platform', {value:'win32'});
assert.equal(process.platform, 'win32');
const root = fs.mkdtempSync(join(tmpdir(), 'hexbot-windows-security-'));
const originalCwd = process.cwd();
try {
  const home = join(root, 'home'), cwd = join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const malicious = join(cwd, 'hostile-path'); fs.mkdirSync(malicious);
  const marker = join(root, 'git-executed');
  // If a scanner searches PATH for git.exe, this copy of Node executes the
  // workspace's `config` script with git's arguments and leaves evidence.
  if (simulated) fs.symlinkSync(process.execPath, join(malicious, 'git.exe'));
  else fs.copyFileSync(process.execPath, join(malicious, 'git.exe'));
  fs.writeFileSync(join(cwd, 'config'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe Git search');`);
  // Confirm this is an executable attack fixture, then remove its evidence
  // before exercising the boundary. Production Pi's cwd is its workspace too.
  childProcess.execFileSync(join(malicious,'git.exe'),['config','--no-includes'],{cwd});
  assert.equal(fs.readFileSync(marker,'utf8'),'unsafe Git search');
  fs.rmSync(marker);
  process.chdir(cwd);
  process.env.PATH = malicious + delimiter + (process.env.PATH ?? '');
  fs.mkdirSync(join(cwd, '.git', 'hooks'), {recursive:true});
  fs.writeFileSync(join(cwd, '.git', 'config'), '[core]\n hooksPath = hooks\n');
  for (const local of ['connect.json', 'runtime/native-current.json', 'runtime/native/build/hexbot.exe']) {
    fs.mkdirSync(join(home, local, '..'), {recursive:true}); fs.writeFileSync(join(home, local), 'private');
  }
  fs.writeFileSync(join(cwd, '.env'), 'private');
  const config = {home, cwd, prompt:'Frozen', tools:[], enabledToolsets:['file', 'terminal']};
  const configPath = join(root, 'session.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = configPath;
  const handlers = {}, tools = {}, approvals = [];
  const settings = {...config, approvalMode:'smart'};
  const ctx = {ui:{
    input:async title => {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
      assert.equal(request.name, 'hexbot_session_settings');
      return JSON.stringify({result:settings});
    },
    select:async title => { approvals.push(title); return 'session'; },
  }};
  process.env.HOME = String.raw`\\hexbot-hostile.invalid\home`;
  process.env.USERPROFILE = String.raw`\\hexbot-hostile.invalid\profile`;
  const nativePath = join(home, 'runtime/native-current.json');
  const calls = [
    ['bash', {command:'printf "%s\\n" "quoted value"'}],
    ['bash', {command:'python -c "print(123)"', full_access:true, reason:'test'}],
    ['bash', {command:'curl https://example.com', full_access:true}],
    ...[join(home,'connect.json'),join(cwd,'.env'),join(root,'.ssh/id_ed25519')].map(path => ['read',{path}]),
    ...[join(cwd,'.git/hooks/pre-commit'),join(cwd,'.git/config'),nativePath,join(home,'runtime/native/build/hexbot.exe'),join(cwd,'ordinary.txt')].map(path => ['write',{path,content:'changed'}]),
    ['edit',{path:nativePath,oldText:'private',newText:'changed'}],
    ...['grep','find','ls'].map(tool => [tool,{path:cwd,pattern:'private'}]),
  ];
  // Intercept before importing or registering the extension. Only trusted
  // module reads and the explicit session config may reach the real filesystem.
  // Hostile HOME/USERPROFILE and every tool target must remain untouched.
  const originals = [], accesses = [];
  for (const [object, names] of [
    [fs, ['openSync','readFileSync','writeFileSync','readdirSync','opendirSync','lstatSync','statSync','realpathSync','accessSync','existsSync']],
    [fsPromises, ['open','readFile','writeFile','readdir','opendir','lstat','stat','realpath','access']],
    [childProcess, ['spawn','spawnSync','exec','execSync','execFile','execFileSync']],
  ]) for (const name of names) {
    const original = object[name];
    originals.push([object,name,original]);
    const intercept = fn => (...args) => {
      let path = args[0];
      try { if (path instanceof URL) path = fileURLToPath(path); } catch {}
      const target = typeof path === 'string' ? resolve(path) : '';
      const read = object !== childProcess && !['writeFile','writeFileSync'].includes(name);
      if (read && (target === configPath || trustedRoots.some(root => target === root || target.startsWith(root + '/') || target.startsWith(root + '\\')))) return fn(...args);
      accesses.push([name,String(path)]);
      throw new Error('Untrusted OS access must not be reached');
    };
    object[name] = intercept(original);
    if (typeof original.native === 'function') object[name].native = intercept(original.native);
  }
  syncBuiltinESMExports();
  let WINDOWS_ISOLATION_UNAVAILABLE;
  try {
    const extension = await import('../extension.ts');
    assert.deepEqual(extension.shellEnvironment({SystemRoot:'os',windir:'os',UserProfile:'profile',appdata:'roaming',LocalAppData:'local',NODE_OPTIONS:'bad',PYTHONPATH:'bad',BASH_ENV:'bad',OPENAI_API_KEY:'secret',ARBITRARY_CONNECTOR:'secret',COMSPEC:'bad',PATHEXT:'bad'}), {SystemRoot:'os',windir:'os',UserProfile:'profile',appdata:'roaming',LocalAppData:'local'});
    const isolation = await import('../isolation.ts');
    const {isolatedCommand,workspaceProtected} = isolation;
    const {canonicalPath} = extension;
    WINDOWS_ISOLATION_UNAVAILABLE = isolation.WINDOWS_ISOLATION_UNAVAILABLE;
    extension.default({on:(name, handler) => handlers[name] = handler, registerTool:tool => tools[tool.name] = tool, registerProvider() {}, registerCommand() {}});
    assert.match(tools.bash.description, /Bash syntax, not cmd.exe or PowerShell/);
    assert.deepEqual(accesses,[], 'registration must not resolve hostile homes');
    for (const mode of ['smart','manual','unknown']) {
      settings.approvalMode = mode;
      await Promise.all(calls.map(async ([toolName,input], index) => {
        const denial = await handlers.tool_call({toolName,input,toolCallId:`${mode}-${index}`},ctx);
        assert.deepEqual(denial,{block:true,reason:WINDOWS_ISOLATION_UNAVAILABLE});
        // No gate grant exists. Calling execute directly must still refuse.
        await assert.rejects(tools[toolName].execute(`${mode}-${index}`,input,undefined,undefined,ctx), /Windows tool isolation is not implemented/);
      }));
      const result = await handlers.user_bash({command:'echo bypass'},ctx);
      assert.equal(result.result.exitCode,1);
      assert.equal(result.result.output,WINDOWS_ISOLATION_UNAVAILABLE);
    }
    for (const workspace of [undefined,[],[cwd]]) assert.throws(() => isolatedCommand('echo unsafe',home,[],workspace), /Windows tool isolation is not implemented/);
    assert.throws(() => workspaceProtected([cwd]), /Windows tool isolation is not implemented/);
    for (const path of ['C:\\work\\file','C:relative','\\\\server\\share','\\\\.\\pipe\\hexbot','file:stream',nativePath]) {
      assert.throws(() => canonicalPath(path,cwd), /Windows tool isolation is not implemented/);
    }
    // Bypass retains the upstream tool but a mode change before execution closes
    // the grant. The user-bash hook must recheck too.
    settings.approvalMode = 'off';
    assert.equal(await handlers.tool_call({toolName:'bash',input:{command:'echo x'},toolCallId:'bypass'},ctx),undefined);
    const user = await handlers.user_bash({command:'echo x'},ctx);
    assert.equal(typeof user.operations.exec,'function');
    settings.approvalMode = 'smart';
    await assert.rejects(tools.bash.execute('bypass',{command:'echo x'},undefined,undefined,ctx), /Windows tool isolation is not implemented/);
    await assert.rejects(user.operations.exec('echo x',cwd,{}), /approval mode or working directory changed/);
    assert.deepEqual(approvals,[]);
    assert.deepEqual(accesses,[]);
  } finally {
    for (const [object,name,value] of originals) object[name] = value;
    syncBuiltinESMExports();
  }
  // Repeat with real OS functions and a malicious PATH, not just interceptors.
  for (const [toolName,input] of calls) {
    assert.equal((await handlers.tool_call({toolName,input,toolCallId:'real'},ctx)).block,true);
  }
  assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.existsSync(join(cwd,'ordinary.txt')),false);
  assert.equal(fs.readFileSync(nativePath,'utf8'),'private');
  if (!simulated) {
    // Bypass is explicitly uncontained. Exercise Pi's actual Bash dialect and
    // its honest missing-shell failure, after restoring safe fixture homes.
    const user = join(root,'bypass-home'); fs.mkdirSync(user);
    process.env.HOME = user; process.env.USERPROFILE = user;
    settings.approvalMode = 'off';
    const command = `printf '%s' 'a "quoted" value'`;
    assert.equal(await handlers.tool_call({toolName:'bash',input:{command},toolCallId:'quoted'},ctx),undefined);
    const result = await tools.bash.execute('quoted',{command,timeout:10},undefined,undefined,ctx);
    assert.equal(result.isError,undefined);
    assert.equal(result.structuredContent.output, 'a "quoted" value');
    process.env.ProgramFiles = join(root,'no-programs');
    process.env['ProgramFiles(x86)'] = join(root,'no-programs-x86');
    process.env.PATH = malicious;
    assert.equal(await handlers.tool_call({toolName:'bash',input:{command:'echo x'},toolCallId:'missing-bash'},ctx),undefined);
    await assert.rejects(tools.bash.execute('missing-bash',{command:'echo x',timeout:10},undefined,undefined,ctx), /No bash shell found/);
    assert.deepEqual(approvals,[]);
  }
  console.log('Windows fail-closed probes passed');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(root,{recursive:true,force:true});
}
