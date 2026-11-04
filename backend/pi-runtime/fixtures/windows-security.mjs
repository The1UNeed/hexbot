// Run natively in Windows CI. Other platforms run the same probes on a
// simulated platform after importing Pi: they check the gates, the command line
// the sandbox helper gets and the extension's own path rules, not Windows
// paths, junctions or the AppContainer itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
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
// Stands in for `hexbot sandbox exec <policy> -- <program> [arguments]`: Node
// runs this script, named `sandbox`, from the workspace. It records its command
// line and runs the program without a container.
const STAND_IN = `const argv = process.argv.slice(2);
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'helper-call.json'), JSON.stringify({argv, cwd:process.cwd(), env:process.env}));
if (argv.at(-1) === 'hexbot-fixture-wait') { process.stdout.write('hexbot-fixture-started\\n'); setInterval(() => {}, 1000); }
else process.exit(require('node:child_process').spawnSync(argv[3], argv.slice(4), {stdio:'inherit'}).status ?? 1);
`;
try {
  const home = join(root, 'home'), cwd = join(root, 'workspace'), user = join(root, 'user');
  for (const dir of [home, cwd, user]) fs.mkdirSync(dir);
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
  for (const local of ['connect.json', 'runtime/native-current.json', 'runtime/native/build/hexbot.exe', 'profiles/owl/auth.json', 'users/u1/approvals/grant.json']) {
    fs.mkdirSync(join(home, local, '..'), {recursive:true}); fs.writeFileSync(join(home, local), 'private');
  }
  fs.writeFileSync(join(home, 'profiles/owl/notes.txt'), 'shared notes');
  fs.writeFileSync(join(cwd, '.env'), 'private');
  fs.writeFileSync(join(cwd, 'notes.txt'), 'time 10:30:45 needle');
  fs.writeFileSync(join(cwd, 'notes copy.txt'), 'copy of the notes');
  // A browser profile and a credential store, which the file tools never read.
  const opera = join(user, 'AppData/Roaming/Opera Software'), gh = join(user, 'AppData/Roaming/GitHub CLI');
  for (const dir of [opera, gh]) fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(join(opera, 'Login Data'), 'private'); fs.writeFileSync(join(gh, 'hosts.yml'), 'private');
  const config = {home, cwd, prompt:'Frozen', tools:[], enabledToolsets:['file', 'terminal']};
  const configPath = join(root, 'session.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = configPath;
  // The helper and Git Bash need not exist until the last pass runs real programs.
  const helper = join(root, 'hexbot.exe'), bash = join(root, 'Git', 'bin', 'bash.exe'), policy = 'cG9saWN5';
  const available = {kind:'appcontainer', helper, bash};
  const handlers = {}, tools = {}, approvals = [], policies = [], fileRequests = [], piSettings = {};
  const settings = {...config, approvalMode:'smart', sandbox:null};
  let policyReply = () => ({result:{helper, policy}});
  const ctx = {ui:{
    input:async title => {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
      if (request.name === 'hexbot_session_settings') return JSON.stringify({result:settings});
      if (request.name === 'hexbot_pi_file') {
        fileRequests.push(request.args);
        return JSON.stringify({result: request.args.operation === 'edit_open'
          ? {content: Buffer.from('private', 'utf8').toString('base64'), parent: ['1', '2']}
          : {success: true}});
      }
      assert.equal(request.name, 'hexbot_sandbox_policy');
      policies.push(request.args);
      return JSON.stringify(policyReply());
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
  // 'deny': only trusted module reads and the explicit session config reach the
  // OS. 'watch': the file system is real and spawn returns a recorded stand-in.
  // Every pass records any use of the hostile network name.
  let phase = 'deny', spawnWaiter;
  const originals = [], accesses = [], hostile = [], spawned = [], plans = [];
  const fakeSpawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), {stdout:new PassThrough(), stderr:new PassThrough(), pid:4242, exitCode:null, signalCode:null, kills:0});
    const end = (code, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      Object.assign(child, {exitCode:code, signalCode:signal});
      child.emit('exit', code, signal);
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = () => { child.kills++; setImmediate(() => end(null, 'SIGTERM')); return true; };
    // A plan without a code runs until it is killed.
    const plan = plans.shift() ?? {output:'', code:0};
    setImmediate(() => { if (plan.output) child.stdout.write(plan.output); if (plan.code !== undefined) end(plan.code); });
    const record = {file, args, options, child};
    spawned.push(record);
    spawnWaiter?.(record);
    return child;
  };
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
      if (typeof path === 'string' && path.includes('hexbot-hostile')) hostile.push([name, path]);
      // Only lstat may look at a link to a network share: anything else follows it.
      if (typeof path === 'string' && !/^lstat/.test(name) && /(share-link|[\\/]hop)([\\/]|$)/.test(path)) hostile.push([name, path]);
      if (phase === 'watch') return object === childProcess && name === 'spawn' ? fakeSpawn(...args) : fn(...args);
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
  let isolation, extension;
  const gate = (toolName, input, toolCallId) => handlers.tool_call({toolName, input, toolCallId}, ctx);
  const run = (toolName, input, toolCallId, signal, update) => tools[toolName].execute(toolCallId, input, signal, update, ctx);
  const text = result => result.content.map(item => item.text).join('\n');
  try {
    extension = await import('../extension.ts');
    assert.deepEqual(extension.shellEnvironment({SystemRoot:'os',windir:'os',UserProfile:'profile',appdata:'roaming',LocalAppData:'local',NODE_OPTIONS:'bad',PYTHONPATH:'bad',BASH_ENV:'bad',OPENAI_API_KEY:'secret',ARBITRARY_CONNECTOR:'secret',COMSPEC:'bad',PATHEXT:'bad'}), {SystemRoot:'os',windir:'os',UserProfile:'profile',appdata:'roaming',LocalAppData:'local'});
    isolation = await import('../isolation.ts');
    const {WINDOWS_ISOLATION_UNAVAILABLE:UNAVAILABLE, WINDOWS_FULL_ACCESS, NO_GIT_BASH, WINDOWS_PROFILE, WINDOWS_PATHS} = isolation;
    extension.default({on:(name, handler) => handlers[name] = handler, registerTool:tool => tools[tool.name] = tool, registerProvider() {}, getSettings:() => piSettings});
    assert.match(tools.bash.description, /Git Bash: use Bash syntax, not cmd.exe or PowerShell/);
    assert.match(tools.bash.description, /full_access is not available on Windows/);
    assert.deepEqual(accesses,[], 'registration must not resolve hostile homes');

    // Without the AppContainer every local tool refuses in every mode but
    // Bypass, before file access, shell discovery, approval or a policy request.
    for (const sandbox of [null, {kind:'sandbox-exec'}, {helper, bash}]) for (const mode of ['smart','manual','unknown']) {
      Object.assign(settings, {sandbox, approvalMode:mode});
      await Promise.all(calls.map(async ([toolName,input], index) => {
        assert.deepEqual(await gate(toolName, input, `${mode}-${index}`), {block:true, reason:UNAVAILABLE});
        // No gate grant exists. Calling execute directly must still refuse.
        await assert.rejects(run(toolName, input, `${mode}-${index}`), {message:UNAVAILABLE});
      }));
      assert.deepEqual((await handlers.user_bash({command:'echo bypass'},ctx)).result, {output:UNAVAILABLE, exitCode:1, cancelled:false, truncated:false});
    }

    // With it, full_access and file tools without a local profile still
    // refuse, whatever the mode, before anything is resolved.
    settings.sandbox = available;
    const refusalFor = ([toolName, input]) => toolName !== 'bash' ? WINDOWS_PROFILE : input.full_access ? WINDOWS_FULL_ACCESS : undefined;
    for (const mode of ['smart','manual']) {
      settings.approvalMode = mode;
      for (const [index, call] of calls.entries()) {
        const [toolName, input] = call, reason = refusalFor(call);
        assert.deepEqual(await gate(toolName, input, `available-${mode}-${index}`), reason && {block:true, reason});
        await assert.rejects(run(toolName, input, `direct-${mode}-${index}`), {message:reason ?? 'The approval mode changed before this ran. Try again.'});
      }
      assert.equal(typeof (await handlers.user_bash({command:'echo ok'},ctx)).operations.exec, 'function');
    }
    settings.sandbox = {...available, bash:null};
    assert.deepEqual(await gate('bash', {command:'echo x'}, 'no-git'), {block:true, reason:NO_GIT_BASH});
    await assert.rejects(run('bash', {command:'echo x'}, 'no-git'), {message:NO_GIT_BASH});
    assert.equal((await handlers.user_bash({command:'echo x'},ctx)).result.output, NO_GIT_BASH);

    // Network, device, stream and drive-relative paths refuse by their text.
    settings.sandbox = available;
    process.env.HOME = user; process.env.USERPROFILE = user;
    for (const [path, reason] of [
      [String.raw`\\hexbot-hostile.invalid\share\notes.txt`, WINDOWS_PATHS.network],
      ['//hexbot-hostile.invalid/share', WINDOWS_PATHS.network],
      [String.raw`\\?\C:\Windows\win.ini`, WINDOWS_PATHS.device],
      [String.raw`\\.\pipe\hexbot`, WINDOWS_PATHS.device],
      [String.raw`\??\C:\Windows\win.ini`, WINDOWS_PATHS.device],
      ['C:relative', WINDOWS_PATHS.relative],
      ['file:stream', WINDOWS_PATHS.stream],
      [join(cwd, 'notes.txt:secret'), WINDOWS_PATHS.stream],
      [join(cwd, 'NUL'), WINDOWS_PATHS.reserved],
      [join(cwd, 'com1.txt'), WINDOWS_PATHS.reserved],
      [join(cwd, 'notes.txt.'), WINDOWS_PATHS.trailing],
      [join(cwd, 'notes.txt '), WINDOWS_PATHS.trailing],
    ]) {
      assert.deepEqual(await gate('read', {path}, 'form'), {block:true, reason}, path);
      assert.throws(() => extension.canonicalPath(path, cwd), {message:reason}, path);
    }
    for (const workspace of [undefined,[],[cwd]]) assert.throws(() => isolation.isolatedCommand('echo unsafe',home,[],workspace), /only on macOS and Linux/);
    assert.throws(() => isolation.workspaceProtected([cwd]), /only on macOS and Linux/);
    // Bypass keeps the upstream tool, but a mode change before execution closes
    // the grant, with or without the sandbox. The user-bash hook rechecks too.
    settings.approvalMode = 'off';
    for (const id of ['bypass', 'bypass-gone']) assert.equal(await gate('bash',{command:'echo x'},id),undefined);
    const held = await handlers.user_bash({command:'echo x'},ctx);
    assert.equal(typeof held.operations.exec,'function');
    settings.approvalMode = 'smart';
    await assert.rejects(run('bash',{command:'echo x'},'bypass'), {message:'The approval mode changed before this ran. Try again.'});
    await assert.rejects(held.operations.exec('echo x',cwd,{}), /approval mode or working directory changed/);
    settings.sandbox = null;
    await assert.rejects(run('bash',{command:'echo x'},'bypass-gone'), {message:UNAVAILABLE});
    assert.deepEqual(approvals,[]);
    assert.deepEqual(accesses,[]);
    assert.deepEqual(policies,[]);
    assert.deepEqual(spawned,[]);

    // The file system is real from here; commands start stand-ins.
    phase = 'watch';
    settings.sandbox = available;
    process.env.HEXBOT_FIXTURE_SECRET = 'secret';
    process.env.BASH_ENV = join(cwd, 'startup.sh');
    // A contained command starts the helper directly, with the policy the daemon
    // gave for this section, Git Bash and the command as separate arguments, and
    // the sanitized environment. Neither mode asks.
    const command = `printf '%s|' "a \\"quoted\\" value" 'back\\slash' '$HOME'`;
    for (const mode of ['smart', 'manual']) {
      settings.approvalMode = mode;
      assert.equal(await gate('bash', {command}, `contained-${mode}`), undefined);
      plans.push({output:'contained\n', code:0});
      const result = await run('bash', {command, timeout:30}, `contained-${mode}`);
      assert.equal(result.structuredContent.output.trim(), 'contained');
      const call = spawned.at(-1);
      assert.equal(call.file, helper);
      assert.deepEqual(call.args, ['sandbox', 'exec', policy, '--', bash, '--noprofile', '--norc', '-c', command]);
      assert.deepEqual({cwd:call.options.cwd, stdio:call.options.stdio, windowsHide:call.options.windowsHide, shell:call.options.shell}, {cwd, stdio:['ignore','pipe','pipe'], windowsHide:true, shell:undefined});
      assert.equal(call.options.env.HEXBOT_FIXTURE_SECRET, undefined);
      assert.equal(call.options.env.BASH_ENV, undefined);
      assert.ok(Object.keys(call.options.env).some(name => name.toUpperCase() === 'PATH'));
      assert.deepEqual(policies.at(-1), {level:'confined'});
    }
    settings.approvalMode = 'smart';
    assert.equal(await gate('bash', {command:'exit 7'}, 'exit'), undefined);
    plans.push({output:'failed\n', code:7});
    const failed = await run('bash', {command:'exit 7'}, 'exit');
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.exit_code, 7);
    assert.match(text(failed), /Command exited with code 7/);
    assert.match(text(failed), /full_access is not available on Windows/);
    assert.doesNotMatch(text(failed), /run it again with full_access/);
    // A timeout or Stop kills the helper, whose job ends the command's processes.
    assert.equal(await gate('bash', {command:'sleep 30'}, 'timeout'), undefined);
    plans.push({});
    await assert.rejects(run('bash', {command:'sleep 30', timeout:0.05}, 'timeout'), /Command timed out after 0.05 seconds/);
    assert.equal(spawned.at(-1).child.kills, 1);
    assert.equal(await gate('bash', {command:'sleep 30'}, 'abort'), undefined);
    plans.push({});
    const controller = new AbortController();
    const started = new Promise(resolve => spawnWaiter = resolve);
    const aborted = run('bash', {command:'sleep 30'}, 'abort', controller.signal);
    await started; spawnWaiter = undefined;
    controller.abort();
    await assert.rejects(aborted, /Command aborted/);
    assert.equal(spawned.at(-1).child.kills, 1);
    // The code runtime's terminal and the user's own commands take the same path.
    const userCommand = await handlers.user_bash({command:'echo user'}, ctx);
    plans.push({output:'user\n', code:0});
    let userOutput = '';
    assert.deepEqual(await userCommand.operations.exec('echo user', cwd, {onData:data => userOutput += data}), {exitCode:0});
    assert.equal(userOutput, 'user\n');
    assert.deepEqual(spawned.at(-1).args, ['sandbox', 'exec', policy, '--', bash, '--noprofile', '--norc', '-c', 'echo user']);
    assert.equal(spawned.at(-1).options.env.HEXBOT_FIXTURE_SECRET, undefined);

    // Execution rechecks the live settings and starts nothing when they changed,
    // the request was stopped, or the daemon refused or garbled the policy.
    const counts = () => ({spawned:spawned.length, policies:policies.length});
    const before = counts();
    const pending = await handlers.user_bash({command:'echo x'}, ctx);
    for (const [index, sandbox] of [null, {kind:'sandbox-exec'}, {helper, bash}].entries()) {
      settings.sandbox = available;
      assert.equal(await gate('bash', {command:'echo x'}, `gone-${index}`), undefined);
      settings.sandbox = sandbox;
      await assert.rejects(run('bash', {command:'echo x'}, `gone-${index}`), {message:UNAVAILABLE});
      await assert.rejects(pending.operations.exec('echo x', cwd, {onData() {}}), {message:UNAVAILABLE});
    }
    settings.sandbox = available;
    assert.equal(await gate('bash', {command:'echo x'}, 'no-bash'), undefined);
    settings.sandbox = {...available, bash:null};
    await assert.rejects(run('bash', {command:'echo x'}, 'no-bash'), {message:NO_GIT_BASH});
    await assert.rejects(pending.operations.exec('echo x', cwd, {onData() {}}), {message:NO_GIT_BASH});
    settings.sandbox = available;
    assert.equal(await gate('bash', {command:'echo x'}, 'mode'), undefined);
    settings.approvalMode = 'manual';
    await assert.rejects(run('bash', {command:'echo x'}, 'mode'), /approval mode changed/);
    settings.approvalMode = 'smart';
    assert.equal(await gate('bash', {command:'echo x'}, 'stopped'), undefined);
    await assert.rejects(run('bash', {command:'echo x'}, 'stopped', AbortSignal.abort()), /Command aborted/);
    assert.deepEqual(counts(), before);
    policyReply = () => ({error:'Sandbox roots cannot be, contain or sit inside a credential store: x'});
    assert.equal(await gate('bash', {command:'echo x'}, 'refused'), undefined);
    await assert.rejects(run('bash', {command:'echo x'}, 'refused'), /credential store/);
    policyReply = () => ({result:{helper:'hexbot.exe', policy}});
    assert.equal(await gate('bash', {command:'echo x'}, 'by-name'), undefined);
    await assert.rejects(run('bash', {command:'echo x'}, 'by-name'), /sandbox policy is unavailable/);
    policyReply = () => ({result:{helper, policy}});
    assert.equal(spawned.length, before.spawned);

    // Bypass runs Pi's own Bash, from the shellPath the daemon names in Pi's
    // settings, and asks for no policy.
    const piBash = join(root, 'pi-bash.exe'); fs.writeFileSync(piBash, '');
    piSettings.shellPath = piBash;
    settings.approvalMode = 'off';
    const policyCount = policies.length;
    assert.equal(await gate('bash', {command:'echo bypass'}, 'bypass-shell'), undefined);
    plans.push({output:'bypass\n', code:0});
    assert.equal((await run('bash', {command:'echo bypass'}, 'bypass-shell')).structuredContent.output.trim(), 'bypass');
    assert.deepEqual([spawned.at(-1).file, spawned.at(-1).args], [piBash, ['-c', 'echo bypass']]);
    const bypassUser = await handlers.user_bash({command:'echo user'}, ctx);
    plans.push({output:'user\n', code:0});
    await bypassUser.operations.exec('echo user', cwd, {onData() {}});
    assert.deepEqual([spawned.at(-1).file, spawned.at(-1).args], [piBash, ['-c', 'echo user']]);
    assert.equal(policies.length, policyCount);
    delete piSettings.shellPath;
    delete process.env.HEXBOT_FIXTURE_SECRET;
    delete process.env.BASH_ENV;

    // The file tools read the workspace and keep credentials private, as the
    // daemon's stores name them (Windows ones too).
    settings.approvalMode = 'smart';
    const read = async (path, id) => (await gate('read', {path}, id)) ?? run('read', {path}, id);
    assert.match(JSON.stringify(await read(join(cwd, 'notes.txt'), 'notes')), /time 10:30:45 needle/);
    for (const path of [join(cwd, '.env'), join(home, 'connect.json'), join(home, 'profiles/owl/auth.json'), join(home, 'users/u1/approvals/grant.json'), join(opera, 'Login Data'), join(gh, 'hosts.yml')]) {
      assert.deepEqual(await gate('read', {path}, 'secret'), {block:true, reason:'Credential files are private.'}, path);
    }
    // Pi turns odd spaces into plain ones before it reads, so the gate does too.
    assert.deepEqual(await gate('read', {path:join(user, 'AppData/Roaming/Opera\u00A0Software/Login Data')}, 'nbsp'), {block:true, reason:'Credential files are private.'});
    assert.match(JSON.stringify(await read(join(cwd, 'notes\u00A0copy.txt'), 'nbsp-copy')), /copy of the notes/);
    if (!simulated) {
      // Git Bash spells C:\x as /c/x; Pi reads that as C:\x, and so does the gate.
      const notes = join(cwd, 'notes.txt');
      assert.equal(extension.canonicalPath('/' + notes[0].toLowerCase() + notes.slice(2).replaceAll('\\', '/'), cwd), extension.canonicalPath(notes, cwd));
    }
    // A link resolves before it is checked: a junction needs no privilege on
    // Windows, and a symbolic link may not be allowed to a standard user.
    const link = (target, path, type) => {
      try { fs.symlinkSync(target, path, type); return true; }
      catch (error) { if (!simulated && error.code === 'EPERM') return false; throw error; }
    };
    assert.ok(link(join(home, 'profiles/owl'), join(cwd, 'profile-link'), 'junction'));
    assert.deepEqual(await gate('read', {path:join(cwd, 'profile-link/auth.json')}, 'junction'), {block:true, reason:'Credential files are private.'});
    assert.match(JSON.stringify(await read(join(cwd, 'profile-link/notes.txt'), 'junction-notes')), /shared notes/);
    // A link to a network share is refused before it is followed, and a link
    // whose target Pi would read under another name is refused too.
    const shareLinked = link(String.raw`\\hexbot-hostile.invalid\share`, join(cwd, 'share-link'), 'dir');
    if (shareLinked) {
      link('share-link', join(cwd, 'hop'), 'dir');
      for (const path of [join(cwd, 'share-link/notes.txt'), join(cwd, 'hop/notes.txt')]) {
        assert.deepEqual(await gate('read', {path}, 'unc'), {block:true, reason:WINDOWS_PATHS.network}, path);
      }
    }
    assert.ok(link(join(user, 'AppData/Roaming/Opera\u00A0Software'), join(cwd, 'odd-link'), 'junction'));
    assert.deepEqual(await gate('read', {path:join(cwd, 'odd-link/Login Data')}, 'odd'), {block:true, reason:'Paths cannot contain non-breaking or other special spaces.'});
    // ls skips the links it cannot resolve to a local folder, and hides secrets.
    const listing = text((await gate('ls', {path:cwd}, 'ls')) ?? await run('ls', {path:cwd}, 'ls'));
    assert.match(listing, /^notes\.txt$/m);
    assert.match(listing, /^profile-link\/$/m);
    assert.doesNotMatch(listing, /^\.env$|share-link|^hop|odd-link/m);
    // Search output hides a credential's lines. A Windows name never holds ':',
    // so a match with one is still shown; a prefix Windows would refuse hides
    // its line.
    const found = ['notes.txt:1:time 10:30:45 needle', '.env:1:private', 'notes.txt-2-a -1- b'].join('\n');
    assert.equal(extension.sanitizeSearchResult(found, 'grep', cwd, home), 'notes.txt:1:time 10:30:45 needle');
    // The write and edit tools now reach the daemon's handle bridge: the
    // gate lets an ordinary file through, execution reaches the bridge, and
    // the extension itself writes nothing on disk.
    for (const tool of ['write', 'edit']) assert.equal(await gate(tool, {path:join(cwd, 'ordinary.txt'), content:'changed'}, tool), undefined, tool);
    assert.equal(await gate('write', {path:join(cwd, 'bridged.txt'), content:'changed'}, 'bridge-write'), undefined);
    await run('write', {path:join(cwd, 'bridged.txt'), content:'changed'}, 'bridge-write');
    assert.equal(fileRequests.at(-1)?.operation, 'write');
    assert.ok(fileRequests.at(-1)?.path?.endsWith('bridged.txt'), JSON.stringify(fileRequests.at(-1)));
    assert.equal(fs.existsSync(join(cwd, 'bridged.txt')), false);
    assert.equal(fs.existsSync(join(cwd, 'ordinary.txt')), false);
    assert.deepEqual(approvals, []);
    assert.deepEqual(hostile, []);
  } finally {
    for (const [object,name,value] of originals) object[name] = value;
    syncBuiltinESMExports();
  }
  // Repeat without the sandbox, with real OS functions and a malicious PATH,
  // not just interceptors.
  settings.sandbox = null;
  for (const [toolName,input] of calls) {
    assert.equal((await gate(toolName,input,'real')).block,true);
  }
  assert.equal(fs.existsSync(marker),false);
  assert.equal(fs.existsSync(join(cwd,'ordinary.txt')),false);
  assert.equal(fs.readFileSync(nativePath,'utf8'),'private');
  // Node stands in for the helper here: the command line it gets, the exit code
  // and the output it passes back, a timeout and Stop. Natively this needs Git
  // Bash; the AppContainer itself is the native Rust probes' to prove.
  const gitBash = simulated ? '/bin/bash' : [process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean).map(dir => join(dir, 'Git', 'bin', 'bash.exe')).find(path => fs.existsSync(path));
  if (gitBash) {
    fs.writeFileSync(join(cwd, 'sandbox'), STAND_IN);
    settings.sandbox = {kind:'appcontainer', helper:process.execPath, bash:gitBash};
    policyReply = () => ({result:{helper:process.execPath, policy}});
    settings.approvalMode = 'smart';
    const command = `printf '%s|' "a \\"quoted\\" value" 'back\\slash' '$HOME' && printf done`;
    assert.equal(await gate('bash', {command}, 'real-command'), undefined);
    const result = await run('bash', {command, timeout:30}, 'real-command');
    const call = JSON.parse(fs.readFileSync(join(cwd, 'helper-call.json'), 'utf8'));
    assert.deepEqual(call.argv, ['exec', policy, '--', gitBash, '--noprofile', '--norc', '-c', command]);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(cwd));
    assert.equal(call.env.HEXBOT_SESSION_CONFIG, undefined);
    if (simulated) assert.equal(result.structuredContent.output, 'a "quoted" value|back\\slash|$HOME|done');
    assert.equal(await gate('bash', {command:'exit 3'}, 'real-exit'), undefined);
    assert.equal((await run('bash', {command:'exit 3'}, 'real-exit')).structuredContent.exit_code, 3);
    assert.equal(await gate('bash', {command:'hexbot-fixture-wait'}, 'real-timeout'), undefined);
    await assert.rejects(run('bash', {command:'hexbot-fixture-wait', timeout:1}, 'real-timeout'), /Command timed out after 1 seconds/);
    const controller = new AbortController();
    let ready;
    const waiting = new Promise(resolve => ready = resolve);
    assert.equal(await gate('bash', {command:'hexbot-fixture-wait'}, 'real-abort'), undefined);
    const running = run('bash', {command:'hexbot-fixture-wait'}, 'real-abort', controller.signal, update => { if (JSON.stringify(update).includes('hexbot-fixture-started')) ready(); });
    await waiting;
    controller.abort();
    await assert.rejects(running, /Command aborted/);
  }
  if (!simulated) {
    // Bypass is explicitly uncontained. Exercise Pi's actual Bash dialect and
    // its honest missing-shell failure, after restoring safe fixture homes.
    const bypassHome = join(root,'bypass-home'); fs.mkdirSync(bypassHome);
    process.env.HOME = bypassHome; process.env.USERPROFILE = bypassHome;
    settings.approvalMode = 'off';
    const command = `printf '%s' 'a "quoted" value'`;
    assert.equal(await gate('bash',{command},'quoted'),undefined);
    const result = await run('bash',{command,timeout:10},'quoted');
    assert.equal(result.isError,undefined);
    assert.equal(result.structuredContent.output, 'a "quoted" value');
    process.env.ProgramFiles = join(root,'no-programs');
    process.env['ProgramFiles(x86)'] = join(root,'no-programs-x86');
    process.env.PATH = malicious;
    assert.equal(await gate('bash',{command:'echo x'},'missing-bash'),undefined);
    await assert.rejects(run('bash',{command:'echo x',timeout:10},'missing-bash'), /No bash shell found/);
    // The daemon names Git Bash in Pi's settings, so Bypass finds it anyway.
    if (gitBash) {
      piSettings.shellPath = gitBash;
      assert.equal(await gate('bash',{command},'pinned'),undefined);
      assert.equal((await run('bash',{command,timeout:10},'pinned')).structuredContent.output, 'a "quoted" value');
    }
    assert.deepEqual(approvals,[]);
  }
  console.log('Windows sandbox probes passed');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(root,{recursive:true,force:true});
}
