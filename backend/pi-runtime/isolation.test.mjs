import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import {isolatedCommand, probeIsolation} from './isolation.ts';

// The Linux tests run the real bubblewrap when it passes the daemon's probe.
// CI installs it; Ubuntu 24.04 needs the AppArmor profile from the install docs.
const bubblewrap = process.platform === 'linux' && !!probeIsolation();
const needsBubblewrap = {skip: !bubblewrap && 'needs a working bubblewrap on Linux'};

test('sandbox protects newly created secrets and home writes but permits output folders and unrelated files', {skip:process.platform !== 'darwin'}, async t => {
  const base = mkdtempSync(join(tmpdir(), 'hexbot-isolation-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'), work = join(home, 'workspace');
  for (const dir of [work, join(home,'profiles/owl'), join(home,'bin'), join(home,'hooks'), join(home,'skills'), join(home,'profiles/owl/artifacts'), join(home,'runtime/sessions/one/attachments')]) mkdirSync(dir,{recursive:true});
  writeFileSync(join(base,'auth.json'),'outside');
  writeFileSync(join(base,'.env'),'outside');
  const script = `echo ready; read -r go; cat '${home}/profiles/owl/.env' >/dev/null 2>&1 && exit 10; cat '${home}/profiles/owl/auth.json' >/dev/null 2>&1 && exit 13; cat '${home}/connect-identity.key' >/dev/null 2>&1 && exit 19; cat '${home}/profiles/owl/connect-identity.key' >/dev/null 2>&1 && exit 20; cat '${base}/auth.json' || exit 11; cat '${base}/.env' || exit 14; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml workspace/result; do (echo bad > '${home}'/"$p") 2>/dev/null && exit 12; done; echo ok > '${home}/profiles/owl/artifacts/result'; echo ok > '${home}/runtime/sessions/one/attachments/result'; echo ok > '${base}/normal-workspace'; echo done`;
  // The cwd is the in-home workspace; it stays read-only like the rest of the home.
  const child = spawn('/bin/bash', ['-c',isolatedCommand(script,home,[join(home,'profiles/owl/artifacts'),join(home,'runtime/sessions/one/attachments')])], {cwd:work, stdio:['pipe','pipe','pipe']});
  t.after(() => {if(child.exitCode === null) child.kill();});
  let stderr=''; child.stderr.on('data',c=>stderr+=c);
  const exited = new Promise(resolve => child.on('close',resolve));
  const lines = createInterface({input:child.stdout});
  for await (const line of lines) {
    if (line === 'ready') {writeFileSync(join(home,'profiles/owl/.env'),'secret'); writeFileSync(join(home,'profiles/owl/auth.json'),'secret'); writeFileSync(join(home,'connect-identity.key'),'secret'); writeFileSync(join(home,'profiles/owl/connect-identity.key'),'secret'); child.stdin.end('go\n');}
  }
  assert.equal(await exited,0,stderr);
});

// The deny tier holds for any program: no textual guard is involved here.
test('the sandbox refuses writes to credential stores by any program and any case', {skip:process.platform !== 'darwin'}, async t => {
  const {execFileSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-stores-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const user = join(base, 'user'), home = join(base, 'home');
  mkdirSync(join(user, '.aws'), {recursive:true}); mkdirSync(home);
  writeFileSync(join(user, '.aws/credentials'), 'keep'); writeFileSync(join(user, '.netrc'), 'keep');
  writeFileSync(join(user, 'source'), 'replacement');
  const script = `curl -s -o "$HOME/.aws/credentials" "file://$HOME/source" 2>/dev/null && exit 17; truncate -s0 "$HOME/.netrc" 2>/dev/null && exit 18; echo x > "$HOME/.aws/credentials" 2>/dev/null && exit 10; echo x > "$HOME/.AWS/CREDENTIALS" 2>/dev/null && exit 11; echo x > "$HOME/.netrc" 2>/dev/null && exit 12; echo x > "$HOME/.npmrc" 2>/dev/null && exit 13; mkdir -p "$HOME/.config/gh" 2>/dev/null && exit 14; python3 -c 'open("'"$HOME"'/.aws/other","w")' 2>/dev/null && exit 15; echo ok > "$HOME/notes.txt" || exit 16; echo done`;
  const run = `const {isolatedCommand} = await import(${JSON.stringify(new URL('./isolation.ts', import.meta.url).href)}); const {spawnSync} = await import('node:child_process'); const child = spawnSync('/bin/bash', ['-c', isolatedCommand(${JSON.stringify(script)}, ${JSON.stringify(home)})], {encoding:'utf8'}); process.stdout.write(child.stdout); process.exit(child.status);`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', run], {env:{...process.env, HOME:user}, encoding:'utf8'});
  assert.equal(output, 'done\n');
  assert.equal(readFileSync(join(user, '.aws/credentials'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(user, '.netrc'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(user, 'notes.txt'), 'utf8'), 'ok\n');
});

// Renaming ~/.config would carry ~/.config/gh out from under its rule.
test('the sandbox keeps the parent of a nested store in place but lets siblings be created', {skip:process.platform !== 'darwin'}, async t => {
  const {execFileSync, spawnSync} = await import('node:child_process');
  const {realpathSync} = await import('node:fs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-ancestor-')));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const user = join(base, 'user'), home = join(base, 'home');
  mkdirSync(join(user, '.config/gh'), {recursive:true}); mkdirSync(home);
  writeFileSync(join(user, '.config/gh/hosts.yml'), 'keep');
  const script = `mv "$HOME/.config" "$HOME/.config2" 2>/dev/null && exit 10; rm -rf "$HOME/.config" 2>/dev/null; [ -d "$HOME/.config" ] || exit 11; mkdir "$HOME/.config/newapp" && echo ok > "$HOME/.config/newapp/settings" || exit 12; rm -r "$HOME/.config/newapp" || exit 13; chmod 700 "$HOME/.config" || exit 14; echo x > "$HOME/.config/gh/hosts.yml" 2>/dev/null && exit 15; echo done`;
  const run = `const {isolatedCommand} = await import(${JSON.stringify(new URL('./isolation.ts', import.meta.url).href)}); const {spawnSync} = await import('node:child_process'); const child = spawnSync('/bin/bash', ['-c', isolatedCommand(${JSON.stringify(script)}, ${JSON.stringify(home)})], {encoding:'utf8'}); process.stdout.write(child.stdout); process.exit(child.status);`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', run], {env:{...process.env, HOME:user}, encoding:'utf8'});
  assert.equal(output.stdout, 'done\n', output.stderr);
  assert.equal(readFileSync(join(user, '.config/gh/hosts.yml'), 'utf8'), 'keep');
  // Only the directories between the home and a store are pinned, each once.
  const profile = execFileSync(process.execPath, ['--input-type=module', '-e', `const {sandboxProfile} = await import(${JSON.stringify(new URL('./isolation.ts', import.meta.url).href)}); process.stdout.write(sandboxProfile(${JSON.stringify(home)}));`], {env:{...process.env, HOME:user}, encoding:'utf8'});
  assert.ok(profile.includes(`(deny file-write-unlink (literal ${JSON.stringify(join(user, '.config'))}))`), profile);
  assert.ok(!profile.includes(`file-write-unlink (literal ${JSON.stringify(user)})`));
});

// Masked files are bound to /dev/null, which a user namespace mounts nodev, so
// opening one fails; masked folders are empty; the home is read-only except the
// output folders; everything outside stays as it was.
test('bubblewrap masks secrets, keeps the home read-only and reopens output folders', needsBubblewrap, async t => {
  const {spawnSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-run-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'), work = join(home, 'workspace');
  for (const dir of [work, join(home,'profiles/owl'), join(home,'bin'), join(home,'hooks'), join(home,'skills'), join(home,'profiles/owl/artifacts'), join(home,'runtime/sessions/one/attachments'), join(home,'desktop-data')]) mkdirSync(dir,{recursive:true});
  for (const file of ['connect-identity.key', 'profiles/owl/connect-identity.key', 'profiles/owl/.env', 'profiles/owl/auth.json', 'desktop-data/token']) writeFileSync(join(home, file), 'secret');
  writeFileSync(join(base,'auth.json'),'outside');
  writeFileSync(join(base,'.env'),'outside');
  const script = `cat '${home}/profiles/owl/.env' >/dev/null 2>&1 && exit 10; cat '${home}/profiles/owl/auth.json' >/dev/null 2>&1 && exit 13; cat '${home}/connect-identity.key' >/dev/null 2>&1 && exit 19; cat '${home}/profiles/owl/connect-identity.key' >/dev/null 2>&1 && exit 20; [ -z "$(ls -A '${home}/desktop-data')" ] || exit 15; cat '${base}/auth.json' || exit 11; cat '${base}/.env' || exit 14; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml workspace/result; do (echo bad > '${home}'/"$p") 2>/dev/null && exit 12; done; echo ok > '${home}/profiles/owl/artifacts/result' || exit 16; echo ok > '${home}/runtime/sessions/one/attachments/result' || exit 17; echo ok > '${base}/normal-workspace' || exit 18; echo done`;
  const result = spawnSync('/bin/bash', ['-c', isolatedCommand(script, home, [join(home,'profiles/owl/artifacts'), join(home,'runtime/sessions/one/attachments')])], {cwd:work, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'outsideoutsidedone\n');
  assert.equal(readFileSync(join(home, 'profiles/owl/artifacts/result'), 'utf8'), 'ok\n');
  assert.equal(readFileSync(join(home, 'profiles/owl/.env'), 'utf8'), 'secret');
});

// An existing store is bound read-only, so no program can write, truncate or
// remove it, while its parent still takes new siblings. A store that does not
// exist yet has no bind (the shell guard asks when a command names one).
test('bubblewrap refuses writes to existing credential stores by any program', needsBubblewrap, async t => {
  const {spawnSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-stores-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const user = join(base, 'user'), home = join(base, 'home');
  mkdirSync(join(user, '.aws'), {recursive:true}); mkdirSync(join(user, '.config/gh'), {recursive:true}); mkdirSync(home);
  for (const file of ['.aws/credentials', '.netrc', '.config/gh/hosts.yml']) writeFileSync(join(user, file), 'keep');
  writeFileSync(join(user, 'source'), 'replacement');
  const script = `curl -s -o "$HOME/.aws/credentials" "file://$HOME/source" 2>/dev/null && exit 17; truncate -s0 "$HOME/.netrc" 2>/dev/null && exit 18; echo x > "$HOME/.aws/credentials" 2>/dev/null && exit 10; echo x > "$HOME/.netrc" 2>/dev/null && exit 12; echo x > "$HOME/.config/gh/hosts.yml" 2>/dev/null && exit 13; rm -f "$HOME/.netrc" 2>/dev/null && exit 19; rm -rf "$HOME/.aws" 2>/dev/null; [ -f "$HOME/.aws/credentials" ] || exit 20; python3 -c 'open("'"$HOME"'/.aws/other","w")' 2>/dev/null && exit 15; mkdir "$HOME/.config/newapp" && echo ok > "$HOME/.config/newapp/settings" || exit 14; echo ok > "$HOME/notes.txt" || exit 16; echo done`;
  const previous = process.env.HOME; process.env.HOME = user;
  let command;
  try { command = isolatedCommand(script, home); } finally { process.env.HOME = previous; }
  const result = spawnSync('/bin/bash', ['-c', command], {env:{...process.env, HOME:user}, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done\n');
  for (const file of ['.aws/credentials', '.netrc', '.config/gh/hosts.yml']) assert.equal(readFileSync(join(user, file), 'utf8'), 'keep', file);
  assert.equal(readFileSync(join(user, 'notes.txt'), 'utf8'), 'ok\n');
});

test('bubblewrap masks SSH private keys and leaves public SSH files readable', needsBubblewrap, async t => {
  const {spawnSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-ssh-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  mkdirSync(join(base, '.ssh/nested'), {recursive:true}); mkdirSync(join(base, 'hexbot'));
  for (const name of ['github', 'deploy_key', 'nested/id_ed25519', 'config', 'known_hosts', 'key.pub', 'authorized_keys']) writeFileSync(join(base, '.ssh', name), 'fixture');
  const command = `for key in github deploy_key nested/id_ed25519; do cat '${base}/.ssh/'"$key" >/dev/null 2>&1 && exit 10; done; for public in config known_hosts key.pub authorized_keys; do [ "$(cat '${base}/.ssh/'"$public")" = fixture ] || exit 11; done; echo done`;
  const previous = process.env.HOME; process.env.HOME = base;
  let wrapped;
  try { wrapped = isolatedCommand(command, join(base, 'hexbot')); } finally { process.env.HOME = previous; }
  const result = spawnSync('/bin/bash', ['-c', wrapped], {env:{...process.env, HOME:base}, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done\n');
});

test('walk skips heavy trees while policy still covers their names', {skip:process.platform !== 'darwin'}, t => {
  const home=mkdtempSync(join(tmpdir(),'hexbot-walk-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  mkdirSync(join(home,'python/deep'),{recursive:true});
  writeFileSync(join(home,'python/deep/auth.json'),'secret');
  const command=isolatedCommand('true',home);
  assert.doesNotMatch(command,/subpath[^)]*python\/deep\/auth/);
  assert.doesNotMatch(command,/regex #/);
});

test('an unusable bubblewrap is probed once and commands fall back to approval guards', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync, readFileSync} = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const counter=join(home,'count');
  const executable=join(home,'bwrap');
  writeFileSync(executable, `#!/bin/sh\necho probe >> '${counter}'\nexit 1\n`); chmodSync(executable,0o755);
  const moduleUrl=new URL('./isolation.ts',import.meta.url).href;
  // A guest session's command never runs bare: it is refused instead.
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand,isolationAvailable,probeIsolation}=await import(${JSON.stringify(moduleUrl)}); probeIsolation(); console.log(isolatedCommand('echo first',${JSON.stringify(home)})); console.log(isolatedCommand('echo second',${JSON.stringify(home)})); console.log(isolationAvailable()); try { console.log(isolatedCommand('echo third',${JSON.stringify(home)},[],undefined,'one')); } catch (error) { console.log(error.message); }`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:home},encoding:'utf8'});
  assert.equal(output,"echo first\necho second\nfalse\nHexbot has no OS sandbox on this system, so a shared bot cannot run commands or code in someone else's room. Install bubblewrap and restart the daemon.\n");
  assert.equal(readFileSync(counter,'utf8'),'probe\n');
});

test('bubblewrap binds the home read-only and only reopens the requested output directories', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync, realpathSync} = await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'hexbot-bwrap-bind-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const workspace=join(home,'workspace'), outputs=join(home,'profiles/owl/artifacts');
  for (const dir of [workspace,outputs,join(home,'desktop-data')]) mkdirSync(dir,{recursive:true});
  for (const name of ['connect-identity.key', 'profiles/owl/connect-identity.key']) writeFileSync(join(home,name),'secret');
  const executable=join(home,'bwrap'); writeFileSync(executable,'#!/bin/sh\ncase "$*" in *"/usr/bin/env true") exit 0;; *) exit 1;; esac\n'); chmodSync(executable,0o755);
  const user=join(home,'user'); mkdirSync(join(user,'.ssh/nested'),{recursive:true});
  const policy = JSON.parse(readFileSync(new URL('./credential-policy.json', import.meta.url), 'utf8'));
  for (const local of policy.write.deny) { const file = join(user, local); mkdirSync(join(file, '..'), {recursive:true}); writeFileSync(file, 'keep'); }
  for (const file of ['known_hosts','config','id_ed25519.pub','nested/id_ed25519','github','deploy_key','authorized_keys']) writeFileSync(join(user,'.ssh',file),'fixture');
  const moduleUrl=new URL('./isolation.ts',import.meta.url).href;
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand}=await import(${JSON.stringify(moduleUrl)}); console.log(isolatedCommand('true',${JSON.stringify(home)},[${JSON.stringify(outputs)}]));`;
  const command=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,HOME:user,PATH:home},encoding:'utf8'});
  assert.ok(command.includes(`'--ro-bind' '${home}' '${home}'`));
  for (const name of ['connect-identity.key', 'profiles/owl/connect-identity.key']) assert.ok(command.includes(`'--ro-bind' '/dev/null' '${join(home,name)}'`), name);
  for (const local of policy.write.deny) assert.ok(command.includes(`'--ro-bind' '${join(user,local)}' '${join(user,local)}'`), local);
  assert.ok(command.includes(`'--bind' '${realpathSync(outputs)}' '${realpathSync(outputs)}'`));
  assert.ok(!command.includes(`'--bind' '${realpathSync(workspace)}'`), 'an in-home workspace is never bound writable');
  assert.ok(command.includes(`'--tmpfs' '${join(home,'desktop-data')}' '--remount-ro'`));
  assert.doesNotMatch(command,/'--tmpfs' '[^']*\/\.ssh'/);
  assert.ok(command.includes(`'--tmpfs' '${join(user,'.ssh/nested')}'`));
  for (const file of ['github','deploy_key']) assert.ok(command.includes(`'--ro-bind' '/dev/null' '${join(user,'.ssh',file)}'`));
  assert.doesNotMatch(command,/known_hosts|id_ed25519\.pub|\.ssh\/config|authorized_keys/);
});

test('fake user home protects uncommon SSH keys and explicit auth files', async t => {
  const {execFileSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-ssh-policy-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const script = `const {credentialPath}=await import(${JSON.stringify(new URL('./extension.ts',import.meta.url).href)}); const {isolatedCommand}=await import(${JSON.stringify(new URL('./isolation.ts',import.meta.url).href)}); const home=process.env.HOME; for(const file of ['github','deploy_key','nested/config']) if(!credentialPath(home+'/.ssh/'+file,home+'/hexbot')) throw Error(file); for(const file of ['config','known_hosts.old','id.pub','authorized_keys']) if(credentialPath(home+'/.ssh/'+file,home+'/hexbot')) throw Error(file); for(const file of ['.codex/auth.json','.hermes/auth.json','.hermes/.env']) if(!credentialPath(home+'/'+file,home+'/hexbot')) throw Error(file); console.log(isolatedCommand('true',home));`;
  const result = execFileSync(process.execPath, ['--input-type=module','-e',script], {env:{...process.env,HOME:base},encoding:'utf8'});
  if (process.platform === 'darwin') for (const binary of ['/usr/bin/open','/bin/launchctl','/usr/bin/osascript']) assert.ok(result.includes(`(literal "${binary}")`));
});

test('macOS sandbox denies process brokers', {skip:process.platform !== 'darwin'}, async t => {
  const {spawnSync} = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'hexbot-brokers-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  // An invalid option prevents opening Calculator even if exec is accidentally allowed.
  const label = `hexbot.test.${process.pid}`;
  t.after(() => spawnSync('/bin/launchctl', ['remove',label]));
  for (const command of ['open -a Calculator --hexbot-test-invalid-option', `launchctl submit -l ${label} -- /usr/bin/true`, 'osascript -e "return 0"']) {
    const result = spawnSync('/bin/bash',['-c',isolatedCommand(command,home)],{encoding:'utf8'});
    assert.match(result.stderr, /Operation not permitted/);
    assert.doesNotMatch(result.stderr, /sandbox_(init|apply)/,'sandbox itself must start');
  }
});

test('macOS sandbox denies fake HOME SSH keys while allowing public SSH files', {skip:process.platform !== 'darwin'}, async t => {
  const {execFileSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-ssh-exec-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  mkdirSync(join(base,'.ssh'));
  for (const name of ['github','deploy_key','config','known_hosts','key.pub','authorized_keys']) writeFileSync(join(base,'.ssh',name),'fixture');
  const command = `for key in github deploy_key; do cat '${base}/.ssh/'"$key" >/dev/null 2>&1 && exit 10; done; for public in config known_hosts key.pub authorized_keys; do cat '${base}/.ssh/'"$public" >/dev/null || exit 11; done`;
  const script = `const {isolatedCommand}=await import(${JSON.stringify(new URL('./isolation.ts',import.meta.url).href)}); const {spawnSync}=await import('node:child_process'); const r=spawnSync('/bin/bash',['-c',isolatedCommand(${JSON.stringify(command)},process.env.HOME)],{encoding:'utf8'}); if(r.status!==0) throw Error(r.stderr+'status '+r.status);`;
  execFileSync(process.execPath, ['--input-type=module','-e',script], {env:{...process.env,HOME:base},encoding:'utf8'});
});

test('sandbox case policy covers uppercase secrets and permits uppercase public keys', {skip: process.platform !== 'darwin'}, async t => {
  const {execFileSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-case-sandbox-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home');
  mkdirSync(join(home, 'profiles/owl'), {recursive:true});
  mkdirSync(join(base, '.ssh'));
  writeFileSync(join(home, 'profiles/owl/AUTH.JSON'), 'private');
  writeFileSync(join(base, '.ssh/ID_ED25519.PUB'), 'public');
  const script = `const {sandboxProfile, isolatedCommand}=await import(${JSON.stringify(new URL('./isolation.ts', import.meta.url).href)}); const {spawnSync}=await import('node:child_process'); const profile=sandboxProfile(${JSON.stringify(home)}); if(!profile.includes('/profiles/owl/AUTH.JSON')) throw Error('uppercase secret not enumerated'); const command=${JSON.stringify(`cat '${home}/profiles/owl/AUTH.JSON' >/dev/null 2>&1 && exit 10; cat '${base}/.ssh/ID_ED25519.PUB' || exit 11`)}; const result=spawnSync('/bin/bash',['-c',isolatedCommand(command,${JSON.stringify(home)})],{encoding:'utf8'}); if(result.status!==0) throw Error(result.stderr+'status '+result.status); process.stdout.write(result.stdout);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module','-e',script], {env:{...process.env,HOME:base},encoding:'utf8'}), 'public');
});

// Codex's workspace sandbox: no network, writes only inside the workspace, and
// shell profiles stay read-only even when the workspace holds them.
test('the workspace sandbox confines writes and blocks the network', {skip:process.platform !== 'darwin'}, async t => {
  const {execFileSync} = await import('node:child_process');
  const {realpathSync} = await import('node:fs');
  const {createServer} = await import('node:net');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-confine-')));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const user = join(base, 'user'), home = join(base, 'home'), other = join(base, 'other');
  for (const dir of [user, home, other]) mkdirSync(dir);
  const server = createServer(socket => socket.end()).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve)); t.after(() => server.close());
  const run = (script, workspace) => {
    const code = `const {isolatedCommand} = await import(${JSON.stringify(new URL('./isolation.ts', import.meta.url).href)}); const {spawnSync} = await import('node:child_process'); const child = spawnSync('/bin/bash', ['-c', isolatedCommand(${JSON.stringify(script)}, ${JSON.stringify(home)}, [], ${JSON.stringify(workspace)})], {encoding:'utf8'}); process.stdout.write(child.stdout); process.exit(child.status);`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {env:{...process.env, HOME:user}, encoding:'utf8'});
  };
  const port = server.address().port;
  // A host Unix socket (a user service manager, Docker) would start programs outside the sandbox.
  const socket = join(base, 's.sock');
  const unix = createServer(c => c.end()).listen(socket);
  await new Promise(resolve => unix.on('listening', resolve)); t.after(() => unix.close());
  assert.equal(run(`python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.connect('${socket}')" 2>/dev/null && exit 14; echo done`, [user]), 'done\n');
  // Credential stores are unreadable inside the workspace sandbox, readable after full access.
  mkdirSync(join(user, '.aws')); writeFileSync(join(user, '.aws/credentials'), 'aws-secret');
  assert.equal(run(`cat '${user}/.aws/credentials' 2>/dev/null && exit 19; echo done`, [user]), 'done\n');
  assert.equal(run(`cat '${user}/.aws/credentials'`, undefined), 'aws-secret');
  // Process creation is capped, so a fork bomb stops; a full-access command keeps your own limit.
  const limit = workspace => {const value = run('ulimit -u', workspace).trim(); return value === 'unlimited' ? Infinity : Number(value);};
  const capped = limit([user]), own = limit(undefined);
  assert.ok(capped > 512 && capped < own, `${capped} ${own}`);
  // No signals leave the sandbox (kill -9 -1 would reach every process you own), and only a few device files take writes.
  assert.equal(run(`kill -0 ${process.pid} 2>/dev/null && exit 15; sleep 5 & kill $! || exit 16; (echo x > /dev/random) 2>/dev/null && exit 17; echo x > /dev/null || exit 18; echo done`, [user]), 'done\n');
  assert.equal(run(`echo ok > '${user}/notes.txt' || exit 10; (echo x > '${other}/x') 2>/dev/null && exit 11; (echo x > '${user}/.zshrc') 2>/dev/null && exit 12; (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && exit 13; echo done`, [user]), 'done\n');
  // Manual's workspace is empty: nothing is writable.
  assert.equal(run(`(echo x > '${user}/notes.txt') 2>/dev/null && exit 10; cat '${user}/notes.txt'`, []), 'ok\n');
  // Without a workspace only the base layer applies, as for an approved full_access command.
  assert.equal(run(`echo x > '${other}/x' && (exec 3<>/dev/tcp/127.0.0.1/${port}) && echo done`, undefined), 'done\n');
});

test('macOS Auto and Manual refuse network listeners; approved full access permits them', {skip:process.platform !== 'darwin'}, async t => {
  const {spawnSync} = await import('node:child_process');
  const {sandboxProfile} = await import('./isolation.ts');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-inbound-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'); mkdirSync(home);
  for (const address of ['127.0.0.1', '0.0.0.0', '::1', '::']) {
    for (const type of ['SOCK_STREAM', 'SOCK_DGRAM']) {
      const script = `import socket\ns = socket.socket(socket.${address.includes(':') ? 'AF_INET6' : 'AF_INET'}, socket.${type})\ntry:\n s.bind((${JSON.stringify(address)}, 0))\n${type === 'SOCK_STREAM' ? ' s.listen(1)\n' : ''}except PermissionError:\n print('blocked')\nelse:\n print('allowed')`;
      for (const workspace of [[base], [], undefined]) {
        const result = spawnSync('/usr/bin/sandbox-exec', ['-p', sandboxProfile(home, [], workspace), '/usr/bin/python3', '-c', script], {encoding:'utf8', timeout:10000});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, workspace === undefined ? 'allowed\n' : 'blocked\n', `${address} ${type} ${JSON.stringify(workspace)}`);
      }
    }
  }
});

test('bubblewrap confines a workspace command to its folders without a network', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync, realpathSync} = await import('node:fs');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-bwrap-confine-')));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const user = join(home, 'user'), workspace = join(home, 'work');
  for (const dir of [user, workspace]) mkdirSync(dir, {recursive:true});
  writeFileSync(join(user, '.zshrc'), 'keep');
  const executable = join(home, 'bwrap'); writeFileSync(executable, '#!/bin/sh\ncase "$*" in *"/usr/bin/env true") exit 0;; *) exit 1;; esac\n'); chmodSync(executable, 0o755);
  const moduleUrl = new URL('./isolation.ts', import.meta.url).href;
  const outputs = join(home, 'hexbot/profiles/owl/artifacts'); mkdirSync(outputs, {recursive:true});
  const command = workspace => execFileSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand}=await import(${JSON.stringify(moduleUrl)}); console.log(isolatedCommand('true',${JSON.stringify(join(home, 'hexbot'))},[${JSON.stringify(outputs)}],${JSON.stringify(workspace)}));`], {env:{...process.env, HOME:user, PATH:home}, encoding:'utf8'});
  const confined = command([workspace]);
  assert.ok(confined.includes(`'--new-session' '--unshare-pid' '--unshare-net' '--ro-bind' '/' '/' '--dev' '/dev' '--proc' '/proc' '--tmpfs' '/run' '--tmpfs' '/tmp'`));
  // Host sockets under /tmp (X11, agents) stay hidden even though /tmp is part of every workspace.
  assert.ok(!command([workspace, '/tmp']).includes(`'--bind' '/tmp' '/tmp'`));
  // Output folders open only when the workspace holds them: Manual's is empty.
  assert.ok(!confined.includes(`'--bind' '${outputs}'`));
  assert.ok(command([workspace, outputs]).includes(`'--bind' '${outputs}' '${outputs}'`));
  assert.ok(command(undefined).includes(`'--bind' '${outputs}' '${outputs}'`));
  assert.ok(confined.includes(`'--bind' '${workspace}' '${workspace}'`));
  assert.ok(confined.includes(`'--ro-bind' '${join(user, '.zshrc')}' '${join(user, '.zshrc')}'`));
  assert.ok(!command([]).includes(`'--bind' '${workspace}'`));
  const base = command(undefined);
  assert.ok(base.includes(`'--bind' '/' '/'`)); assert.ok(!base.includes('--unshare-net'));
});

// A shared bot in someone else's room is a guest there: the sandbox hides every
// bot's memory and notes folder and every About you from the programs a command
// starts, in the base layer too, as the file tools refuse them. The owner's own
// sessions read them as before.
function ownerFiles(home) {
  mkdirSync(join(home, 'profiles/owl/memories/notes'), {recursive:true});
  mkdirSync(join(home, 'users/alice'), {recursive:true});
  mkdirSync(join(home, 'runtime/sessions/one/attachments'), {recursive:true});
  mkdirSync(join(home, 'runtime/sessions/two'), {recursive:true});
  writeFileSync(join(home, 'profiles/owl/memories/MEMORY.md'), 'memory');
  writeFileSync(join(home, 'profiles/owl/memories/notes/2026-10-07.md'), 'note');
  writeFileSync(join(home, 'users/alice/user.md'), 'about');
  writeFileSync(join(home, 'profiles/owl/SOUL.md'), 'soul');
  writeFileSync(join(home, 'runtime/sessions/one/attachments/upload.txt'), 'upload');
  writeFileSync(join(home, 'runtime/sessions/two/conversation.jsonl'), 'history');
}
// The guest's own section is "one"; "two" is another section of the owner's.
const guestReads = home => `cat '${home}/profiles/owl/memories/MEMORY.md' 2>/dev/null && exit 10; cat '${home}/profiles/owl/memories/notes/2026-10-07.md' 2>/dev/null && exit 11; [ -z "$(ls '${home}/profiles/owl/memories' 2>/dev/null)" ] || exit 12; cat '${home}/users/alice/user.md' 2>/dev/null && exit 13; [ "$(cat '${home}/profiles/owl/SOUL.md')" = soul ] || exit 14; cat '${home}/runtime/sessions/two/conversation.jsonl' 2>/dev/null && exit 15; [ -z "$(ls '${home}/runtime/sessions' 2>/dev/null | grep -v '^one$')" ] || exit 16; [ "$(cat '${home}/runtime/sessions/one/attachments/upload.txt')" = upload ] || exit 17; echo done`;
const ownerReads = home => `[ "$(cat '${home}/profiles/owl/memories/MEMORY.md')" = memory ] || exit 10; [ "$(cat '${home}/profiles/owl/memories/notes/2026-10-07.md')" = note ] || exit 11; [ "$(ls '${home}/profiles/owl/memories')" = "$(printf 'MEMORY.md\\nnotes')" ] || exit 12; [ "$(cat '${home}/users/alice/user.md')" = about ] || exit 13; [ "$(cat '${home}/runtime/sessions/two/conversation.jsonl')" = history ] || exit 15; echo done`;
// With its attachments folder among the outputs, the guest writes there.
const guestWrites = home => `echo ok > '${home}/runtime/sessions/one/attachments/result' || exit 20; echo ok > '${home}/runtime/sessions/two/result' 2>/dev/null && exit 21; echo done`;

test('macOS hides the owner\'s memory, notes and About you from a guest session\'s commands', {skip: process.platform !== 'darwin'}, async t => {
  const {spawnSync} = await import('node:child_process');
  const {sandboxProfile} = await import('./isolation.ts');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-guest-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'); ownerFiles(home);
  const attachments = join(home, 'runtime/sessions/one/attachments');
  const run = (script, workspace, guest, outputs = []) => spawnSync('/bin/bash', ['-c', isolatedCommand(script, home, outputs, workspace, guest)], {encoding:'utf8'});
  for (const workspace of [[base], [], undefined]) {
    const guest = run(guestReads(home), workspace, 'one');
    assert.equal(guest.stdout, 'done\n', `guest ${JSON.stringify(workspace)}: ${guest.status} ${guest.stderr}`);
    const owner = run(ownerReads(home), workspace, undefined);
    assert.equal(owner.stdout, 'done\n', `owner ${JSON.stringify(workspace)}: ${owner.status} ${owner.stderr}`);
  }
  const writes = run(guestWrites(home), [base, attachments], 'one', [attachments]);
  assert.equal(writes.stdout, 'done\n', `${writes.status} ${writes.stderr}`);
  // The rules are patterns, so a note, About you or section written after the
  // profile was built is covered too; the guest's section alone adds them.
  const profile = sandboxProfile(home, [], [base], 'one');
  assert.match(profile, /\(deny file-read\* \(regex "[^"]*\/\[pP\]\[rR\]\[oO\]\[fF\]\[iI\]\[lL\]\[eE\]\[sS\]\/\[\^\/\]\+\/\[mM\]\[eE\]\[mM\]\[oO\]\[rR\]\[iI\]\[eE\]\[sS\]\(\/\.\*\)\?\$"\)/);
  // The sessions rule names the real folder (the temp folder is a link), which
  // the sandbox matches after resolving the path.
  assert.ok(profile.includes(`(require-all (subpath ${JSON.stringify(join(realpathSync(home), 'runtime/sessions'))}) (require-not (subpath ${JSON.stringify(join(realpathSync(home), 'runtime/sessions/one'))})))`), profile);
  assert.doesNotMatch(sandboxProfile(home, [], [base]), /memories|user\\\.md|runtime\/sessions/);
  mkdirSync(join(home, 'users/bob'), {recursive:true}); writeFileSync(join(home, 'users/bob/user.md'), 'later');
  writeFileSync(join(home, 'profiles/owl/memories/notes/2026-10-08.md'), 'later');
  mkdirSync(join(home, 'runtime/sessions/three'), {recursive:true}); writeFileSync(join(home, 'runtime/sessions/three/conversation.jsonl'), 'later');
  const late = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', `cat '${home}/users/bob/user.md' 2>/dev/null && exit 10; cat '${home}/profiles/owl/memories/notes/2026-10-08.md' 2>/dev/null && exit 11; cat '${home}/runtime/sessions/three/conversation.jsonl' 2>/dev/null && exit 12; echo done`], {encoding:'utf8'});
  assert.equal(late.stdout, 'done\n', `${late.status} ${late.stderr}`);
});

test('bubblewrap masks the users folder and every memory folder only for a guest session', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync, existsSync} = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-guest-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'); ownerFiles(home);
  // A bot without a memory folder yet: bubblewrap cannot mask a path that does
  // not exist, so the guest layout creates it, and the mask holds for a note
  // written after the command (or a code run's worker) started. A profile
  // that is a link is masked by both paths.
  mkdirSync(join(home, 'profiles/newt'), {recursive:true});
  const linked = join(realpathSync(base), 'linked'); mkdirSync(linked); symlinkSync(linked, join(home, 'profiles/lynx'));
  const sessions = join(home, 'runtime/sessions'), attachments = join(sessions, 'one/attachments'), realSessions = join(realpathSync(home), 'runtime/sessions');
  const executable = join(base, 'bwrap'); writeFileSync(executable, '#!/bin/sh\ncase "$*" in *"/usr/bin/env true") exit 0;; *) exit 1;; esac\n'); chmodSync(executable, 0o755);
  const moduleUrl = new URL('./isolation.ts', import.meta.url).href;
  const command = (workspace, guest, outputs = [], at = home) => execFileSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand}=await import(${JSON.stringify(moduleUrl)}); console.log(isolatedCommand('true',${JSON.stringify(at)},${JSON.stringify(outputs)},${JSON.stringify(workspace)},${JSON.stringify(guest)}));`], {env:{...process.env, PATH:base}, encoding:'utf8'});
  for (const workspace of [[base], undefined]) {
    assert.doesNotMatch(command(workspace, undefined), /memories|users|sessions/);
    assert.ok(!existsSync(join(home, 'profiles/newt/memories')));
    const guest = command(workspace, 'one');
    for (const folder of [join(home, 'profiles/owl/memories'), join(home, 'profiles/newt/memories'), join(home, 'profiles/lynx/memories'), join(linked, 'memories'), join(home, 'users')]) assert.ok(guest.includes(`'--tmpfs' '${folder}' '--remount-ro' '${folder}'`), guest);
    assert.doesNotMatch(guest, /user\.md|SOUL|notes\/2026|conversation/);
    assert.ok(existsSync(join(home, 'profiles/newt/memories')));
    // The sessions folder is masked by real path (the temp folder is a link
    // on macOS), then the own section comes back inside it before the mask is
    // made read-only; the owner's section never appears.
    const masked = guest.indexOf(`'--tmpfs' '${realSessions}'`), own = guest.indexOf(`'--ro-bind' '${join(realSessions, 'one')}' '${join(realSessions, 'one')}'`), sealed = guest.indexOf(`'--remount-ro' '${realSessions}'`);
    assert.ok(masked > 0 && own > masked && sealed > own, guest);
    assert.ok(!guest.includes(`'${join(sessions, 'two')}'`) && !guest.includes(`'${join(realSessions, 'two')}'`), guest);
    rmSync(join(home, 'profiles/newt/memories'), {recursive:true});
  }
  // The own attachments folder, an output, is bound back writable after the
  // mask (output folders are canonical, as the mask is).
  const writable = command([base, attachments], 'one', [attachments]);
  const real = realpathSync(attachments);
  assert.ok(writable.lastIndexOf(`'--bind' '${real}' '${real}'`) > writable.indexOf(`'--tmpfs' '${realSessions}'`), writable);
  assert.ok(writable.lastIndexOf(`'--bind' '${real}' '${real}'`) < writable.indexOf(`'--remount-ro' '${realSessions}'`), writable);
  // A home named through a link: its lexical and canonical sessions folder are
  // one, masked once by real path, so the own section and its uploads bound
  // back under the mask are not hidden by a second one.
  const link = join(base, 'link-home'); symlinkSync(home, link);
  const linkAttachments = join(link, 'runtime/sessions/one/attachments');
  const viaLink = command([base, linkAttachments], 'one', [linkAttachments], link);
  assert.equal(viaLink.split(`'--tmpfs' '${realSessions}'`).length, 2, viaLink);
  assert.ok(!viaLink.includes(`'${join(link, 'runtime/sessions')}'`), viaLink);
  const linkMasked = viaLink.indexOf(`'--tmpfs' '${realSessions}'`), linkOwn = viaLink.indexOf(`'--ro-bind' '${join(realSessions, 'one')}' '${join(realSessions, 'one')}'`), linkRebound = viaLink.lastIndexOf(`'--bind' '${real}' '${real}'`);
  assert.ok(linkMasked > 0 && linkOwn > linkMasked && linkRebound > linkOwn && viaLink.indexOf(`'--remount-ro' '${realSessions}'`) > linkRebound, viaLink);
  // A home with no users or sessions folder yet gets them, masked.
  rmSync(join(home, 'users'), {recursive:true}); rmSync(sessions, {recursive:true});
  const fresh = command(undefined, 'one');
  assert.ok(fresh.includes(`'--tmpfs' '${join(home, 'users')}'`)); assert.ok(fresh.includes(`'--tmpfs' '${realSessions}'`));
  assert.ok(!fresh.includes(`'--ro-bind' '${join(realSessions, 'one')}'`), 'an own folder that does not exist is not bound');
  assert.ok(existsSync(join(home, 'users')) && existsSync(sessions));
});

test('bubblewrap hides the owner\'s memory, notes and About you from a guest session\'s commands', needsBubblewrap, async t => {
  const {spawnSync} = await import('node:child_process');
  const base = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-guest-run-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'); ownerFiles(home);
  const attachments = join(home, 'runtime/sessions/one/attachments');
  for (const workspace of [[base], [], undefined]) {
    const guest = spawnSync('/bin/bash', ['-c', isolatedCommand(guestReads(home), home, [], workspace, 'one')], {encoding:'utf8'});
    assert.equal(guest.stdout, 'done\n', `guest ${JSON.stringify(workspace)}: ${guest.status} ${guest.stderr}`);
    const owner = spawnSync('/bin/bash', ['-c', isolatedCommand(ownerReads(home), home, [], workspace, undefined)], {encoding:'utf8'});
    assert.equal(owner.stdout, 'done\n', `owner ${JSON.stringify(workspace)}: ${owner.status} ${owner.stderr}`);
  }
  const writes = spawnSync('/bin/bash', ['-c', isolatedCommand(guestWrites(home), home, [attachments], [base, attachments], 'one')], {encoding:'utf8'});
  assert.equal(writes.stdout, 'done\n', `${writes.status} ${writes.stderr}`);
  assert.equal(readFileSync(join(attachments, 'result'), 'utf8'), 'ok\n');
  // An About you, a note and a section that appear after the sandbox was built
  // are under the masks too: the users folder, the new bot's memory folder and
  // the sessions folder were created and masked up front.
  rmSync(join(home, 'users'), {recursive:true}); mkdirSync(join(home, 'profiles/newt'), {recursive:true});
  const late = `cat '${home}/users/bob/user.md' 2>/dev/null && exit 10; cat '${home}/profiles/newt/memories/MEMORY.md' 2>/dev/null && exit 11; [ -z "$(ls -A '${home}/users' 2>/dev/null)" ] || exit 12; [ -z "$(ls -A '${home}/profiles/newt/memories' 2>/dev/null)" ] || exit 12; cat '${home}/runtime/sessions/three/conversation.jsonl' 2>/dev/null && exit 13; echo done`;
  for (const workspace of [[base], undefined]) {
    const built = isolatedCommand(late, home, [], workspace, 'one');
    mkdirSync(join(home, 'users/bob'), {recursive:true}); writeFileSync(join(home, 'users/bob/user.md'), 'later');
    writeFileSync(join(home, 'profiles/newt/memories/MEMORY.md'), 'later');
    mkdirSync(join(home, 'runtime/sessions/three'), {recursive:true}); writeFileSync(join(home, 'runtime/sessions/three/conversation.jsonl'), 'later');
    const guest = spawnSync('/bin/bash', ['-c', built], {encoding:'utf8'});
    assert.equal(guest.stdout, 'done\n', `late ${JSON.stringify(workspace)}: ${guest.status} ${guest.stderr}`);
    rmSync(join(home, 'users'), {recursive:true}); rmSync(join(home, 'profiles/newt/memories'), {recursive:true}); rmSync(join(home, 'runtime/sessions/three'), {recursive:true});
  }
});
