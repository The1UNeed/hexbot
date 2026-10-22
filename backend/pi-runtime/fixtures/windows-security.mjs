// Run natively in Windows CI. Other platforms exercise gate logic only, using
// a simulated platform after importing Pi; they do not validate Windows paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
import hexbot, {canonicalPath} from '../extension.ts';
import {isolatedCommand, workspaceProtected, WINDOWS_ISOLATION_UNAVAILABLE} from '../isolation.ts';

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
  hexbot({on:(name, handler) => handlers[name] = handler, registerTool:tool => tools[tool.name] = tool, registerProvider() {}});
  assert.match(tools.bash.description, /Bash syntax, not cmd.exe or PowerShell/);
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
  // Intercept actual OS-entry functions after session registration. A gate must
  // refuse even when every filesystem operation errors and every spawn fails.
  // No fixture simulates successful sandboxed execution.
  const originals = [], accesses = [];
  for (const [object, names] of [
    [fs, ['openSync','readFileSync','writeFileSync','readdirSync','opendirSync','lstatSync','statSync','realpathSync','accessSync','existsSync']],
    [fsPromises, ['open','readFile','writeFile','readdir','opendir','lstat','stat','realpath','access']],
    [childProcess, ['spawn','spawnSync','exec','execSync','execFile','execFileSync']],
  ]) for (const name of names) {
    originals.push([object,name,object[name]]);
    object[name] = (...args) => { accesses.push([name,String(args[0])]); throw new Error('OS probe must not be reached'); };
  }
  syncBuiltinESMExports();
  try {
    for (const mode of ['smart','manual','unknown']) {
      settings.approvalMode = mode;
      await Promise.all(calls.map(async ([toolName,input], index) => {
        const denial = await handlers.tool_call({toolName,input,toolCallId:`${mode}-${index}`},ctx);
        assert.deepEqual(denial,{block:true,reason:WINDOWS_ISOLATION_UNAVAILABLE});
        // No gate grant exists. Calling execute directly must still refuse.
        await assert.rejects(tools[toolName].execute(`${mode}-${index}`,input,undefined,undefined,ctx));
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
    await assert.rejects(tools.bash.execute('bypass',{command:'echo x'},undefined,undefined,ctx), /approval mode changed/);
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
  console.log('Windows fail-closed probes passed');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(root,{recursive:true,force:true});
}
