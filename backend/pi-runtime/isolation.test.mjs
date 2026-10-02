import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
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
  const script = `echo ready; read -r go; cat '${home}/profiles/owl/.env' >/dev/null 2>&1 && exit 10; cat '${home}/profiles/owl/auth.json' >/dev/null 2>&1 && exit 13; cat '${base}/auth.json' || exit 11; cat '${base}/.env' || exit 14; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml workspace/result; do (echo bad > '${home}'/"$p") 2>/dev/null && exit 12; done; echo ok > '${home}/profiles/owl/artifacts/result'; echo ok > '${home}/runtime/sessions/one/attachments/result'; echo ok > '${base}/normal-workspace'; echo done`;
  // The cwd is the in-home workspace; it stays read-only like the rest of the home.
  const child = spawn('/bin/bash', ['-c',isolatedCommand(script,home,[join(home,'profiles/owl/artifacts'),join(home,'runtime/sessions/one/attachments')])], {cwd:work, stdio:['pipe','pipe','pipe']});
  t.after(() => {if(child.exitCode === null) child.kill();});
  let stderr=''; child.stderr.on('data',c=>stderr+=c);
  const exited = new Promise(resolve => child.on('close',resolve));
  const lines = createInterface({input:child.stdout});
  for await (const line of lines) {
    if (line === 'ready') {writeFileSync(join(home,'profiles/owl/.env'),'secret'); writeFileSync(join(home,'profiles/owl/auth.json'),'secret'); child.stdin.end('go\n');}
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
  for (const file of ['profiles/owl/.env', 'profiles/owl/auth.json', 'desktop-data/token']) writeFileSync(join(home, file), 'secret');
  writeFileSync(join(base,'auth.json'),'outside');
  writeFileSync(join(base,'.env'),'outside');
  const script = `cat '${home}/profiles/owl/.env' >/dev/null 2>&1 && exit 10; cat '${home}/profiles/owl/auth.json' >/dev/null 2>&1 && exit 13; [ -z "$(ls -A '${home}/desktop-data')" ] || exit 15; cat '${base}/auth.json' || exit 11; cat '${base}/.env' || exit 14; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml workspace/result; do (echo bad > '${home}'/"$p") 2>/dev/null && exit 12; done; echo ok > '${home}/profiles/owl/artifacts/result' || exit 16; echo ok > '${home}/runtime/sessions/one/attachments/result' || exit 17; echo ok > '${base}/normal-workspace' || exit 18; echo done`;
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
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand,isolationAvailable,probeIsolation}=await import(${JSON.stringify(moduleUrl)}); probeIsolation(); console.log(isolatedCommand('echo first',${JSON.stringify(home)})); console.log(isolatedCommand('echo second',${JSON.stringify(home)})); console.log(isolationAvailable());`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:home},encoding:'utf8'});
  assert.equal(output,'echo first\necho second\nfalse\n');
  assert.equal(readFileSync(counter,'utf8'),'probe\n');
});

test('bubblewrap binds the home read-only and only reopens the requested output directories', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync, realpathSync} = await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'hexbot-bwrap-bind-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const workspace=join(home,'workspace'), outputs=join(home,'profiles/owl/artifacts');
  for (const dir of [workspace,outputs,join(home,'desktop-data')]) mkdirSync(dir,{recursive:true});
  const executable=join(home,'bwrap'); writeFileSync(executable,'#!/bin/sh\ncase "$*" in *"/usr/bin/env true") exit 0;; *) exit 1;; esac\n'); chmodSync(executable,0o755);
  const user=join(home,'user'); mkdirSync(join(user,'.ssh/nested'),{recursive:true});
  const policy = JSON.parse(readFileSync(new URL('./credential-policy.json', import.meta.url), 'utf8'));
  for (const local of policy.write.deny) { const file = join(user, local); mkdirSync(join(file, '..'), {recursive:true}); writeFileSync(file, 'keep'); }
  for (const file of ['known_hosts','config','id_ed25519.pub','nested/id_ed25519','github','deploy_key','authorized_keys']) writeFileSync(join(user,'.ssh',file),'fixture');
  const moduleUrl=new URL('./isolation.ts',import.meta.url).href;
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand}=await import(${JSON.stringify(moduleUrl)}); console.log(isolatedCommand('true',${JSON.stringify(home)},[${JSON.stringify(outputs)}]));`;
  const command=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,HOME:user,PATH:home},encoding:'utf8'});
  assert.ok(command.includes(`'--ro-bind' '${home}' '${home}'`));
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
