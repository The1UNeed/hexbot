import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import {isolatedCommand} from './isolation.ts';

test('sandbox protects newly created secrets and home writes but permits workspace and unrelated files', {skip:process.platform !== 'darwin'}, async t => {
  const base = mkdtempSync(join(tmpdir(), 'hexbot-isolation-'));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const home = join(base, 'home'), work = join(home, 'workspace');
  for (const dir of [work, join(home,'profiles/owl'), join(home,'bin'), join(home,'hooks'), join(home,'skills'), join(home,'profiles/owl/artifacts'), join(home,'runtime/sessions/one/attachments')]) mkdirSync(dir,{recursive:true});
  writeFileSync(join(base,'auth.json'),'outside');
  writeFileSync(join(base,'.env'),'outside');
  const script = `echo ready; read -r go; cat '${home}/profiles/owl/.env' >/dev/null 2>&1 && exit 10; cat '${home}/profiles/owl/auth.json' >/dev/null 2>&1 && exit 13; cat '${base}/auth.json' || exit 11; cat '${base}/.env' || exit 14; for p in config.yaml bin/script hooks/script skills/script profiles/owl/config.yaml; do (echo bad > '${home}'/"$p") 2>/dev/null && exit 12; done; echo ok > '${work}/result'; echo ok > '${home}/profiles/owl/artifacts/result'; echo ok > '${home}/runtime/sessions/one/attachments/result'; echo ok > '${base}/normal-workspace'; echo done`;
  const child = spawn('/bin/bash', ['-c',isolatedCommand(script,home,work,[join(home,'profiles/owl/artifacts'),join(home,'runtime/sessions/one/attachments')])], {stdio:['pipe','pipe','pipe']});
  t.after(() => {if(child.exitCode === null) child.kill();});
  let stderr=''; child.stderr.on('data',c=>stderr+=c);
  const exited = new Promise(resolve => child.on('close',resolve));
  const lines = createInterface({input:child.stdout});
  for await (const line of lines) {
    if (line === 'ready') {writeFileSync(join(home,'profiles/owl/.env'),'secret'); writeFileSync(join(home,'profiles/owl/auth.json'),'secret'); child.stdin.end('go\n');}
  }
  assert.equal(await exited,0,stderr);
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
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand,probeIsolation}=await import(${JSON.stringify(moduleUrl)}); probeIsolation(); console.log(isolatedCommand('echo first',${JSON.stringify(home)})); console.log(isolatedCommand('echo second',${JSON.stringify(home)}));`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:home},encoding:'utf8'});
  assert.equal(output,'echo first\necho second\n');
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
  for (const file of ['known_hosts','config','id_ed25519.pub','nested/id_ed25519','github','deploy_key','authorized_keys']) writeFileSync(join(user,'.ssh',file),'fixture');
  const moduleUrl=new URL('./isolation.ts',import.meta.url).href;
  const script=`Object.defineProperty(process,'platform',{value:'linux'}); const {isolatedCommand}=await import(${JSON.stringify(moduleUrl)}); console.log(isolatedCommand('true',${JSON.stringify(home)},${JSON.stringify(workspace)},[${JSON.stringify(outputs)}]));`;
  const command=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,HOME:user,PATH:home},encoding:'utf8'});
  assert.ok(command.includes(`'--ro-bind' '${home}' '${home}'`));
  for (const path of [workspace,outputs]) assert.ok(command.includes(`'--bind' '${realpathSync(path)}' '${realpathSync(path)}'`));
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
