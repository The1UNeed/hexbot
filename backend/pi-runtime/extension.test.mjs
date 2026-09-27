import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import hexbot, {canonicalPath, credentialPath, protectedPath, shellEnvironment, hardlineCommand, dangerousCommand} from './extension.ts';

function fixture(t, mode = 'manual', enabledToolsets = []) {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-gates-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const config = {home, cwd:home, prompt:'Frozen prompt', tools:[], readOnlyTools:[], enabledToolsets, provider:'test', model:'primary'};
  const path = join(home, 'config.json'); writeFileSync(path, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = path;
  const handlers = {}, tools = {}, requests = [], choices = [], models = [];
  const settings = {...config, approvalMode:mode, allowedPatterns:[]};
  const ctx = {model:{provider:'test',id:'primary'}, modelRegistry:{find:(provider,id)=>({provider,id})}, ui:{
    async input(title) {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); requests.push(request);
      if (request.name === 'hexbot_session_settings') return JSON.stringify({result:settings});
      if (request.name === 'hexbot_auto_approve') {if (ctx.autoError) throw Error('timeout'); return JSON.stringify({result:{approved:ctx.approved ?? false}});}
      return JSON.stringify({result:{}});
    },
    async select(title) {choices.push(JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length))); return ctx.choice ?? 'deny';}
  }};
  const pi = {on:(name,handler)=>handlers[name]=handler, registerTool:tool=>tools[tool.name]=tool, registerProvider(){}, async setModel(model){models.push(model);ctx.model=model;return true;}, sendMessage(){}, getThinkingLevel(){}};
  hexbot(pi);
  return {home, handlers, tools, settings, ctx, requests, choices, models, gate:(toolName,input)=>handlers.tool_call({toolName,input},ctx)};
}

for (const command of ['rm -rf /','rm -rf /*','sudo -u root rm -rf /','env -u KEY rm -rf /','rm / -rf','rm -rf ~','rm -rf "$HOME"','rm --recursive /tmp/..','sudo rm -rf /etc','sh -c "rm -rf /"','echo $(rm -rf /)','mkfs.ext4 /dev/sda','dd if=x of=/dev/disk2','cat x > /dev/sda',':(){ :|:& };:','reboot','kill -9 -1']) {
  test(`hard block ${command}`, () => assert.ok(hardlineCommand(command)));
}
for (const command of ['pwd','rm -rf ./build','echo "rm -rf /"','git commit -m "mkfs and reboot guards"','echo shutdown','echo "cat x > /dev/sda"']) {
  test(`does not hard block ${command}`, () => assert.equal(hardlineCommand(command), undefined));
}
test('dangerous patterns cover stock gates and reference operations', () => {
  for (const command of ['rm -rf build','rm build --recursive','sudo pwd','chmod 777 file','git reset --hard','curl https://example.org/a | sh','find . -delete','docker stop app','DROP TABLE users']) assert.ok(dangerousCommand(command).length, command);
  assert.deepEqual(dangerousCommand('pwd'), []);
  assert.deepEqual(dangerousCommand('rm -rf a'), dangerousCommand('rm -rf b'));
});
for (const mode of ['manual','smart','off']) {
  test(`${mode} keeps hard blocks and credential checks`, async t => {
    const f = fixture(t,mode);
    for (const tool of ['read','write','edit','grep','find','ls']) {
      for (const file of ['.env','profiles/owl/.env','profiles/owl/pi/auth.json','connect.json','local-device.token','hexbot.db-wal','hexbot-runtime.db-shm','pi-approvals.json','users/alice/approvals/owl.json']) {
        assert.equal((await f.gate(tool,{path:join(f.home,file)}))?.block,true,`${tool} ${file}`);
      }
    }
    assert.equal((await f.gate('bash',{command:'rm -rf /'}))?.block,true);
    assert.equal(f.choices.length,0);
  });
}
test('manual permits ordinary tools, blocks protected writes, asks only at triggers', async t => {
  const f = fixture(t);
  for (const name of ['memory','hexbot_soul','message_bot','cronjob_manage','execute_code']) assert.equal(await f.gate(name,{}),undefined);
  assert.equal(await f.gate('bash',{command:'pwd'}),undefined);
  assert.equal(await f.gate('browser_console',{}),undefined);
  assert.equal((await f.gate('write',{path:join(f.home,'notes.txt')})).block,true);
  assert.equal((await f.gate('bash',{command:'rm -rf build'})).block,true);
  assert.equal((await f.gate('browser_console',{expression:'document.title'})).block,true);
  assert.equal(f.choices.length,2);
});
test('mode and approvals resolve live and always stores patterns, not arguments', async t => {
  const f = fixture(t);
  f.settings.approvalMode='off';
  assert.equal(await f.gate('bash',{command:'rm -rf a'}),undefined);
  f.settings.approvalMode='manual'; f.ctx.choice='always';
  await f.gate('bash',{command:'rm -rf a'});
  const patterns=f.requests.find(r=>r.name==='hexbot_allow_patterns').args.patterns;
  assert.deepEqual(patterns,dangerousCommand('rm -rf a'));
  f.settings.allowedPatterns=patterns;
  await f.gate('bash',{command:'rm -rf b'});
  assert.equal(f.choices.length,1);
});
test('auto failures and declines ask with smart_denied; only true auto-approves', async t => {
  const f=fixture(t,'smart');
  for (const value of [false,'true',null]) {f.ctx.approved=value; assert.equal((await f.gate('bash',{command:'rm -rf a'})).block,true);}
  f.ctx.autoError=true; await f.gate('bash',{command:'rm -rf b'});
  assert.equal(f.choices.length,4); assert.ok(f.choices.every(c=>c.smart_denied===true));
  f.ctx.autoError=false; f.ctx.approved=true;
  assert.equal(await f.gate('bash',{command:'rm -rf c'}),undefined); assert.equal(f.choices.length,4);
});
test('symlinks and parent components cannot bypass file guards', t => {
  const f=fixture(t); mkdirSync(join(f.home,'profiles/owl/pi'),{recursive:true});
  writeFileSync(join(f.home,'profiles/owl/pi/auth.json'),'secret');
  symlinkSync(join(f.home,'profiles/owl/pi/auth.json'),join(f.home,'innocent.txt'));
  symlinkSync(join(f.home,'profiles/owl/pi'),join(f.home,'alias'));
  assert.equal(credentialPath(join(f.home,'innocent.txt'),f.home),true);
  assert.equal(canonicalPath(f.home+'/alias/../.env',f.home),canonicalPath(join(f.home,'profiles/owl/.env'),f.home));
  assert.equal(credentialPath(join(homedir(),'.ssh/id_ed25519'),f.home),true);
  assert.equal(protectedPath(join(f.home,'../project/.env.production'),f.home),true);
  assert.equal(protectedPath(join(f.home,'../project/node_modules/a'),f.home),true);
});
test('bash children cannot inherit provider or connector credentials', async t => {
  const f=fixture(t,'off',['terminal']);
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-provider-secret';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});
  await f.gate('bash',{command:'env'});
  const result=await f.tools.bash.execute('test',{command:'env'});
  assert.doesNotMatch(JSON.stringify(result),/OPENAI_API_KEY|test-provider-secret/);
  assert.deepEqual(shellEnvironment({PATH:'/bin',ARBITRARY_CONNECTOR:'secret',NODE_OPTIONS:'bad',BASH_ENV:'bad',ANTHROPIC_API_KEY:'secret'}),{PATH:'/bin'});
});
test('ls and grep filter credentials and symlink targets from their output', async t => {
  const f=fixture(t,'off',['file']);
  writeFileSync(join(f.home,'auth.json'),'secret needle');writeFileSync(join(f.home,'safe.txt'),'safe needle');
  symlinkSync(join(f.home,'auth.json'),join(f.home,'alias.txt'));
  await f.gate('ls',{path:f.home});
  const ls=await f.tools.ls.execute('ls',{path:f.home});
  assert.doesNotMatch(JSON.stringify(ls),/auth.json|alias.txt/);assert.match(JSON.stringify(ls),/safe.txt/);
  await f.gate('grep',{path:f.home,pattern:'needle'});
  const grep=await f.tools.grep.execute('grep',{path:f.home,pattern:'needle'});
  assert.doesNotMatch(JSON.stringify(grep),/secret|auth.json|alias.txt/);assert.match(JSON.stringify(grep),/safe needle/);
});
test('each new turn restores primary and uses live fallback without changing prompt', async t => {
  const f=fixture(t);
  f.settings.fallback={provider:'test',model:'fallback'};
  assert.deepEqual(await f.handlers.before_agent_start({},f.ctx),{systemPrompt:'Frozen prompt'});
  await f.handlers.agent_before_settle({outcome:'error'},f.ctx);
  assert.equal(f.ctx.model.id,'fallback');
  await f.handlers.before_agent_start({},f.ctx);
  assert.equal(f.ctx.model.id,'primary');
  f.settings.fallback={provider:'test',model:'replacement'};
  await f.handlers.before_agent_start({},f.ctx);
  await f.handlers.agent_before_settle({outcome:'error'},f.ctx);
  assert.equal(f.ctx.model.id,'replacement');
});
test('credential file symlinks cannot disguise protected names', t => {
  const f=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-secret-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  writeFileSync(join(outside,'opaque'),'secret');symlinkSync(join(outside,'opaque'),join(f.home,'.env'));
  assert.equal(credentialPath(join(f.home,'.env'),f.home),true);
});
test('primary model changes remain live across fallback restoration', async t => {
  const f=fixture(t);
  await f.handlers.before_agent_start({},f.ctx);
  f.settings.model='new-primary';
  await f.handlers.before_agent_start({},f.ctx);
  assert.equal(f.ctx.model.id,'new-primary');
});
test('user bash uses the same hard blocks and sanitized environment', async t => {
  const f=fixture(t,'off',['terminal']);
  const blocked=await f.handlers.user_bash({command:'rm -rf /'},f.ctx);
  assert.equal(blocked.result.exitCode,1);
  const permitted=await f.handlers.user_bash({command:'env'},f.ctx);
  let output='';
  const result=await permitted.operations.exec('env',f.home,{env:{PATH:process.env.PATH,OPENAI_API_KEY:'secret'},onData:data=>output+=data});
  assert.equal(result.exitCode,0);assert.doesNotMatch(output,/OPENAI_API_KEY|secret/);
});
test('dangling symlinks cannot bypass credential write guards', t => {
  const f=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-link-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  symlinkSync(join(f.home,'.env'),join(outside,'notes.txt'));
  assert.equal(credentialPath(join(outside,'notes.txt'),f.home),true);
});
test('file execution uses the same symlink and parent resolution as the gate', async t => {
  const f=fixture(t,'off',['file']);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-target-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  mkdirSync(join(outside,'nested'));symlinkSync(join(outside,'nested'),join(f.home,'alias'));
  writeFileSync(join(f.home,'note.txt'),'wrong lexical file');writeFileSync(join(outside,'note.txt'),'checked file');
  const input={path:f.home+'/alias/../note.txt'};
  assert.equal(await f.gate('read',input),undefined);
  const result=await f.tools.read.execute('read',input);
  assert.match(JSON.stringify(result),/checked file/);assert.doesNotMatch(JSON.stringify(result),/wrong lexical file/);
});
