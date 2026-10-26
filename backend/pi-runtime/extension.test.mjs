import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync, existsSync, linkSync, unlinkSync, statSync, chmodSync, openSync, closeSync, readdirSync, renameSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fileBridgeReply} from './fixtures/pi-files.mjs';
import hexbot, {canonicalPath, credentialPath, protectedPath, shellEnvironment, sanitizeSearchResult, hostWriteTier, escapeMcpValues, fileRequestTitle, FILE_TRANSPORT_LIMIT} from './extension.ts';

// Scans read the user's own Git configuration. These tests use none, so the
// developer's ~/.gitconfig and system config cannot change their results.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// A repository as `git init` makes it (HEAD, objects, refs, config), with
// settings added to its config.
const gitInit = (dir, settings = []) => {
  execFileSync('/usr/bin/git', ['init', '-q', dir]);
  for (const [key, value] of settings) execFileSync('/usr/bin/git', ['-C', dir, 'config', '--add', key, value]);
};
const gitConfig = (dir, key, value) => execFileSync('/usr/bin/git', ['-C', dir, 'config', key, value]);

// These gates assume the OS sandbox is in place, as it always is on macOS. On
// Linux the probe looks for bwrap on PATH, so a stand-in that passes the probe
// and runs the command after "--" plays bubblewrap here. isolation.test.mjs
// covers the real sandbox; the no-sandbox path has its own test below.
const shims = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-shim-'));
writeFileSync(join(shims, 'bwrap'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n', {mode:0o755});
process.env.PATH = `${shims}:${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(shims, {recursive:true, force:true}));

function fixture(t, mode = 'manual', enabledToolsets = [], extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-gates-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const config = {home, cwd:home, prompt:'Frozen prompt', tools:[], enabledToolsets, provider:'test', model:'primary', ...extra};
  const path = join(home, 'config.json'); writeFileSync(path, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = path;
  const handlers = {}, tools = {}, requests = [], choices = [], models = [], registrations = [], notices = [], activeTools = [], sent = [];
  const settings = {...config, approvalMode:mode, mcpState:Object.fromEntries((config.mcpServers ?? []).map(name => [name,{revision:'initial'}]))};
  const ctx = {model:{provider:'test',id:'primary'}, modelRegistry:{find:(provider,id)=>({provider,id})}, ui:{
    async input(title, ...options) {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); requests.push(request);
      if (request.name === 'hexbot_pi_file') {
        assert.deepEqual(options,[],'file RPC must not release the mutation queue early on AbortSignal');
        return fileBridgeReply(request.args);
      }
      if (request.name === 'hexbot_mcp_servers') return JSON.stringify({result:(ctx.servers ?? (config.mcpServers ?? []).map(name => ({name,config:{command:'node'}}))).map(server => ({revision:'initial',...server}))});
      if (request.name === 'hexbot_session_settings') return JSON.stringify({result:settings});
      return JSON.stringify({result:{}});
    },
    notify:(message, type)=>notices.push({message,type}),
    async select(title, options) {choices.push({...JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length)), options}); return ctx.choice ?? 'deny';}
  }};
  const pi = {setActiveTools:names=>activeTools.push(names), getAllTools:()=>Object.values(tools), unregisterMcpServer:()=>{}, registerMcpServer:(name, config)=>registrations.push({name,config}), on:(name,handler)=>handlers[name]=handler, registerTool:tool=>tools[tool.name]=tool, registerProvider(){}, registerCommand(){}, async setModel(model){models.push(model);ctx.model=model;return true;}, sendMessage(message){sent.push(message);}, getThinkingLevel(){}};
  hexbot(pi);
  let calls = 0;
  const gate = (toolName, input, toolCallId = `call-${++calls}`) => handlers.tool_call({toolName, input, toolCallId}, ctx);
  // Gate a call, then run it as Pi would, with the same id.
  const run = async (toolName, input, toolCallId = `call-${++calls}`) => (await gate(toolName, input, toolCallId)) ?? tools[toolName].execute(toolCallId, input, undefined, undefined, ctx);
  // Run a call the gate allowed for `checked` with different arguments, as if a link changed in between.
  const swap = async (toolName, checked, input, toolCallId = `call-${++calls}`) => {
    assert.equal(await gate(toolName, checked, toolCallId), undefined);
    return tools[toolName].execute(toolCallId, input, undefined, undefined, ctx);
  };
  return {home, handlers, tools, settings, ctx, requests, choices, models, registrations, notices, activeTools, sent, gate, run, swap};
}

test('case cannot disguise credential or host configuration paths on case-insensitive file systems', {skip: process.platform !== 'darwin'}, async t => {
  const f = fixture(t, 'manual', ['file']);
  mkdirSync(join(f.home, 'profiles/owl'), {recursive:true});
  writeFileSync(join(f.home, 'profiles/owl/auth.json'), 'secret');
  for (const path of ['profiles/owl/AUTH.JSON', 'PROFILES/OWL/auth.json', '.ENV', 'CONNECT-IDENTITY.KEY', 'Connect.JSON', 'profiles/owl/.Env']) {
    assert.equal(credentialPath(join(f.home, path), f.home), true, path);
    assert.equal((await f.gate('read', {path:join(f.home, path)}))?.block, true, path);
    await assert.rejects(f.swap('read', {path:join(f.home, 'safe.txt')}, {path:join(f.home, path)}), /Credential/, path);
  }
  assert.equal(credentialPath(join(homedir(), '.SSH/id_ed25519'), f.home), true);
  assert.equal(credentialPath(join(homedir(), '.ssh/ID_ED25519.PUB'), f.home), false);
  assert.equal(hostWriteTier(join(homedir(), '.AWS/credentials'), '/tmp'), 'deny');
  assert.equal(hostWriteTier(join(homedir(), '.ZSHRC'), '/tmp'), 'ask');
  assert.equal(hostWriteTier(join(homedir(), 'library/launchagents/x.plist'), '/tmp'), 'ask');
  assert.equal(hostWriteTier('/ETC/hosts', '/tmp'), 'ask');
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
test('managed runtime paths never become file-tool output exceptions', t => {
  const f = fixture(t);
  for (const local of ['runtime/native-current.json','runtime/native/build/hexbot.exe','runtime/tools/code-python/Scripts/python.exe','runtime/bin/rg.exe','bin/uv.exe','python/bin/python']) {
    const path = join(f.home,local);
    mkdirSync(join(path,'..'),{recursive:true});
    writeFileSync(path,'keep');
    assert.equal(protectedPath(path,f.home,[join(path,'..')]),true,local);
  }
});
test('Pi write and edit replace hardlink entries, including links inserted after approval', async t => {
  for (const tool of ['write','edit']) for (const late of [false,true]) for (const local of ['runtime/native-current.json','runtime/native/build/hexbot.exe']) {
    const f = fixture(t,'smart',['file']);
    const output = join(f.home,'profiles/owl/artifacts'), source = join(f.home,local), alias = join(output,'result');
    mkdirSync(output,{recursive:true}); mkdirSync(join(source,'..'),{recursive:true});
    writeFileSync(source,'keep');
    if (late) writeFileSync(alias,'keep'); else linkSync(source,alias);
    f.settings.outputDirs = [output];
    const args = tool === 'write' ? {path:alias,content:'changed'} : {path:alias,edits:[{oldText:'keep',newText:'changed'}]};
    const id = 'hardlink';
    assert.equal(await f.gate(tool,args,id),undefined);
    if (late) { unlinkSync(alias); linkSync(source,alias); }
    await f.tools[tool].execute(id,args,undefined,undefined,f.ctx);
    assert.equal(readFileSync(source,'utf8'),'keep',`${tool} late=${late} ${local}`);
    assert.equal(readFileSync(alias,'utf8'),'changed');
    assert.notEqual(statSync(alias).ino,statSync(source).ino);
    assert.equal(f.choices.length,0,'ordinary artifact writes need no approval');
  }
});
test('restricted Pi write and edit preserve existing modes independently of umask', {skip: process.platform === 'win32'}, async t => {
  const mask = process.env.HEXBOT_TEST_FILE_UMASK;
  if (mask === undefined) {
    const environment = {...process.env}; delete environment.NODE_TEST_CONTEXT;
    for (const value of ['0022','0077','0200']) {
      await t.test(`isolated umask=${value}`, () => {
        const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^restricted Pi write and edit preserve existing modes independently of umask$', fileURLToPath(import.meta.url)], {
          env:{...environment, HEXBOT_TEST_FILE_UMASK:value}, encoding:'utf8',
        });
        assert.match(output,/^# tests 10$/m,'child executes all nine cases plus its parent');
        assert.match(output,/^# pass 10$/m);
        assert.match(output,/^# skipped 0$/m);
      });
    }
    return;
  }
  assert.ok(['0022','0077','0200'].includes(mask));
  const runWithMask = async run => {
    const previous = process.umask(Number.parseInt(mask,8));
    try { return await run(); } finally { process.umask(previous); }
  };
  for (const tool of ['write','edit']) for (const mode of [0o664,0o660,0o755,0o4664]) {
    await t.test(`${tool} mode=${mode.toString(8)} umask=${mask}`, async t => {
      const f = fixture(t,'smart',['file']);
      const output = join(f.home,'profiles/owl/artifacts'), source = join(f.home,'runtime/tools/voice.txt'), alias = join(output,'result');
      mkdirSync(output,{recursive:true}); mkdirSync(join(source,'..'),{recursive:true});
      writeFileSync(source,'keep'); chmodSync(source,mode); linkSync(source,alias);
      const original = statSync(source);
      f.settings.outputDirs = [output];
      const args = tool === 'write' ? {path:alias,content:'changed'} : {path:alias,edits:[{oldText:'keep',newText:'changed'}]};
      await runWithMask(() => f.run(tool,args));
      assert.equal(statSync(alias).mode & 0o7777,mode & 0o777,'replacement preserves ordinary bits without setuid');
      assert.equal(readFileSync(alias,'utf8'),'changed');
      assert.notEqual(statSync(alias).ino,original.ino,'tool replaces the alias entry');
      assert.equal(statSync(source).ino,original.ino);
      assert.equal(statSync(source).mode,original.mode,'managed hardlink mode is untouched');
      assert.equal(readFileSync(source,'utf8'),'keep','managed hardlink bytes are untouched');
      assert.equal(f.choices.length,0);
    });
  }
  await t.test(`new file keeps private creation default under umask=${mask}`, async t => {
    const f = fixture(t,'smart',['file']);
    const output = join(f.home,'profiles/owl/artifacts'), parent = mask === '0200' ? output : join(output,'new-folder'), path = join(parent,'new.txt');
    mkdirSync(output,{recursive:true}); f.settings.outputDirs = [output];
    await runWithMask(() => f.run('write',{path,content:'new'}));
    assert.equal(statSync(path).mode & 0o7777,0o600 & ~Number.parseInt(mask,8));
    assert.equal(readFileSync(path,'utf8'),'new');
    if (parent !== output) assert.equal(statSync(parent).mode & 0o777,0o777 & ~Number.parseInt(mask,8));
  });
});
test('restricted Pi write and edit cannot overwrite an OS-nonwritable file even after approval', {
  skip: process.platform === 'win32' || process.geteuid?.() === 0 ? 'requires Unix non-root access semantics' : false,
}, async t => {
  for (const mode of ['smart','manual']) for (const permissions of [0o444,0o000]) for (const tool of ['write','edit']) {
    await t.test(`${mode} ${tool} mode=${permissions.toString(8)}`, async t => {
      const f = fixture(t,mode,['file']);
      const output = join(f.home,'profiles/owl/artifacts'), path = join(output,'result');
      mkdirSync(output,{recursive:true}); f.settings.outputDirs = [output]; f.ctx.choice = 'once';
      writeFileSync(path,'keep');
      const readable = openSync(path,'r');
      t.after(() => closeSync(readable));
      chmodSync(path,permissions);
      const original = statSync(path);
      assert.throws(() => writeFileSync(path,'changed'), {code:'EACCES'},'OS in-place write refuses too');
      const args = tool === 'write' ? {path,content:'changed'} : {path,edits:[{oldText:'keep',newText:'changed'}]};
      await assert.rejects(f.run(tool,args),/EACCES/);
      assert.equal(f.choices.length,mode === 'manual' ? 1 : 0,'execution reached the normal approval path');
      assert.equal(statSync(path).ino,original.ino,'refusal preserves the original directory entry');
      assert.equal(statSync(path).mode,original.mode);
      assert.equal(readFileSync(readable,'utf8'),'keep');
      assert.deepEqual(readdirSync(output),['result'],'refusal leaves no temporary file');
    });
  }
});
test('private Pi file requests enforce the exact encoded record budget before any mkdir or RPC', async t => {
  for (const extra of [0,1]) {
    const f = fixture(t,'smart',['file']);
    const output = join(f.home,'profiles/owl/artifacts'), path = join(output,'missing/nested/file');
    mkdirSync(output,{recursive:true}); f.settings.outputDirs = [output]; f.settings.fileWorkdir = '';
    const content = 'x'.repeat(785000), callId = 'boundary';
    const args = {operation:'write',path:canonicalPath(path,f.home),callId,snapshot:{approvalMode:'smart',cwd:f.home,outputDirs:[output],fileWorkdir:''},content:Buffer.from(content).toString('base64')};
    const title = fileRequestTitle(args);
    const size = Buffer.byteLength(JSON.stringify({type:'extension_ui_request',id:'00000000-0000-0000-0000-000000000000',method:'input',title}));
    f.settings.fileWorkdir = 'p'.repeat(FILE_TRANSPORT_LIMIT-size+extra);
    const input = f.ctx.ui.input;
    f.ctx.ui.input = async (...params) => {
      if (JSON.parse(params[0].slice('__HEXBOT_TOOL__'.length)).name === 'hexbot_pi_file') {
        assert.equal(Buffer.byteLength(JSON.stringify({type:'extension_ui_request',id:'00000000-0000-0000-0000-000000000000',method:'input',title:params[0]})),FILE_TRANSPORT_LIMIT);
        assert.equal(existsSync(join(output,'missing')),false,'Node mkdir is a no-op');
      }
      return input(...params);
    };
    if (extra) {
      await assert.rejects(f.run('write',{path,content},callId),/1 MiB/);
      assert.equal(f.requests.filter(r=>r.name==='hexbot_pi_file').length,0);
      assert.equal(existsSync(join(output,'missing')),false);
    } else {
      await f.run('write',{path,content},callId);
      assert.equal(readFileSync(path,'utf8'),content);
      assert.equal(f.requests.filter(r=>r.name==='hexbot_pi_file').length,1);
    }
  }
});
test('registered Pi edits retain BOM, CRLF and lossy UTF8 through the raw-byte bridge', async t => {
  for (const [before,after] of [[Buffer.from('\ufeffhello\r\n'),Buffer.from('\ufeffchanged\r\n')],[Buffer.concat([Buffer.from([0xff]),Buffer.from('hello\r\n')]),Buffer.from('\ufffdchanged\r\n')]]) {
    const f = fixture(t,'smart',['file']);
    const output=join(f.home,'profiles/owl/artifacts'),path=join(output,'file');
    mkdirSync(output,{recursive:true});f.settings.outputDirs=[output];writeFileSync(path,before);
    await f.run('edit',{path,edits:[{oldText:'hello',newText:'changed'}]});
    assert.deepEqual(readFileSync(path),after);
    assert.deepEqual(f.requests.filter(r=>r.name==='hexbot_pi_file').map(r=>r.args.operation),['edit_open','edit_commit']);
  }
});
test('parallel Pi edits retain separate per-call buffers and can produce empty files', async t => {
  const f=fixture(t,'smart',['file']),output=join(f.home,'profiles/owl/artifacts');
  mkdirSync(output,{recursive:true});f.settings.outputDirs=[output];
  const paths=['alpha','beta'].map(name=>join(output,name));
  for(const [index,path] of paths.entries())writeFileSync(path,index===0?'alpha':'beta');
  let release,opened=0;const ready=new Promise(resolve=>release=resolve),input=f.ctx.ui.input;
  f.ctx.ui.input=async (...params)=>{
    const request=JSON.parse(params[0].slice('__HEXBOT_TOOL__'.length)),result=await input(...params);
    if(request.name==='hexbot_pi_file'&&request.args.operation==='edit_open'){if(++opened===2)release();await ready;}
    return result;
  };
  await Promise.all(paths.map((path,index)=>f.run('edit',{path,edits:[{oldText:index===0?'alpha':'beta',newText:index===0?'changed-alpha':''}]})));
  assert.equal(readFileSync(paths[0],'utf8'),'changed-alpha');assert.equal(readFileSync(paths[1],'utf8'),'');
  await f.run('write',{path:join(output,'empty'),content:''});assert.equal(statSync(join(output,'empty')).size,0);
});
test('registered Pi file calls refuse parent links and edit folder replacements', async t => {
  for (const tool of ['write','edit']) for (const link of tool === 'write' ? [true] : [false,true]) {
    const f=fixture(t,'smart',['file']);
    const output=join(f.home,'profiles/owl/artifacts'),parent=join(output,'parent'),moved=join(output,'moved'),managed=join(f.home,'runtime/native');
    mkdirSync(parent,{recursive:true});mkdirSync(managed,{recursive:true});f.settings.outputDirs=[output];
    const path=join(parent,'file');writeFileSync(path,'keep');writeFileSync(join(managed,'file'),'managed');
    const input=f.ctx.ui.input;
    f.ctx.ui.input=async (...params)=>{
      const request=JSON.parse(params[0].slice('__HEXBOT_TOOL__'.length));
      if (request.name==='hexbot_pi_file' && request.args.operation===(tool==='write'?'write':'edit_commit')) {
        renameSync(parent,moved);
        if(link) symlinkSync(managed,parent); else {mkdirSync(parent);writeFileSync(path,'replacement');}
      }
      return input(...params);
    };
    await assert.rejects(f.run(tool,tool==='write'?{path,content:'changed'}:{path,edits:[{oldText:'keep',newText:'changed'}]}));
    assert.equal(readFileSync(join(managed,'file'),'utf8'),'managed');
    assert.equal(readFileSync(join(moved,'file'),'utf8'),'keep');
    if(!link) assert.equal(readFileSync(path,'utf8'),'replacement');
  }
});
test('file RPC settlement holds Pi mutation ordering after local AbortSignal', async t => {
  const f=fixture(t,'smart',['file']),output=join(f.home,'profiles/owl/artifacts'),path=join(output,'file');
  mkdirSync(output,{recursive:true});f.settings.outputDirs=[output];
  const input=f.ctx.ui.input;let entered,release;
  const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);const calls=[];
  f.ctx.ui.input=async (...params)=>{
    const request=JSON.parse(params[0].slice('__HEXBOT_TOOL__'.length));
    if(request.name==='hexbot_pi_file') { calls.push(request.args.callId);if(request.args.callId==='first'){entered();await held;} }
    return input(...params);
  };
  const controller=new AbortController(),firstArgs={path,content:'first'},secondArgs={path,content:'second'};
  assert.equal(await f.gate('write',firstArgs,'first'),undefined);
  const first=f.tools.write.execute('first',firstArgs,controller.signal,undefined,f.ctx);
  // Observe rejection immediately so a later release cannot cause an unhandled rejection.
  const rejected=assert.rejects(first,/aborted/);
  try {
    await started;controller.abort();
    assert.equal(await f.gate('write',secondArgs,'second'),undefined);
    const second=f.tools.write.execute('second',secondArgs,undefined,undefined,f.ctx);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['first']);
    release();await rejected;await second;
    assert.deepEqual(calls,['first','second']);assert.equal(readFileSync(path,'utf8'),'second');
  } finally {release();await rejected;}
});
test('an unavailable private file bridge fails without a path fallback or extra approval', async t => {
  const f=fixture(t,'smart',['file']),output=join(f.home,'profiles/owl/artifacts'),path=join(output,'missing/file');
  mkdirSync(output,{recursive:true});f.settings.outputDirs=[output];const input=f.ctx.ui.input;
  f.ctx.ui.input=async (...params)=>JSON.parse(params[0].slice('__HEXBOT_TOOL__'.length)).name==='hexbot_pi_file'?JSON.stringify({error:'Unknown tool: hexbot_pi_file'}):input(...params);
  await assert.rejects(f.run('write',{path,content:'changed'}),/Unknown tool/);
  assert.equal(existsSync(join(output,'missing')),false);assert.equal(f.choices.length,0);
});
test('Bypass file writes retain upstream behavior without the private bridge', async t => {
  const f=fixture(t,'off',['file']),path=join(f.home,'ordinary.txt'),alias=join(f.home,'alias.txt');
  writeFileSync(path,'keep');linkSync(path,alias);const original=statSync(path).ino;
  await f.run('write',{path:alias,content:'changed'});
  assert.equal(readFileSync(path,'utf8'),'changed');assert.equal(statSync(alias).ino,original);
  assert.equal(f.requests.filter(r=>r.name==='hexbot_pi_file').length,0);assert.equal(f.choices.length,0);
});
test('managed roots pointing into outputs refuse writes and command layouts, while reads stay allowed', t => {
  const f = fixture(t);
  const output = join(f.home,'profiles/owl/artifacts');
  const actual = join(output,'actual-runtime');
  mkdirSync(actual,{recursive:true});
  mkdirSync(join(f.home,'runtime'),{recursive:true});
  symlinkSync(actual,join(f.home,'runtime/native'));
  writeFileSync(join(actual,'hexbot.exe'),'keep');
  assert.equal(credentialPath(join(actual,'hexbot.exe'),f.home),false);
  for (const path of [join(actual,'hexbot.exe'),join(actual,'absent.exe')]) {
    assert.throws(() => protectedPath(path,f.home,[output]),/Managed runtime roots must not be symlinked/);
  }
});
test('bash children cannot inherit provider or connector credentials', async t => {
  const f=fixture(t,'smart',['terminal']);
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-provider-secret';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});
  await f.gate('bash',{command:'env'},'env');
  const result=await f.tools.bash.execute('env',{command:'env'});
  assert.doesNotMatch(JSON.stringify(result),/OPENAI_API_KEY|test-provider-secret/);
  assert.deepEqual(shellEnvironment({PATH:'/bin',ARBITRARY_CONNECTOR:'secret',NODE_OPTIONS:'bad',BASH_ENV:'bad',ANTHROPIC_API_KEY:'secret'}),{PATH:'/bin'});
  assert.deepEqual(shellEnvironment({TERM:'xterm',lc_all:'C',SystemRoot:'C:\\',WINDIR:'x',COMSPEC:'x',DISPLAY:':0'}),{TERM:'xterm',lc_all:'C'});
});
test('ls and grep filter credentials and symlink targets from their output', async t => {
  const f=fixture(t,'smart',['file']);
  writeFileSync(join(f.home,'auth.json'),'secret needle');writeFileSync(join(f.home,'safe.txt'),'safe needle');
  symlinkSync(join(f.home,'auth.json'),join(f.home,'alias.txt'));
  const ls=await f.run('ls',{path:f.home});
  assert.doesNotMatch(JSON.stringify(ls),/auth.json|alias.txt/);assert.match(JSON.stringify(ls),/safe.txt/);
  const grep=await f.run('grep',{path:f.home,pattern:'needle'});
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
test('check-in messages join the next turn after the user message, once, without touching the prompt', async t => {
  const f = fixture(t);
  const input = f.ctx.ui.input;
  let waiting = ['Your PE feedback is due tonight at 11:59 PM.'];
  f.ctx.ui.input = async title => {
    const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
    if (request.name !== 'hexbot_checkin_context') return input(title);
    f.requests.push(request);
    const text = waiting.length ? `Sent: ${waiting.join(' ')}` : null;
    waiting = [];
    return JSON.stringify({result:{text, ids: text ? ['m1'] : []}});
  };
  // Nothing waiting: the turn never asks.
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
  assert.ok(!f.requests.some(r => r.name === 'hexbot_checkin_context'));
  f.settings.pendingCheckins = true;
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt', message:{customType:'hexbot_checkin', content:'Sent: Your PE feedback is due tonight at 11:59 PM.', display:false, details:{checkins:['m1']}}});
  // Taken once: the daemon has nothing more, so the turn is plain again.
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
  // A broken bridge never stops the turn.
  f.ctx.ui.input = async title => JSON.parse(title.slice('__HEXBOT_TOOL__'.length)).name === 'hexbot_checkin_context' ? (() => { throw new Error('bridge down'); })() : input(title);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
});
test('the prompt is rebuilt at compaction only, and a failed request keeps the old one', async t => {
  const f = fixture(t);
  let answer = () => JSON.stringify({result:null});
  let todo = title => input(title);
  const input = f.ctx.ui.input;
  f.ctx.ui.input = async title => {
    const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
    if (request.name === 'hexbot_todo_context') return todo(title);
    if (request.name !== 'hexbot_session_prompt') return input(title);
    f.requests.push(request);
    return answer();
  };
  const tools = Object.keys(f.tools);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
  assert.ok(!f.requests.some(r => r.name === 'hexbot_session_prompt'), 'a turn never asks');
  // Unchanged bot files: null, and the prompt stays.
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(f.requests.filter(r => r.name !== 'hexbot_session_settings' && r.name !== 'hexbot_mcp_servers').map(r => r.name), ['hexbot_todo_context', 'hexbot_session_prompt']);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
  answer = () => JSON.stringify({result:{text:'Rebuilt prompt'}});
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt prompt'});
  // The daemon refused, then the bridge broke: compaction completes, the prompt stays.
  answer = () => JSON.stringify({error:'daemon is shutting down'});
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt prompt'});
  answer = () => { throw new Error('bridge down'); };
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt prompt'});
  answer = () => '';
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt prompt'});
  assert.equal(f.requests.filter(r => r.name === 'hexbot_todo_context').length, 5);
  assert.deepEqual(Object.keys(f.tools), tools);
  // The two requests are independent: an interrupted or failed todo request
  // still lets the prompt change, and a todo arrives while the prompt fails.
  answer = () => JSON.stringify({result:{text:'Rebuilt again'}});
  todo = async () => '';
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt again'});
  answer = () => JSON.stringify({result:{text:'Rebuilt a third time'}});
  todo = async () => JSON.stringify({error:'todo store is busy'});
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt a third time'});
  assert.deepEqual(f.sent, []);
  answer = () => { throw new Error('bridge down'); };
  todo = async () => JSON.stringify({result:{text:'- [ ] finish the export'}});
  await f.handlers.session_compact({}, f.ctx);
  assert.deepEqual(f.sent.map(m => m.content), ['- [ ] finish the export']);
  assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Rebuilt a third time'});
});
test('credential file symlinks cannot disguise protected names', t => {
  const f=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-secret-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  writeFileSync(join(outside,'opaque'),'secret');symlinkSync(join(outside,'opaque'),join(f.home,'.env'));
  assert.equal(credentialPath(join(f.home,'.env'),f.home),true);
});
test('project secrets and browser stores are private to the file tools; examples and venvs are not', async t => {
  const f=fixture(t,'smart',['file']);
  const work=mkdtempSync(join(tmpdir(),'hexbot-project-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  for (const name of ['.env','.envrc','.env.local','.env.production']) { writeFileSync(join(work,name),'secret'); assert.equal(credentialPath(join(work,name),f.home),true,name); }
  for (const name of ['.env.example','.env.sample','env.txt']) { writeFileSync(join(work,name),'ok'); assert.equal(credentialPath(join(work,name),f.home),false,name); }
  mkdirSync(join(work,'.env')+'-dir'); mkdirSync(join(work,'venv/.env'),{recursive:true});
  assert.equal(credentialPath(join(work,'venv/.env'),f.home),false);
  for (const store of ['Library/Keychains/login.keychain-db','Library/Application Support/Google/Chrome/Default/Cookies','.mozilla/firefox/x/logins.json'])
    assert.equal(credentialPath(join(homedir(),store),f.home),true,store);
  f.settings.cwd=work;
  assert.equal((await f.gate('read',{path:join(work,'.env')}))?.reason,'Credential files are private.');
  assert.equal(await f.gate('read',{path:join(work,'.env.example')}),undefined);
  // Examples are ordinary files to write as well; secrets are not.
  for (const name of ['.env.example','.env.sample','.env.template','.env.dist']) {
    assert.equal(protectedPath(join(work,name),f.home),false,name);
    assert.equal(await f.gate('write',{path:join(work,name),content:'ok'}),undefined,name);
  }
  for (const name of ['.env.local','.envrc']) assert.equal(protectedPath(join(work,name),f.home),true,name);
});
test('primary model changes remain live across fallback restoration', async t => {
  const f=fixture(t);
  await f.handlers.before_agent_start({},f.ctx);
  f.settings.model='new-primary';
  await f.handlers.before_agent_start({},f.ctx);
  assert.equal(f.ctx.model.id,'new-primary');
});
test('dangling symlinks cannot bypass credential write guards', t => {
  const f=fixture(t);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-link-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  symlinkSync(join(f.home,'.env'),join(outside,'notes.txt'));
  assert.equal(credentialPath(join(outside,'notes.txt'),f.home),true);
});
test('file execution uses the same symlink and parent resolution as the gate', async t => {
  const f=fixture(t,'smart',['file']);
  const outside=mkdtempSync(join(tmpdir(),'hexbot-target-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  mkdirSync(join(outside,'nested'));symlinkSync(join(outside,'nested'),join(f.home,'alias'));
  writeFileSync(join(f.home,'note.txt'),'wrong lexical file');writeFileSync(join(outside,'note.txt'),'checked file');
  const input={path:f.home+'/alias/../note.txt'};
  const result=await f.run('read',input);
  assert.match(JSON.stringify(result),/checked file/);assert.doesNotMatch(JSON.stringify(result),/wrong lexical file/);
});
test('tool dialog receives the execution abort signal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hexbot-extension-'));
  const previous = process.env.HEXBOT_SESSION_CONFIG;
  try {
    const config = join(directory, 'config.json');
    writeFileSync(config, JSON.stringify({tools: [{name: 'execute_code'}]}));
    process.env.HEXBOT_SESSION_CONFIG = config;
    let tool;
    hexbot({on() {}, registerProvider() {}, registerCommand() {}, registerTool(value) {tool = value;}});
    const controller = new AbortController();
    const ctx = {ui: {input(_title, _placeholder, options) {
      assert.equal(options.signal, controller.signal);
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(undefined), {once: true}));
    }}};
    const execution = tool.execute('one', {}, controller.signal, undefined, ctx);
    controller.abort();
    await assert.rejects(execution, /Tool interrupted/);
  } finally {
    if (previous === undefined) delete process.env.HEXBOT_SESSION_CONFIG;
    else process.env.HEXBOT_SESSION_CONFIG = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});

// Exercise Pi's actual Codex transport: it rebuilds Authorization after header hooks.
test('Codex stream uses the current daemon token on every request and stops on auth failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-auth-'));
  const saved = process.env.HEXBOT_SESSION_CONFIG;
  try {
    process.env.HEXBOT_SESSION_CONFIG = join(home, 'config.json');
    writeFileSync(process.env.HEXBOT_SESSION_CONFIG, JSON.stringify({tools: []}));
    const handlers = new Map();
    const providers = new Map();
    hexbot({on: (event, callback) => handlers.set(event, callback), registerProvider: (name, value) => providers.set(name, value), registerCommand() {}});
    let n = 0;
    let error;
    const token = n => `header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: `account-${n}`}})).toString('base64url')}.signature`;
    await handlers.get('session_start')({}, {ui: {input: async request => {
      assert.deepEqual(JSON.parse(request.slice('__HEXBOT_TOOL__'.length)), {name: 'hexbot_provider_auth', args: {provider: 'openai-codex'}});
      if (error) return JSON.stringify({error});
      return JSON.stringify({result: {headers: {authorization: `Bearer ${token(++n)}`, 'x-api-key': null}}});
    }}});
    const model = {id: 'gpt-5.4', name: 'Test', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], maxTokens: 4096, contextWindow: 32768, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
    const context = {messages: [{role: 'system', content: 'Frozen prompt', timestamp: 0}, {role: 'user', content: [{type: 'text', text: 'Hello'}], timestamp: 1}]};
    const frozen = structuredClone(context);
    const sent = [];
    const options = {apiKey: token(0), transport: 'sse', fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      sent.push(headers.get('authorization'));
      assert.equal(headers.get('chatgpt-account-id'), `account-${n}`);
      return new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n', {headers: {'content-type': 'text/event-stream'}});
    }};
    for (let turn = 0; turn < 2; turn++) {
      const result = await providers.get('openai-codex').streamSimple(model, context, options).result();
      assert.notEqual(result.stopReason, 'error', result.errorMessage);
    }
    assert.deepEqual(sent, [`Bearer ${token(1)}`, `Bearer ${token(2)}`]);
    assert.deepEqual(context, frozen);
    error = 'Refresh failed';
    const result = await providers.get('openai-codex').streamSimple(model, context, options).result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Refresh failed/);
    assert.equal(sent.length, 2);
  } finally {
    if (saved === undefined) delete process.env.HEXBOT_SESSION_CONFIG; else process.env.HEXBOT_SESSION_CONFIG = saved;
    rmSync(home, {recursive: true, force: true});
  }
});

test('the gate and execution reject a secret name symlink to an ordinary file', async t => {
  const f = fixture(t, 'smart', ['file']);
  writeFileSync(join(f.home, 'ordinary'), 'never read');
  symlinkSync(join(f.home, 'ordinary'), join(f.home, '.env'));
  assert.equal((await f.gate('read', {path:join(f.home, '.env')}))?.block, true);
  await assert.rejects(() => f.swap('read', {path:join(f.home, 'ordinary')}, {path:join(f.home, '.env')}), /Credential/);
});
test('grep redacts numbered bot names and all detail text', async t => {
  const f = fixture(t, 'smart', ['file']);
  const dir = join(f.home, 'profiles/owl-2-beta'); mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, '.env'), 'hiddenneedle\nSECRET-CONTEXT');
  writeFileSync(join(dir, 'notes.txt'), 'public needle');
  const result = await f.run('grep', {path:f.home, pattern:'needle', hidden:true, context:1});
  assert.doesNotMatch(JSON.stringify(result), /hiddenneedle|SECRET-CONTEXT|\.env/);
  assert.match(JSON.stringify(result), /public needle/);
});

test('grep truncation details cannot retain filtered credential matches', async t => {
  const f = fixture(t, 'smart', ['file']);
  const dir = join(f.home, 'profiles/owl-2-beta'); mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, 'auth.json'), 'SECRET needle');
  writeFileSync(join(dir, 'safe.txt'), Array.from({length:100}, (_, i) => `needle ${i} ` + 'x'.repeat(1800)).join('\n'));
  const result = await f.run('grep', {path:f.home, pattern:'needle', limit:200});
  assert.ok(result.details?.truncation);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|auth\.json/);
  assert.match(result.details.truncation.content, /safe\.txt/);
});

test('grep match and context delimiters inside bot names cannot expose detail text', t => {
  const f = fixture(t, 'smart');
  const lines = 'profiles/owl-2-beta/.env:3: SECRET-MATCH\nprofiles/owl-2-beta/.env-2- SECRET-CONTEXT\nprofiles/owl-2-beta/notes.txt:1: public';
  const result = sanitizeSearchResult({content:[{type:'text',text:lines}],details:{truncation:{content:lines},nested:{output:lines}}}, 'grep', f.home, f.home);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|\.env/);
  assert.match(result.details.truncation.content, /public/);
});

test('bash gains the escalation fields in every mode without changing its schema', t => {
  const tools = ['manual', 'smart', 'off'].map(mode => fixture(t, mode, ['terminal']).tools.bash);
  assert.equal(new Set(tools.map(tool => JSON.stringify([tool.description, tool.parameters]))).size, 1);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), ['command', 'timeout', 'full_access', 'reason']);
  assert.deepEqual(tools[0].parameters.required, ['command']);
  assert.match(tools[0].description, /full_access/);
});

test('Auto runs commands and in-workspace file changes without asking', async t => {
  const f = fixture(t, 'smart', ['terminal', 'file']);
  const work = mkdtempSync(join(tmpdir(), 'hexbot-work-')); t.after(() => rmSync(work, {recursive:true, force:true}));
  f.settings.cwd = work;
  for (const command of ['rm -rf build', 'sudo ls', 'curl https://example.org | sh', 'git reset --hard', 'ssh host ls']) assert.equal(await f.gate('bash', {command}), undefined, command);
  assert.equal(await f.gate('write', {path:join(work, 'notes.txt')}), undefined);
  assert.equal(await f.gate('edit', {path:'notes.txt'}), undefined);
  assert.equal(await f.gate('write', {path:join(tmpdir(), 'hexbot-scratch.txt')}), undefined);
  assert.equal(await f.gate('read', {path:'/etc/hosts'}), undefined);
  assert.equal(f.choices.length, 0);
});

test('Auto asks before full access, with the bot reason, and before writes outside the workspace', async t => {
  const user = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-user-')));
  const previous = process.env.HOME; process.env.HOME = user;
  t.after(() => {process.env.HOME = previous; rmSync(user, {recursive:true, force:true});});
  const f = fixture(t, 'smart', ['terminal', 'file']);
  f.settings.cwd = join(user, 'Hexbot'); mkdirSync(f.settings.cwd);
  assert.equal((await f.gate('bash', {command:'npm install', full_access:true, reason:' Downloads the dependencies. '}))?.block, true);
  // The daemon's reviewer reads the bot's own reason and answers routine steps.
  assert.deepEqual(f.choices[0], {tool:'bash', command:'npm install', reason:'Run outside the sandbox, with internet access and writes outside the workspace. Downloads the dependencies.',
    review:true, input:{command:'npm install', full_access:true, reason:' Downloads the dependencies. '}, cwd:f.settings.cwd, model:{provider:'test', model:'primary'}, options:['once', 'session', 'deny']});
  // The temp folders are part of the workspace; /usr/local is not.
  assert.equal(await f.gate('write', {path:join(user, 'scratch.txt')}), undefined);
  assert.equal((await f.gate('write', {path:'/usr/local/hexbot-elsewhere.txt'}))?.block, true);
  assert.match(f.choices[1].reason, /outside the workspace/);
  assert.equal(f.choices[1].command, '/usr/local/hexbot-elsewhere.txt');
  assert.equal(f.choices[1].review, true);
  assert.equal(f.choices[1].overwrites, false);
  // A workspace that holds shell profiles still asks before changing them.
  f.settings.cwd = user;
  assert.equal(await f.gate('write', {path:join(user, 'notes.txt')}), undefined);
  assert.equal((await f.gate('write', {path:join(user, '.zshrc')}))?.block, true);
  assert.match(f.choices[2].reason, /shell profile/);
  // Host configuration always reaches the user.
  assert.equal(f.choices[2].review, undefined);
  assert.equal(f.choices.length, 3);
  // A section answer to a reviewed step is not remembered, and never covers shell profiles.
  f.settings.cwd = join(user, 'Hexbot');
  f.ctx.choice = 'session';
  assert.equal(await f.gate('write', {path:'/usr/local/hexbot-elsewhere.txt'}), undefined);
  f.ctx.choice = 'deny';
  assert.equal((await f.gate('write', {path:'/usr/local/hexbot-other.txt'}))?.block, true);
  assert.equal((await f.gate('write', {path:join(user, '.zshrc')}))?.block, true);
  assert.equal(f.choices.length, 6);
  // After the primary model fails, the reviewer uses the fallback Pi switched to.
  f.settings.fallback = {provider:'test', model:'fallback'};
  await f.handlers.agent_before_settle({outcome:'error'}, f.ctx);
  assert.equal((await f.gate('write', {path:'/usr/local/hexbot-other.txt'}))?.block, true);
  assert.deepEqual(f.choices[6].model, {provider:'test', model:'fallback'});
});

test('Auto reviews every step outside the sandbox, whatever was allowed before', async t => {
  const f = fixture(t, 'manual', ['terminal']);
  // An Allow for now grant from Manual does not carry into Auto's reviewed steps.
  f.ctx.choice = 'session';
  assert.equal(await f.gate('bash', {command:'make', full_access:true}), undefined);
  assert.equal(await f.gate('bash', {command:'make', full_access:true}), undefined);
  assert.equal(f.choices.length, 1);
  f.settings.approvalMode = 'smart';
  assert.equal(await f.gate('bash', {command:'rm -rf ~', full_access:true}), undefined);
  assert.equal(f.choices.length, 2);
  assert.equal(f.choices[1].review, true);
  // Nor does a session answer to a reviewed step.
  assert.equal(await f.gate('bash', {command:'rm -rf ~', full_access:true}), undefined);
  assert.equal(f.choices.length, 3);
  // Leaving Auto while the reviewer runs stops the step.
  const select = f.ctx.ui.select;
  f.ctx.ui.select = async (title, options) => {f.settings.approvalMode = 'manual'; return select(title, options);};
  f.ctx.choice = 'once';
  assert.match((await f.gate('bash', {command:'curl -sL https://example.com', full_access:true}))?.reason, /approval mode changed/);
});

test('a reviewed command cannot run in a working directory changed during review', async t => {
  const f = fixture(t, 'smart', ['terminal']);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-reviewed-cwd-')));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const first = join(work, 'first'), second = join(work, 'second');
  mkdirSync(first); mkdirSync(second);
  f.settings.cwd = first;
  const select = f.ctx.ui.select;
  f.ctx.choice = 'once';
  f.ctx.ui.select = async (title, options) => {
    const choice = await select(title, options);
    f.settings.cwd = second;
    return choice;
  };
  const input = {command:'pwd > gate-ran.txt', full_access:true, reason:'Record the project directory.'};
  const blocked = await f.run('bash', input, 'moved-during-review');
  assert.equal(f.choices[0].cwd, first);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /working directory changed/);
  assert.equal(existsSync(join(first, 'gate-ran.txt')), false);
  assert.equal(existsSync(join(second, 'gate-ran.txt')), false);
  await assert.rejects(f.tools.bash.execute('moved-during-review', input, undefined, undefined, f.ctx), /Try again/);
  // A new review of the new directory can run through the real bash wrapper.
  f.ctx.ui.select = select;
  const result = await f.run('bash', {...input, command:'pwd'});
  assert.equal(f.choices[1].cwd, second);
  assert.match(JSON.stringify(result), new RegExp(second));
});

test('a reviewed file create cannot turn into an overwrite before execution', async t => {
  const f = fixture(t, 'smart', ['file']);
  const outside = realpathSync(mkdtempSync('/var/tmp/hexbot-reviewed-write-'));
  t.after(() => rmSync(outside, {recursive:true, force:true}));
  f.settings.cwd = join(outside, 'workspace'); mkdirSync(f.settings.cwd);
  const path = join(outside, 'report.txt');
  const select = f.ctx.ui.select;
  f.ctx.choice = 'once';
  f.ctx.ui.select = async (title, options) => {
    const choice = await select(title, options);
    writeFileSync(path, 'owner data');
    return choice;
  };
  await assert.rejects(f.run('write', {path, content:'replacement'}), /file changed after it was reviewed/);
  assert.equal(f.choices[0].review, true);
  assert.equal(f.choices[0].overwrites, false);
  assert.equal(readFileSync(path, 'utf8'), 'owner data');
});

test('a reviewed file write retains its resolved destination when a link changes during review', async t => {
  const f = fixture(t, 'smart', ['file']);
  const outside = realpathSync(mkdtempSync('/var/tmp/hexbot-reviewed-target-'));
  t.after(() => rmSync(outside, {recursive:true, force:true}));
  f.settings.cwd = join(outside, 'workspace'); mkdirSync(f.settings.cwd);
  const first = join(outside, 'first.txt'), second = join(outside, 'second.txt');
  writeFileSync(first, 'first owner data'); writeFileSync(second, 'second owner data');
  const link = join(f.settings.cwd, 'report.txt'); symlinkSync(first, link);
  const select = f.ctx.ui.select;
  f.ctx.choice = 'once';
  f.ctx.ui.select = async (title, options) => {
    const choice = await select(title, options);
    rmSync(link); symlinkSync(second, link);
    return choice;
  };
  await assert.rejects(f.run('write', {path:'report.txt', content:'replacement'}), /file changed after it was checked/);
  assert.equal(f.choices[0].review, true);
  assert.equal(f.choices[0].command, first);
  assert.equal(f.choices[0].overwrites, true);
  assert.equal(readFileSync(first, 'utf8'), 'first owner data');
  assert.equal(readFileSync(second, 'utf8'), 'second owner data');
});

test('Manual asks before every file change and full access, not before reads or sandboxed commands', async t => {
  const f = fixture(t, 'manual', ['terminal', 'file']);
  const work = mkdtempSync(join(tmpdir(), 'hexbot-work-')); t.after(() => rmSync(work, {recursive:true, force:true}));
  f.settings.cwd = work;
  assert.equal(await f.gate('bash', {command:'ls'}), undefined);
  assert.equal(await f.gate('read', {path:'notes.txt'}), undefined);
  assert.equal(await f.gate('grep', {path:'.', pattern:'x'}), undefined);
  assert.equal((await f.gate('write', {path:join(work, 'notes.txt')}))?.block, true);
  assert.match(f.choices[0].reason, /Manual mode asks/);
  assert.equal((await f.gate('bash', {command:'make', full_access:true}))?.block, true);
  assert.match(f.choices[1].reason, /No reason given/);
  // Manual never hands a step to Auto's reviewer.
  assert.equal(f.choices[1].review, undefined);
  assert.equal((await f.gate('browser_console', {expression:'document.title'}))?.block, true);
  assert.equal(await f.gate('browser_console', {}), undefined);
  for (const name of ['memory', 'hexbot_soul', 'message_bot', 'cronjob_manage', 'execute_code']) assert.equal(await f.gate(name, {}), undefined);
  assert.equal(f.choices.length, 3);
  f.ctx.choice = 'once';
  assert.equal(await f.gate('edit', {path:'notes.txt'}), undefined);
});

test('allowing for the section covers later requests of the same kind only', async t => {
  const f = fixture(t, 'manual', ['terminal']);
  f.ctx.choice = 'session';
  assert.equal(await f.gate('bash', {command:'curl a', full_access:true, reason:'r'}), undefined);
  f.ctx.choice = 'deny';
  assert.equal(await f.gate('bash', {command:'curl b', full_access:true, reason:'r'}), undefined);
  assert.equal((await f.gate('browser_console', {expression:'document.title'}))?.block, true);
  assert.deepEqual(f.choices.map(choice => choice.tool), ['bash', 'browser_console']);
});

test('Bypass is plain Pi: no prompts, credential checks or sandbox', async t => {
  const f = fixture(t, 'off', ['terminal', 'file']);
  writeFileSync(join(f.home, '.env'), 'KEY=bypass-secret');
  for (const [tool, input] of [['read', {path:join(f.home, '.env')}], ['write', {path:join(f.home, 'config.yaml')}], ['bash', {command:'rm -rf build', full_access:true}], ['browser_console', {expression:'1'}]]) {
    assert.equal(await f.gate(tool, input), undefined, tool);
  }
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, '.env')})), /bypass-secret/);
  const previous = process.env.HEXBOT_TEST_VALUE; process.env.HEXBOT_TEST_VALUE = 'inherited';
  t.after(() => {if (previous === undefined) delete process.env.HEXBOT_TEST_VALUE; else process.env.HEXBOT_TEST_VALUE = previous;});
  await f.gate('bash', {command:'env'}, 'plain');
  const result = JSON.stringify(await f.tools.bash.execute('plain', {command:'echo "$HEXBOT_TEST_VALUE"; cat .env'}));
  assert.match(result, /inherited/); assert.match(result, /bypass-secret/);
  assert.equal(f.choices.length, 0);
});

test('failed bash results keep the exit code and add a hint only inside the sandbox', async t => {
  const f = fixture(t, 'manual', ['terminal']);
  const input = {command:'echo failed; exit 7'};
  for (const mode of ['manual', 'smart', 'off']) {
    f.settings.approvalMode = mode;
    const result = await f.run('bash', input);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.exit_code, 7);
    assert.equal(result.structuredContent.output.trim(), 'failed');
    const text = result.content.map(item => item.text).join('\n');
    assert.match(text, /Command exited with code 7/);
    if (mode === 'off') assert.doesNotMatch(text, /run it again with full_access/);
    else assert.match(text, /run it again with full_access/);
  }
  f.settings.approvalMode = 'manual';
  f.ctx.choice = 'once';
  const result = await f.run('bash', {...input, full_access:true, reason:'Checks an unsandboxed failure.'});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.exit_code, 7);
  assert.doesNotMatch(JSON.stringify(result), /run it again with full_access/);
});

test('the sandbox follows the mode, and an approved full_access command leaves it', {skip: process.platform !== 'darwin'}, async t => {
  const f = fixture(t, 'manual', ['terminal']);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-work-'))); t.after(() => rmSync(work, {recursive:true, force:true}));
  f.settings.cwd = work;
  let calls = 0;
  const run = async (input, choice = 'deny') => {
    f.ctx.choice = choice;
    const id = `run-${++calls}`;
    const denied = await f.gate('bash', input, id);
    if (denied) return denied.reason;
    try { return JSON.stringify(await f.tools.bash.execute(id, input)); } catch (error) { return error.message; }
  };
  assert.match(await run({command:'echo x > note.txt'}), /read-only sandbox, without internet access\. If it failed for that reason, run it again with full_access/);
  assert.match(await run({command:'echo x > note.txt && echo wrote', full_access:true, reason:'Saves the note.'}, 'once'), /wrote/);
  assert.match(await run({command:'echo x > note.txt', full_access:true, reason:'Saves the note.'}), /denied/);
  f.settings.approvalMode = 'smart';
  assert.match(await run({command:'echo y > note.txt && echo wrote'}), /wrote/);
  const server = createServer(socket => socket.end()).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.close());
  const connect = `exec 3<>/dev/tcp/127.0.0.1/${server.address().port} && echo connected`;
  assert.match(await run({command:connect}), new RegExp(`writes only in ${work}`));
  assert.match(await run({command:connect, full_access:true, reason:'Talks to the local server.'}, 'once'), /connected/);
  f.settings.approvalMode = 'off';
  assert.match(await run({command:connect}), /connected/);
});

test('without an OS sandbox every shell command asks in Manual and Auto', async t => {
  const {execFileSync} = await import('node:child_process');
  const {chmodSync} = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'hexbot-unsandboxed-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const bwrap = join(home, 'bwrap'); writeFileSync(bwrap, '#!/bin/sh\nexit 1\n'); chmodSync(bwrap, 0o755);
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({home, cwd:home, prompt:'p', tools:[], enabledToolsets:['terminal'], provider:'test', model:'m'}));
  const script = `Object.defineProperty(process, 'platform', {value:'linux'});
    const {default: hexbot} = await import(${JSON.stringify(new URL('./extension.ts', import.meta.url).href)});
    const handlers = {}, tools = {}, choices = [];
    const settings = {approvalMode:'manual'};
    const ctx = {choice:'deny', ui:{
      async input(title) {const r = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); if (r.name === 'hexbot_session_settings') return JSON.stringify({result:settings}); return JSON.stringify({result:{}});},
      async select(title) {choices.push(JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length))); return ctx.choice;}
    }};
    hexbot({on:(name, handler) => handlers[name] = handler, registerTool:tool => tools[tool.name] = tool, registerProvider() {}, registerCommand() {}});
    const gate = (command, full_access = false, toolCallId) => handlers.tool_call({toolName:'bash', input:{command, full_access}, toolCallId}, ctx);
    const out = {};
    out.manualDenied = (await gate('echo hi'))?.block === true;
    out.manualFullAccessDenied = (await gate('printf full-access', true))?.block === true;
    out.manualFullAccessReview = choices.at(-1).review ?? false;
    settings.approvalMode = 'smart';
    out.smartDenied = (await gate('ls'))?.block === true;
    out.smartFullAccessDenied = (await gate('printf approved-full-access', true))?.block === true;
    out.fullAccessReview = choices.at(-1).review ?? false;
    out.fullAccessReason = choices.at(-1).reason;
    ctx.choice = 'once';
    out.fullAccessApproved = (await gate('printf approved-full-access', true, 'approved')) === undefined;
    out.fullAccessResult = (await tools.bash.execute('approved', {command:'printf approved-full-access', full_access:true}, undefined, undefined, ctx)).content;
    out.reason = choices[0].reason;
    ctx.choice = 'session';
    out.sessionPasses = (await gate('echo hi')) === undefined;
    ctx.choice = 'deny';
    out.afterSession = (await gate('echo again')) === undefined;
    out.asked = choices.length;
    settings.canAsk = false;
    out.unattendedDenied = (await gate('echo unattended'))?.reason;
    out.askedAfterUnattended = choices.length;
    settings.approvalMode = 'off';
    out.offPasses = (await gate('pwd')) === undefined;
    console.log(JSON.stringify(out));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env:{...process.env, PATH:home, HEXBOT_SESSION_CONFIG:config}, encoding:'utf8'}));
  assert.deepEqual(result, {manualDenied:true, manualFullAccessDenied:true, manualFullAccessReview:false, smartDenied:true, smartFullAccessDenied:true, fullAccessReview:false, fullAccessReason:result.reason, fullAccessApproved:true, fullAccessResult:result.fullAccessResult, reason:result.reason, sessionPasses:true, afterSession:true, asked:6, unattendedDenied:'This action needs approval. Run it in a visible section.', askedAfterUnattended:6, offPasses:true});
  assert.match(result.reason, /no OS sandbox/);
  assert.match(JSON.stringify(result.fullAccessResult), /approved-full-access/);
});

test('file tools never write credential stores or daemon configuration outside Bypass', async t => {
  const user = mkdtempSync(join(tmpdir(), 'hexbot-user-'));
  const previous = process.env.HOME; process.env.HOME = user;
  t.after(() => {process.env.HOME = previous; rmSync(user, {recursive:true, force:true});});
  for (const mode of ['manual', 'smart']) {
    const f = fixture(t, mode, ['file']);
    for (const path of [join(user, '.netrc'), join(user, '.git-credentials'), join(user, '.aws/credentials'), join(user, '.config/gh/hosts.yml'), join(user, '.kube/config'), '~/.npmrc', '/etc/hosts']) {
      for (const tool of ['write', 'edit']) assert.match((await f.gate(tool, {path})).reason, /never written|private/, `${mode} ${tool} ${path}`);
      if (path !== '/etc/hosts') for (const tool of ['read', 'grep', 'ls']) assert.match((await f.gate(tool, {path})).reason, /private/, `${mode} ${tool} ${path}`);
      await assert.rejects(f.tools.write.execute('write', {path, content:'bad'}), /Try again/);
    }
    for (const path of ['config.yaml', 'bin/script', 'hooks/script', 'profiles/owl/config.yaml', 'skills/script']) {
      for (const tool of ['write', 'edit']) assert.match((await f.gate(tool, {path:join(f.home, path)})).reason, /protected/, `${mode} ${path}`);
      await assert.rejects(f.tools.write.execute('write', {path:join(f.home, path), content:'bad'}), /Try again/);
    }
    assert.equal(await f.gate('read', {path:join(user, '.zshrc')}), undefined);
    assert.equal(f.choices.length, 0);
  }
  assert.equal(hostWriteTier('~/.aws/credentials', '/tmp'), 'deny');
  assert.equal(hostWriteTier(join(user, '.zshrc'), '/tmp'), 'ask');
  assert.equal(hostWriteTier('/etc/hosts', '/tmp'), 'ask');
  assert.equal(hostWriteTier('/etc/hosts', '/tmp', true), 'deny');
  assert.equal(hostWriteTier(join(user, 'Hexbot/notes.md'), '/tmp'), undefined);
});

test('a cwd inside the home opens nothing; output folders and an outside workspace take writes', async t => {
  const f = fixture(t, 'smart', ['file']);
  f.settings.cwd = join(f.home, 'workspace'); mkdirSync(f.settings.cwd);
  assert.equal((await f.gate('write', {path:join(f.settings.cwd, 'notes.txt')}))?.block, true);
  assert.equal((await f.gate('write', {path:'notes.txt'}))?.block, true);
  f.settings.outputDirs = [join(f.home, 'profiles/owl/artifacts')]; mkdirSync(f.settings.outputDirs[0], {recursive:true});
  assert.equal(await f.gate('write', {path:join(f.settings.outputDirs[0], 'notes.txt')}), undefined);
  f.settings.cwd = f.home + '-workspace'; mkdirSync(f.settings.cwd); t.after(() => rmSync(f.settings.cwd, {recursive:true, force:true}));
  assert.equal(await f.gate('write', {path:join(f.settings.cwd, 'notes.txt')}), undefined);
  assert.equal(f.choices.length, 0);
});

test('SSH public files stay readable, private keys and auth stores do not, and children get no secrets', t => {
  const f = fixture(t);
  for (const name of ['known_hosts', 'config', 'id_ed25519.pub']) assert.equal(credentialPath(join(homedir(), '.ssh', name), f.home), false);
  assert.equal(credentialPath(join(f.home, 'profiles/owl/pi/mcp-auth.json'), f.home), true);
  for (const name of ['id_ed25519', 'work.pem', 'deploy.key']) assert.equal(credentialPath(join(homedir(), '.ssh', name), f.home), true);
  assert.equal(credentialPath(join(f.home, 'desktop-data/Local Storage/token'), f.home), true);
  assert.equal(credentialPath(join(f.home, '../connect.json'), f.home), false);
  assert.equal(credentialPath(join(homedir(), '.codex/auth.json'), f.home), true);
  assert.deepEqual(shellEnvironment({SSH_AUTH_SOCK:'/tmp/agent', AWS_PROFILE:'secret', AWS_SECRET_ACCESS_KEY:'secret', GOOGLE_APPLICATION_CREDENTIALS:'secret', GOOGLE_CLOUD_PROJECT:'secret', CLOUDSDK_CONFIG:'secret'}), {SSH_AUTH_SOCK:'/tmp/agent'});
  const env = Object.fromEntries(['HTTP_PROXY', 'https_proxy', 'No_Proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'].map(k => [k, 'fixture']));
  assert.deepEqual(shellEnvironment({...env, NODE_OPTIONS:'bad'}), env);
});

test('user bash runs in the sandbox with a sanitized environment outside Bypass', async t => {
  const f = fixture(t, 'smart', ['terminal']);
  const permitted = await f.handlers.user_bash({command:'env'}, f.ctx);
  let output = '';
  const result = await permitted.operations.exec('env', f.home, {env:{PATH:process.env.PATH, OPENAI_API_KEY:'secret'}, onData:data => output += data});
  assert.equal(result.exitCode, 0); assert.doesNotMatch(output, /OPENAI_API_KEY|secret/);
});

test('execution refuses a call whose mode or file changed after the gate allowed it', async t => {
  const f = fixture(t, 'off', ['terminal', 'file']);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-work-'))); t.after(() => rmSync(work, {recursive:true, force:true}));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-outside-'))); t.after(() => rmSync(outside, {recursive:true, force:true}));
  f.settings.cwd = work;
  // Pi gates parallel calls before running them: a Bypass decision must not run after Manual is chosen.
  assert.equal(await f.gate('bash', {command:'echo plain'}, 'early'), undefined);
  f.settings.approvalMode = 'manual';
  await assert.rejects(f.tools.bash.execute('early', {command:'echo plain'}, undefined, undefined, f.ctx), /approval mode changed/);
  // A call checked for one working directory does not run in another.
  assert.equal(await f.gate('bash', {command:'echo moved'}, 'moved'), undefined);
  f.settings.cwd = outside;
  await assert.rejects(f.tools.bash.execute('moved', {command:'echo moved'}, undefined, undefined, f.ctx), /working directory changed/);
  f.settings.cwd = work;
  // An unchecked call never runs.
  await assert.rejects(f.tools.bash.execute('unknown', {command:'echo plain'}, undefined, undefined, f.ctx), /Try again/);
  // Auto approved a write inside the workspace; a link swapped to point outside is refused.
  f.settings.approvalMode = 'smart';
  mkdirSync(join(work, 'dir'));
  symlinkSync(join(work, 'dir'), join(work, 'link'));
  assert.equal(await f.gate('write', {path:'link/note.txt', content:'x'}, 'swap'), undefined);
  rmSync(join(work, 'link')); symlinkSync(outside, join(work, 'link'));
  await assert.rejects(f.tools.write.execute('swap', {path:'link/note.txt', content:'x'}, undefined, undefined, f.ctx), /file changed/);
  assert.equal(f.choices.length, 0);
});

for (const mode of ['manual', 'smart']) test(`identity keys are blocked by both file guard stages in ${mode}`, async t => {
  const f = fixture(t, mode, ['file']);
  mkdirSync(join(f.home, 'nested'));
  for (const name of ['connect-identity.key', 'nested/connect-identity.key']) {
    const path = join(f.home, name);
    writeFileSync(path, 'private key');
    assert.equal(credentialPath(path, f.home), true);
    assert.equal((await f.gate('read', {path}))?.block, true);
    await assert.rejects(f.swap('read', {path:join(f.home, 'safe.txt')}, {path}), /Credential/);
  }
  assert.equal(credentialPath(join(f.home, '../connect-identity.key'), f.home), false);
});

test('connected servers register once in memory and never for legacy or restricted sections', async t => {
  const f = fixture(t, 'smart', [], {mcpServers:['demo']});
  await f.handlers.session_start({}, f.ctx);
  assert.deepEqual(f.activeTools, [['codemode']]);
  f.ctx.servers = [{name:'demo',config:{command:'node',env:{TOKEN:'!bad $HOME ${KEY} $$'},headers:{Authorization:'!secret'},exposure:'codemode'}}];
  for (let n = 0; n < 2; n++) assert.deepEqual(await f.handlers.before_agent_start({}, f.ctx), {systemPrompt:'Frozen prompt'});
  assert.equal(f.requests.filter(r => r.name === 'hexbot_mcp_servers').length, 1);
  assert.equal(f.activeTools.length, 1);
  assert.deepEqual(f.registrations, [{name:'demo',config:{...f.ctx.servers[0].config,env:{TOKEN:'$!bad $$HOME $${KEY} $$$$'},headers:{Authorization:'$!secret'}}}]);
  for (const extra of [{}, {mcpServers:[]}, {mcpServers:['demo'],restricted:[]}]) {
    const f = fixture(t, 'smart', [], extra);
    await f.handlers.session_start({}, f.ctx);
    assert.deepEqual(f.activeTools, []);
    await f.handlers.before_agent_start({}, f.ctx);
    assert.equal(f.requests.some(r => r.name === 'hexbot_mcp_servers'), false);
  }
});

test('escaped server values survive Pi resolution without commands or substitutions', async () => {
  const {resolveConfigValue} = await import('./node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js');
  for (const value of ['!exit 99', '$HOME', '${HOME}', '$!literal', '$$HOME', '!echo $HOME', '', 'plain']) {
    assert.equal(resolveConfigValue(escapeMcpValues({value}).value), value);
  }
});

test('tools recover when Stop stops cancelling the settings bridge', async t => {
  const f = fixture(t, 'off', ['file', 'terminal'], {mcpServers:['fixture']});
  await f.handlers.before_agent_start({}, f.ctx);
  const input = f.ctx.ui.input;
  let stopped = true;
  f.ctx.ui.input = title => stopped && title.includes('hexbot_session_settings') ? undefined : input(title);
  const calls = [
    ['bash', {command:'pwd'}],
    ...['read', 'write', 'edit', 'grep', 'find', 'ls'].map(name => [name, {path:f.home}]),
    ['mcp__fixture__read', {}],
    ['codemode', {code:'mcp__fixture__read({})'}],
  ];
  for (const [name, args] of calls) assert.equal((await f.gate(name, args))?.block, true, name);
  stopped = false;
  for (const [name, args] of calls) assert.equal(await f.gate(name, args), undefined, name);
});

test('connected tool approvals follow annotations and allow a whole server only when chosen', async t => {
  for (const mode of ['manual', 'smart', 'off']) {
    const f = fixture(t, mode, [], {mcpServers:['a__long-name','b']});
    await f.handlers.before_agent_start({}, f.ctx);
    const name = 'mcp__a__long_name__change';
    f.tools[name] = {name,namespace:{name:'mcp__a__long_name'}};
    assert.equal(await f.gate('codemode', {code:'anything'}), undefined);
    for (const annotations of [undefined, {readOnlyHint:false}, {readOnlyHint:true}]) {
      f.tools[name].annotations = annotations;
      assert.equal((await f.gate(name, {}))?.block, mode === 'off' || mode === 'smart' && annotations?.readOnlyHint === true ? undefined : true);
    }
    f.tools[name].annotations = undefined;
    f.ctx.choice = 'once';
    assert.equal(await f.gate(name, {}), undefined);
    f.ctx.choice = 'deny';
    assert.equal((await f.gate(name, {}))?.block, mode === 'off' ? undefined : true);
    f.ctx.choice = 'session';
    assert.equal(await f.gate(name, {}), undefined);
    f.ctx.choice = 'deny';
    // Auto reviews each call instead of remembering the server.
    assert.equal((await f.gate(name, {}))?.block, mode === 'smart' ? true : undefined);
    assert.equal((await f.gate('mcp__b__change', {}))?.block, mode === 'off' ? undefined : true);
    if (mode !== 'off') assert.match(f.choices[0].command, /^a__long-name\/change/);
    assert.equal(await f.gate('read_mcp_resource', {}), undefined);
  }
});

test('nested codemode calls use the same gate and execution id as direct calls', async t => {
  const f = fixture(t, 'smart', ['terminal','file']);
  const event = {toolName:'bash',toolCallId:'c1/1',parentToolCallId:'c1',input:{command:'echo nested',full_access:true}};
  assert.equal((await f.handlers.tool_call(event, f.ctx)).block, true);
  f.ctx.choice = 'once';
  assert.equal(await f.handlers.tool_call(event, f.ctx), undefined);
  assert.match(JSON.stringify(await f.tools.bash.execute('c1/1', event.input)), /nested/);
  f.ctx.choice = 'deny';
  assert.equal((await f.handlers.tool_call({...event,toolName:'write',toolCallId:'c1/2',input:{path:'/usr/local/hexbot-nested.txt',content:'x'}},f.ctx)).block, true);
});


test('connected tools revoke current clients in every mode and reconnect only at a prompt boundary', async t => {
  for (const mode of ['smart', 'manual', 'off']) {
    const f = fixture(t, mode, [], {mcpServers:['demo']});
    f.ctx.choice = 'once';
    await f.handlers.before_agent_start({}, f.ctx);
    const call = {toolName:'mcp__demo__read',toolCallId:'code/1',parentToolCallId:'code',input:{}};
    f.tools[call.toolName] = {name:call.toolName,annotations:{readOnlyHint:true}};
    assert.equal(await f.handlers.tool_call(call, f.ctx), undefined);
    delete f.settings.mcpState.demo;
    assert.match((await f.handlers.tool_call(call, f.ctx)).reason, /removed or disabled/);
    f.settings.mcpState.demo = {revision:'changed'};
    assert.match((await f.handlers.tool_call(call, f.ctx)).reason, /changed/);
    f.ctx.servers = [{name:'demo',revision:'changed',config:{command:'node',env:{TOKEN:'new'}}}];
    await f.handlers.before_agent_start({}, f.ctx);
    assert.equal(await f.handlers.tool_call(call, f.ctx), undefined);
    assert.equal(f.registrations.at(-1).config.env.TOKEN, 'new');
    assert.equal(f.activeTools.length, 0);
  }
});

test('connected approvals recheck mode and revocation after the answer, and hidden sections deny immediately', async t => {
  const f = fixture(t, 'manual', [], {mcpServers:['demo']});
  await f.handlers.before_agent_start({}, f.ctx);
  f.ctx.ui.select = async () => { f.settings.approvalMode = 'smart'; return 'once'; };
  assert.match((await f.gate('mcp__demo__read', {})).reason, /mode changed/);
  f.ctx.ui.select = async () => { delete f.settings.mcpState.demo; return 'once'; };
  assert.match((await f.gate('mcp__demo__read', {})).reason, /removed or disabled/);
  f.settings.mcpState.demo = {revision:'initial'};
  f.settings.canAsk = false;
  assert.match((await f.gate('mcp__demo__read', {})).reason, /visible section/);
});

test('jobs and delegates deny file, shell and browser approvals without opening a dialog', async t => {
  for (const mode of ['smart', 'manual']) {
    for (const extra of [{job:'job-1'}, {parent_session:'job-root', job:'job-1'}]) {
      const f = fixture(t, mode, ['file', 'terminal'], {...extra, canAsk:false});
      // Temp folders are workspace roots too. Only gate these home paths;
      // no tool executes or creates a file there.
      const outside = join(homedir(), 'hexbot-outside-work');
      f.settings.cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-approval-work-')));
      t.after(() => rmSync(f.settings.cwd, {recursive:true, force:true}));
      const calls = [
        ['write', {path:join(outside, 'note.txt'), content:'Changed'}],
        ['edit', {path:join(outside, 'note.txt'), oldText:'Old', newText:'Changed'}],
        ['write', {path:join(homedir(), '.bashrc'), content:'Changed'}],
        ['bash', {command:'echo hello', full_access:true, reason:'Needs network'}],
        ['browser_console', {expression:'document.title'}],
      ];
      if (mode === 'manual') calls.push(['write', {path:join(f.settings.cwd, 'note.txt'), content:'Changed'}]);
      for (const [name, input] of calls) {
        const denied = await f.gate(name, input);
        assert.equal(denied?.block, true, name);
        assert.match(denied.reason, /needs approval.*visible section/, name);
      }
      assert.equal(f.choices.length, 0);
      assert.equal(await f.gate('bash', {command:'echo confined'}), undefined);
      assert.equal(await f.gate('read', {path:join(f.settings.cwd, 'note.txt')}), undefined);
      if (mode === 'smart') assert.equal(await f.gate('write', {path:join(f.settings.cwd, 'note.txt'), content:'Allowed'}), undefined);
    }
  }
});

test('a prior section approval cannot let an unattended call run', async t => {
  const f = fixture(t, 'smart', ['terminal']);
  f.ctx.choice = 'session';
  const input = {command:'echo hello', full_access:true, reason:'Needs network'};
  assert.equal(await f.gate('bash', input), undefined);
  f.settings.canAsk = false;
  assert.match((await f.gate('bash', input)).reason, /needs approval.*visible section/);
  assert.equal(f.choices.length, 1);
});

test('a script naming a revoked server is blocked with a plain reason', async t => {
  const f = fixture(t, 'off', [], {mcpServers:['demo-x']});
  await f.handlers.before_agent_start({}, f.ctx);
  assert.equal(await f.gate('codemode', {code:'await tools.mcp__demo_x__read({})'}), undefined);
  delete f.settings.mcpState['demo-x'];
  assert.match((await f.gate('codemode', {code:'await tools.mcp__demo_x__read({})'})).reason, /removed or disabled/);
  assert.equal(await f.gate('codemode', {code:'text(1)'}), undefined);
});

test('an interrupted first registration retries on the next prompt', async t => {
  const f = fixture(t, 'smart', [], {mcpServers:['demo']});
  const input = f.ctx.ui.input;
  f.ctx.ui.input = async title => title.includes('hexbot_mcp_servers') ? undefined : input(title);
  await f.handlers.before_agent_start({}, f.ctx);
  assert.equal(f.registrations.length, 0);
  f.ctx.ui.input = input;
  await f.handlers.before_agent_start({}, f.ctx);
  assert.equal(f.registrations.length, 1);
});

test('resource reads stop when their server is revoked or changed, without asking', async t => {
  const f = fixture(t, 'manual', [], {mcpServers:['demo','other']});
  await f.handlers.before_agent_start({}, f.ctx);
  const read = {toolName:'read_mcp_resource',toolCallId:'code/1',parentToolCallId:'code',input:{server:'demo',uri:'demo://a'}};
  const list = {toolName:'list_mcp_resources',toolCallId:'code/2',parentToolCallId:'code',input:{}};
  assert.equal(await f.handlers.tool_call(read, f.ctx), undefined);
  assert.equal(await f.handlers.tool_call(list, f.ctx), undefined);
  assert.equal(f.choices.length, 0);
  f.settings.mcpState.demo = {revision:'changed'};
  assert.match((await f.handlers.tool_call(read, f.ctx)).reason, /changed/);
  assert.match((await f.handlers.tool_call(list, f.ctx)).reason, /changed/);
  assert.equal(await f.handlers.tool_call({...read,input:{server:'other',uri:'other://a'}}, f.ctx), undefined);
  delete f.settings.mcpState.demo;
  assert.match((await f.handlers.tool_call(read, f.ctx)).reason, /removed or disabled/);
});

// Rust caps a job's live policy at Auto even if its frozen config says Bypass.
// Exercise that live policy at the file gate and the shell execution boundary.
test('a job capped at Auto protects memory and soul even with frozen Bypass', {skip: process.platform !== 'darwin'}, async t => {
  const f = fixture(t, 'smart', ['file', 'terminal'], {approvalMode:'off', job:'job-1', canAsk:false});
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-job-work-')));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  f.settings.cwd = work;
  mkdirSync(join(f.home, 'profiles/owl/memories'), {recursive:true});
  for (const file of ['profiles/owl/memories/MEMORY.md', 'profiles/owl/SOUL.md']) {
    const path = join(f.home, file);
    writeFileSync(path, 'Original');
    for (const name of ['write', 'edit']) {
      const denied = await f.run(name, {path, content:'Changed', oldText:'Original', newText:'Changed'});
      assert.equal(denied.block, true);
      assert.match(denied.reason, /protected/);
    }
    const result = await f.run('bash', {command:`printf Changed > '${path}'`});
    assert.equal(result.isError, true);
    assert.equal(readFileSync(path, 'utf8'), 'Original');
  }
});

test('file writes protect gitdir and commondir targets outside the worktree and bare repositories', async t => {
  const {writeDenial} = await import('./extension.ts');
  const {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-git-files-')));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const work = join(root, 'work'), home = join(root, 'home');
  for (const path of [work, home, join(root, 'metadata'), join(root, 'common'), join(work, 'bare.git'), join(work, 'subdir')]) mkdirSync(path, {recursive:true});
  mkdirSync(join(work, 'bare.git/objects'), {recursive:true});
  writeFileSync(join(work, 'bare.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(work, '.git'), 'gitdir: ../metadata\n');
  writeFileSync(join(root, 'metadata/commondir'), '../common\n');
  for (const path of ['metadata/hooks/pre-commit', 'common/config', 'work/bare.git/config']) assert.match(writeDenial(join(root, path), join(work, 'subdir'), home), /protected|read-only/);
  assert.equal(writeDenial(join(work, 'notes'), work, home), undefined);
});

test('an exhausted safety scan blocks the command and requires an approved full-access retry', async t => {
  const f = fixture(t, 'smart', ['terminal']);
  const work = mkdtempSync(join(tmpdir(), 'hexbot-budget-'));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  f.settings.cwd = work;
  for (let i = 0; i < 1001; i++) mkdirSync(join(work, String(i)));
  const command = await f.gate('bash', {command:'echo harmless'});
  if (process.platform === 'linux') assert.match(command.reason, /budget.*approval/);
  else assert.equal(command, undefined);
  assert.equal(f.choices.length, 0);
  f.ctx.choice = 'once';
  assert.equal(await f.gate('bash', {command:'echo harmless', full_access:true, reason:'The safety scan exceeded its budget.'}), undefined);
  assert.match(f.choices[0].reason, /outside the sandbox/);
});

test('file tools ask and can write and edit when a workspace scan is incomplete', async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-file-scan-')));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const f = fixture(t, 'smart', ['file'], {cwd:work});
  for (let i = 0; i < 1001; i++) mkdirSync(join(work, String(i)));
  assert.match((await f.gate('write', {path:'notes.git', content:'before'})).reason, /denied/);
  assert.match(f.choices.at(-1).reason, /directory budget/);
  f.ctx.choice = 'once';
  await f.run('write', {path:'notes.git', content:'before'});
  await f.run('edit', {path:'notes.git', edits:[{oldText:'before', newText:'after'}]});
  const {readFileSync} = await import('node:fs');
  assert.equal(readFileSync(join(work, 'notes.git'), 'utf8'), 'after');
  assert.equal(f.choices.length, 3);
  mkdirSync(join(work, '.git'));
  writeFileSync(join(work, '.git/config'), '[broken config');
  f.ctx.choice = 'once';
  await f.run('write', {path:'approved', content:'ok'});
  assert.match(f.choices.at(-1).reason, /could not be scanned/);
  assert.equal(readFileSync(join(work, 'approved'), 'utf8'), 'ok');
});

test('an incomplete scan asks once per file change and never widens a section approval', async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-file-scan-once-')));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const f = fixture(t, 'smart', ['file'], {cwd:work});
  for (let i = 0; i < 1001; i++) mkdirSync(join(work, String(i)));
  // Only once or deny is offered, and a session answer is not remembered.
  f.ctx.choice = 'session';
  for (const path of ['a.txt', 'b.txt']) {
    assert.equal(await f.gate('write', {path, content:'x'}), undefined);
    assert.deepEqual(f.choices.at(-1).options, ['once', 'deny']);
    assert.match(f.choices.at(-1).reason, /directory budget/);
    // An incomplete scan always reaches the user, not the reviewer.
    assert.equal(f.choices.at(-1).review, undefined);
  }
  assert.equal(f.choices.length, 2);
  // Destinations that always ask keep their own reason as well.
  f.ctx.choice = 'deny';
  assert.equal((await f.gate('write', {path:join(homedir(), '.zshrc'), content:'x'})).block, true);
  assert.match(f.choices.at(-1).reason, /shell profile.*directory budget/);
  assert.equal((await f.gate('write', {path:join(homedir(), 'hexbot-outside-' + process.pid), content:'x'})).block, true);
  assert.match(f.choices.at(-1).reason, /outside the workspace.*directory budget/);
  // With a complete scan the change goes to Auto's reviewer again, one at a time.
  for (let i = 0; i < 1001; i++) rmSync(join(work, String(i)), {recursive:true});
  f.ctx.choice = 'session';
  assert.equal(await f.gate('write', {path:join(homedir(), 'hexbot-outside-test-1.txt'), content:'x'}), undefined);
  assert.deepEqual(f.choices.at(-1).options, ['once', 'session', 'deny']);
  assert.equal(f.choices.at(-1).review, true);
  const asked = f.choices.length;
  assert.equal(await f.gate('write', {path:join(homedir(), 'hexbot-outside-test-2.txt'), content:'x'}), undefined);
  assert.equal(f.choices.length, asked + 1);
});

test('on Linux a command asks when a missing Git target would pin a repository or Git is reached through a link', async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-pin-')));
  t.after(() => rmSync(work, {recursive:true, force:true}));
  const f = fixture(t, 'smart', ['terminal'], {cwd:work});
  gitInit(join(work, 'app'), [['core.hooksPath', '.githooks']]);
  const missing = await f.gate('bash', {command:'echo harmless'});
  if (process.platform === 'linux') assert.match(missing.reason, /does not exist yet.*retry with full_access.*mkdir -p/);
  else assert.equal(missing, undefined);
  mkdirSync(join(work, 'app/.githooks'));
  assert.equal(await f.gate('bash', {command:'echo harmless'}), undefined);
  mkdirSync(join(work, 'store'));
  symlinkSync('../store', join(work, 'app/.githooks-link'));
  gitConfig(join(work, 'app'), 'core.hooksPath', '.githooks-link');
  const linked = await f.gate('bash', {command:'echo harmless'});
  if (process.platform === 'linux') assert.match(linked.reason, /symbolic link.*githooks-link/);
  else assert.equal(linked, undefined);
  assert.equal(f.choices.length, 0);
});
