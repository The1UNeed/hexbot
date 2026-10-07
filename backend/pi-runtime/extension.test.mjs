import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import hexbot, {canonicalPath, credentialPath, privatePath, protectedPath, shellEnvironment, sanitizeSearchResult, hostWriteTier, escapeMcpValues} from './extension.ts';

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
    async input(title) {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); requests.push(request);
      if (request.name === 'hexbot_mcp_servers') return JSON.stringify({result:(ctx.servers ?? (config.mcpServers ?? []).map(name => ({name,config:{command:'node'}}))).map(server => ({revision:'initial',...server}))});
      if (request.name === 'hexbot_session_settings') return JSON.stringify({result:settings});
      return JSON.stringify({result:{}});
    },
    notify:(message, type)=>notices.push({message,type}),
    async select(title, options) {choices.push({...JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length)), options}); return ctx.choice ?? 'deny';}
  }};
  const pi = {setActiveTools:names=>activeTools.push(names), getAllTools:()=>Object.values(tools), unregisterMcpServer:()=>{}, registerMcpServer:(name, config)=>registrations.push({name,config}), on:(name,handler)=>handlers[name]=handler, registerTool:tool=>tools[tool.name]=tool, registerProvider(){}, async setModel(model){models.push(model);ctx.model=model;return true;}, sendMessage(message){sent.push(message);}, getThinkingLevel(){}};
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
// A shared bot in someone else's room: the daemon marks the session a guest
// and names its section. Its owner's memory and notes, every About you, and
// every other section's folder (history quotes what the owner read; uploads
// are the owner's) are then out of reach of the file tools, through links too,
// while its soul, its own section's uploads and the rest stay readable.
function ownerFiles(home) {
  mkdirSync(join(home, 'profiles/owl/memories/notes'), {recursive:true});
  mkdirSync(join(home, 'users/alice'), {recursive:true});
  mkdirSync(join(home, 'runtime/sessions/first/attachments'), {recursive:true});
  mkdirSync(join(home, 'runtime/sessions/shared/attachments'), {recursive:true});
  writeFileSync(join(home, 'profiles/owl/memories/MEMORY.md'), 'memory needle');
  writeFileSync(join(home, 'profiles/owl/memories/notes/2026-10-07.md'), 'note needle');
  writeFileSync(join(home, 'users/alice/user.md'), 'about needle');
  writeFileSync(join(home, 'profiles/owl/SOUL.md'), 'soul needle');
  writeFileSync(join(home, 'runtime/sessions/first/conversation.jsonl'), 'history needle');
  writeFileSync(join(home, 'runtime/sessions/shared/attachments/upload.txt'), 'upload needle');
  symlinkSync(join(home, 'profiles/owl/memories/notes/2026-10-07.md'), join(home, 'alias.md'));
  symlinkSync(join(home, 'profiles/owl/memories'), join(home, 'profiles/owl/elsewhere'));
}
const PRIVATE = ['profiles/owl/memories/MEMORY.md', 'profiles/owl/memories/notes/2026-10-07.md', 'profiles/owl/memories/notes', 'profiles/owl/memories', 'users/alice/user.md', 'alias.md', 'profiles/owl/elsewhere/MEMORY.md', 'profiles/owl/elsewhere/notes/2026-10-07.md', 'runtime/sessions/first/conversation.jsonl', 'runtime/sessions/first', 'runtime/sessions'];
const GUEST = {guest:true, session:'shared'};
test('a shared bot in someone else\'s room cannot read its owner\'s memory, notes, any About you or another section', async t => {
  const f = fixture(t, 'smart', ['file'], GUEST);
  ownerFiles(f.home);
  for (const path of PRIVATE) {
    assert.equal(privatePath(join(f.home, path), f.home, 'shared'), true, path);
    for (const tool of ['read', 'ls', 'grep', 'find']) assert.match((await f.gate(tool, {path:join(f.home, path), pattern:'needle'}))?.reason ?? '', /stay out of this room/, `${tool} ${path}`);
    await assert.rejects(f.swap('read', {path:join(f.home, 'profiles/owl/SOUL.md')}, {path:join(f.home, path)}), /stay out of this room/, path);
  }
  for (const path of ['profiles/owl/SOUL.md', 'profiles/owl', 'users/alice', 'profiles/owl/memories.txt', 'runtime/sessions/shared', 'runtime/sessions/shared/attachments/upload.txt']) assert.equal(privatePath(join(f.home, path), f.home, 'shared'), false, path);
  assert.equal(privatePath(join(f.home, 'runtime/sessions/shared/attachments/upload.txt'), f.home, 'sharedx'), true);
  assert.equal(await f.gate('read', {path:join(f.home, 'profiles/owl/SOUL.md')}), undefined);
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, 'profiles/owl/SOUL.md')})), /soul needle/);
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, 'runtime/sessions/shared/attachments/upload.txt')})), /upload needle/);
  const grep = JSON.stringify(await f.run('grep', {path:f.home, pattern:'needle'}));
  assert.doesNotMatch(grep, /memory needle|note needle|about needle|history needle|alias|elsewhere/);
  assert.match(grep, /soul needle/); assert.match(grep, /upload needle/);
  const find = JSON.stringify(await f.run('find', {path:f.home, pattern:'*.md'}));
  assert.doesNotMatch(find, /MEMORY|2026-10-07|user\.md|alias|elsewhere/);
  assert.match(find, /SOUL/);
  const ls = JSON.stringify(await f.run('ls', {path:join(f.home, 'profiles/owl')}));
  assert.doesNotMatch(ls, /memories|elsewhere/);
  assert.match(ls, /SOUL/);
});
test('the owner\'s own sections read memory, notes and About you as before', async t => {
  const f = fixture(t, 'smart', ['file']);
  ownerFiles(f.home);
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, 'runtime/sessions/first/conversation.jsonl')})), /history needle/);
  for (const path of PRIVATE) assert.equal(await f.gate('read', {path:join(f.home, path)}), undefined, path);
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, 'profiles/owl/memories/notes/2026-10-07.md')})), /note needle/);
  assert.match(JSON.stringify(await f.run('grep', {path:f.home, pattern:'needle'})), /note needle/);
});
// The gate judges the path a request names; a guest's read and grep then judge
// the file they opened. A hard link to a note names it by a path the gate does
// not know, and a folder swapped for a link to the notes after the gate's check
// would reach the note by the checked path. An owner session reads by path.
test('a guest\'s read and grep judge the file they opened, not the path that was checked', async t => {
  const {linkSync, renameSync} = await import('node:fs');
  const swapped = async (f, id) => {
    const box = join(f.home, 'box'); mkdirSync(box); writeFileSync(join(box, '2026-10-07.md'), 'box needle');
    assert.equal(await f.gate('read', {path:join(box, '2026-10-07.md')}, id), undefined);
    // Without a context the wrapper checks the path before its first await; the
    // swap lands before Pi opens the file.
    const pending = f.tools.read.execute(id, {path:join(box, '2026-10-07.md')}, undefined, undefined, undefined);
    renameSync(box, box + '-old'); symlinkSync(join(f.home, 'profiles/owl/memories/notes'), box);
    return pending;
  };
  const f = fixture(t, 'smart', ['file'], GUEST);
  ownerFiles(f.home);
  const plain = join(f.home, 'plain.md'); linkSync(join(f.home, 'profiles/owl/memories/notes/2026-10-07.md'), plain);
  assert.equal(await f.gate('read', {path:plain}), undefined);
  await assert.rejects(f.run('read', {path:plain}), /stay out of this room/);
  const grep = JSON.stringify(await f.run('grep', {path:f.home, pattern:'needle'}));
  assert.doesNotMatch(grep, /note needle|plain/); assert.match(grep, /soul needle/);
  const find = JSON.stringify(await f.run('find', {path:f.home, pattern:'*.md'}));
  assert.doesNotMatch(find, /plain/); assert.match(find, /SOUL/);
  assert.match(JSON.stringify(await f.run('read', {path:join(f.home, 'runtime/sessions/shared/attachments/upload.txt')})), /upload needle/);
  await assert.rejects(swapped(f, 'swap-guest'), /stay out of this room/);
  const owner = fixture(t, 'smart', ['file']);
  ownerFiles(owner.home);
  assert.match(JSON.stringify(await swapped(owner, 'swap-owner')), /note needle/);
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
    hexbot({on() {}, registerProvider() {}, registerTool(value) {tool = value;}});
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
    hexbot({on: (event, callback) => handlers.set(event, callback), registerProvider: (name, value) => providers.set(name, value)});
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
  assert.deepEqual(f.choices[0], {tool:'bash', command:'npm install', reason:'Run outside the sandbox, with internet access and writes outside the workspace. Downloads the dependencies.', options:['once', 'session', 'deny']});
  // The temp folders are part of the workspace; /usr/local is not.
  assert.equal(await f.gate('write', {path:join(user, 'scratch.txt')}), undefined);
  assert.equal((await f.gate('write', {path:'/usr/local/hexbot-elsewhere.txt'}))?.block, true);
  assert.match(f.choices[1].reason, /outside the workspace/);
  assert.equal(f.choices[1].command, '/usr/local/hexbot-elsewhere.txt');
  // A workspace that holds shell profiles still asks before changing them.
  f.settings.cwd = user;
  assert.equal(await f.gate('write', {path:join(user, 'notes.txt')}), undefined);
  assert.equal((await f.gate('write', {path:join(user, '.zshrc')}))?.block, true);
  assert.match(f.choices[2].reason, /shell profile/);
  assert.equal(f.choices.length, 3);
  // Allowing outside files for the section does not cover shell profiles.
  f.settings.cwd = join(user, 'Hexbot');
  f.ctx.choice = 'session';
  assert.equal(await f.gate('write', {path:'/usr/local/hexbot-elsewhere.txt'}), undefined);
  f.ctx.choice = 'deny';
  assert.equal(await f.gate('write', {path:'/usr/local/hexbot-other.txt'}), undefined);
  assert.equal((await f.gate('write', {path:join(user, '.zshrc')}))?.block, true);
  assert.equal(f.choices.length, 5);
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
  assert.equal((await f.gate('browser_console', {expression:'document.title'}))?.block, true);
  assert.equal(await f.gate('browser_console', {}), undefined);
  for (const name of ['memory', 'hexbot_soul', 'message_bot', 'cronjob_manage', 'execute_code']) assert.equal(await f.gate(name, {}), undefined);
  assert.equal(f.choices.length, 3);
  f.ctx.choice = 'once';
  assert.equal(await f.gate('edit', {path:'notes.txt'}), undefined);
});

test('allowing for the section covers later requests of the same kind only', async t => {
  const f = fixture(t, 'smart', ['terminal']);
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
  writeFileSync(config, JSON.stringify({home, cwd:home, prompt:'p', tools:[], enabledToolsets:[], provider:'test', model:'m'}));
  const script = `Object.defineProperty(process, 'platform', {value:'linux'});
    const {default: hexbot} = await import(${JSON.stringify(new URL('./extension.ts', import.meta.url).href)});
    const handlers = {}, choices = [];
    const settings = {approvalMode:'manual'};
    const ctx = {choice:'deny', ui:{
      async input(title) {const r = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); if (r.name === 'hexbot_session_settings') return JSON.stringify({result:settings}); return JSON.stringify({result:{}});},
      async select(title) {choices.push(JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length))); return ctx.choice;}
    }};
    hexbot({on:(name, handler) => handlers[name] = handler, registerTool() {}, registerProvider() {}});
    const gate = command => handlers.tool_call({toolName:'bash', input:{command}}, ctx);
    const out = {};
    out.manualDenied = (await gate('echo hi'))?.block === true;
    settings.approvalMode = 'smart';
    out.smartDenied = (await gate('ls'))?.block === true;
    out.reason = choices[0].reason;
    ctx.choice = 'session';
    out.sessionPasses = (await gate('echo hi')) === undefined;
    ctx.choice = 'deny';
    out.afterSession = (await gate('echo again')) === undefined;
    out.asked = choices.length;
    settings.approvalMode = 'off';
    out.offPasses = (await gate('pwd')) === undefined;
    // A guest session is refused instead, with no card, even after Allow in
    // this section; its user's own commands too. Bypass is unchanged.
    settings.approvalMode = 'smart'; settings.guest = true; settings.session = 'shared';
    out.guestRefused = (await gate('ls'))?.reason;
    out.guestUserBash = (await handlers.user_bash({command:'ls'}, ctx)).result?.output;
    out.guestAsked = choices.length;
    settings.approvalMode = 'off';
    out.guestOffPasses = (await gate('pwd')) === undefined;
    console.log(JSON.stringify(out));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env:{...process.env, PATH:home, HEXBOT_SESSION_CONFIG:config}, encoding:'utf8'}));
  const refusal = "Hexbot has no OS sandbox on this system, so a shared bot cannot run commands or code in someone else's room. Install bubblewrap and restart the daemon.";
  assert.deepEqual(result, {manualDenied:true, smartDenied:true, reason:result.reason, sessionPasses:true, afterSession:true, asked:3, offPasses:true, guestRefused:refusal, guestUserBash:refusal, guestAsked:3, guestOffPasses:true});
  assert.match(result.reason, /no OS sandbox/);
});

// The Data volume's firmlink alias of a path (/System/Volumes/Data/...) is
// another spelling that resolving leaves as it is; the folders' identity
// catches it, for the file tools and for grep's reads.
test('a macOS firmlink alias of the home cannot disguise a private file', {skip: process.platform !== 'darwin'}, async t => {
  const f = fixture(t, 'smart', ['file'], GUEST);
  ownerFiles(f.home);
  const alias = '/System/Volumes/Data' + realpathSync(f.home);
  if (!existsSync(alias)) return t.skip('no Data volume alias of the temp folder');
  assert.equal(canonicalPath(join(alias, 'users/alice/user.md'), f.home), join(alias, 'users/alice/user.md'));
  for (const path of ['users/alice/user.md', 'profiles/owl/memories/notes/2026-10-07.md', 'profiles/owl/memories', 'runtime/sessions/first/conversation.jsonl']) {
    assert.equal(privatePath(join(alias, path), f.home, 'shared'), true, path);
    assert.match((await f.gate('read', {path:join(alias, path)}))?.reason ?? '', /stay out of this room/, path);
  }
  for (const path of ['profiles/owl/SOUL.md', 'runtime/sessions/shared/attachments/upload.txt']) assert.equal(privatePath(join(alias, path), f.home, 'shared'), false, path);
  const grep = JSON.stringify(await f.run('grep', {path:alias, pattern:'needle'}));
  assert.doesNotMatch(grep, /memory needle|note needle|about needle|history needle/);
  assert.match(grep, /soul needle/);
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

// The guest session's sandbox hides the same files its file tools refuse, for
// the bot's commands and the user's own `!` commands; the owner's sessions read
// them. The shim on Linux applies no sandbox, so only macOS runs this;
// isolation.test.mjs covers bubblewrap.
test('a shared bot\'s shell in someone else\'s room cannot read its owner\'s memory, notes or any About you', {skip: process.platform !== 'darwin'}, async t => {
  for (const guest of [true, false]) {
    const f = fixture(t, 'smart', ['terminal'], guest ? GUEST : {});
    ownerFiles(f.home);
    f.ctx.choice = 'once';
    const read = async (path, extra = {}) => { try { return JSON.stringify(await f.run('bash', {command:`cat '${join(f.home, path)}'`, ...extra})); } catch (error) { return error.message; } };
    for (const path of ['profiles/owl/memories/MEMORY.md', 'profiles/owl/memories/notes/2026-10-07.md', 'users/alice/user.md', 'alias.md', 'runtime/sessions/first/conversation.jsonl']) {
      if (guest) assert.doesNotMatch(await read(path), /needle/, path); else assert.match(await read(path), /needle/, path);
    }
    assert.match(await read('profiles/owl/SOUL.md'), /soul needle/);
    assert.match(await read('runtime/sessions/shared/attachments/upload.txt'), /upload needle/);
    const permitted = await f.handlers.user_bash({command:'cat'}, f.ctx);
    let output = '';
    await permitted.operations.exec(`cat '${join(f.home, 'profiles/owl/memories/MEMORY.md')}' '${join(f.home, 'profiles/owl/SOUL.md')}' 2>/dev/null`, f.home, {env:{PATH:process.env.PATH}, onData:data => output += data});
    if (guest) assert.doesNotMatch(output, /memory needle/); else assert.match(output, /memory needle/);
    assert.match(output, /soul needle/);
  }
});

// Full access would run outside the workspace sandbox, where a service broker
// on the host can start a reader outside any sandbox, so a guest session never
// gets it: the request is refused before any approval card, in every mode, and
// a failed sandboxed command is not told to ask for it. Owner sessions ask as
// before, and the frozen bash schema keeps its fields.
test('full access is not available to a shared bot in someone else\'s room', async t => {
  const refusal = "Full access is not available to a shared bot in someone else's room.";
  const input = {command:'echo failed; exit 7', full_access:true, reason:'Needs the internet.'};
  const guest = fixture(t, 'smart', ['terminal'], GUEST);
  guest.ctx.choice = 'once';
  for (const mode of ['smart', 'manual']) {
    guest.settings.approvalMode = mode;
    assert.deepEqual(await guest.gate('bash', input), {block:true, reason:refusal});
    const result = await guest.run('bash', {command:'echo failed; exit 7'});
    assert.equal(result.structuredContent.exit_code, 7);
    const text = result.content.map(item => item.text).join('\n');
    assert.match(text, /Full access is not available/); assert.doesNotMatch(text, /run it again with full_access/);
  }
  assert.deepEqual(guest.choices, []);
  assert.ok(guest.tools.bash.parameters.properties.full_access);
  const owner = fixture(t, 'smart', ['terminal']);
  owner.ctx.choice = 'once';
  assert.equal(await owner.gate('bash', input), undefined);
  assert.equal(owner.choices.length, 1); assert.match(owner.choices[0].reason, /Needs the internet/);
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
    assert.equal(await f.gate(name, {}), undefined);
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

// Old tool output is cleared once, shortly before Pi would compact. The
// conversation is Pi's own in-memory session, so the drafts the handler returns
// go through Pi's context_edit validation and projection.
const user = text => ({role:'user', content:text, timestamp:1});
const assistant = call => ({role:'assistant', content: call ? [{type:'toolCall', id:call, name:call, arguments:{}}] : [{type:'text', text:'Done.'}],
  api:'test', provider:'test', model:'primary', usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason: call ? 'toolUse' : 'stop', timestamp:1});
const result = (tool, chars) => ({role:'toolResult', toolCallId:tool, toolName:tool, content:[{type:'text', text:'x'.repeat(chars)}], isError:false, timestamp:1});
function conversation(messages) {
  const manager = SessionManager.inMemory('/tmp');
  const ids = {};
  for (const message of messages) {
    const id = manager.appendMessage(message);
    if (message.role === 'toolResult') ids[message.toolName] = id;
  }
  const turn = (f, tokens, entries = []) => f.handlers.turn_end({message:{stopReason:'stop'}, entries, context:{contextEntries: manager.buildSessionProjection().entries}}, {...f.ctx, getContextUsage:() => ({tokens, contextWindow:32768, percent:tokens / 32768 * 100})});
  const visible = () => Object.fromEntries(manager.buildSessionProjection().entries.filter(e => e.sourceEntry.type === 'message' && e.sourceEntry.message.role === 'toolResult').map(e => [e.sourceEntry.message.toolName, e.messages[0].content[0].text.length]));
  return {manager, ids, turn, visible};
}
function trimFixture(t, compaction) {
  // The settings are read when the extension loads, so the file comes first.
  const agentDir = mkdtempSync(join(tmpdir(), 'hexbot-agent-'));
  t.after(() => rmSync(agentDir, {recursive:true, force:true}));
  if (compaction) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({theme:'dark', compaction}));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  return {...fixture(t), agentDir};
}
// Reserve 8,192 for this model: Pi compacts at 24,576 of 32,768, so the trim
// line is 21,299 and a trim must land under 17,203.
const overrides = {enabled:true, reserveTokens:16384, keepRecentTokens:20000, modelOverrides:{'test/primary':{reserveTokens:8192, keepRecentTokens:8192}}};
// Four user messages. Only read and web_extract are old, large, and not verbatim.
const history = [result('early', 20000), user('Look through the project'),
  assistant('read'), result('read', 20000), assistant('clarify'), result('clarify', 8000), assistant('bash'), result('bash', 800),
  assistant('memory'), result('memory', 8000), assistant('web_extract'), result('web_extract', 16000), assistant('skill_view'), result('skill_view', 8000), assistant(),
  user('Go on'), assistant('grep'), result('grep', 16000), assistant(),
  user('And the rest'), assistant('ls'), result('ls', 16000), assistant(),
  user('Thanks'), assistant()];

test('crossing the trim line clears old tool output once and keeps protected results', async t => {
  const f = trimFixture(t, overrides);
  const c = conversation(history);
  assert.equal(await c.turn(f, 15000), undefined);
  assert.equal(await c.turn(f, 21000), undefined);
  const before = structuredClone(c.manager.getEntry(c.ids.read));
  const reply = await c.turn(f, 21500, [{type:'custom', customType:'other'}]);
  assert.deepEqual(reply.entries.map(e => e.type), ['custom', 'context_edit', 'context_edit']);
  assert.deepEqual(reply.entries.slice(1).map(e => e.targetId), [c.ids.read, c.ids.web_extract]);
  for (const edit of reply.entries.slice(1)) c.manager.appendContextEdit(edit.targetId, edit.replacement);
  const visible = c.visible();
  assert.ok(visible.read < 200 && visible.web_extract < 200, JSON.stringify(visible));
  assert.deepEqual([visible.early, visible.clarify, visible.bash, visible.memory, visible.skill_view, visible.grep, visible.ls], [20000, 8000, 800, 8000, 8000, 16000, 16000]);
  assert.match(c.manager.buildSessionProjection().messages.find(m => m.role === 'toolResult' && m.toolName === 'read').content[0].text, /20,000 characters.*cleared/);
  assert.deepEqual(c.manager.getEntry(c.ids.read), before);
  // Still over the line: nothing more until usage drops and crosses again.
  assert.equal(await c.turn(f, 22000), undefined);
  assert.equal(await c.turn(f, 12000), undefined);
  // Four more user messages: grep, ls and the new find result are now behind the third most recent.
  for (const message of [user('Find the tests'), assistant('find'), result('find', 20000), assistant(), user('ok'), assistant(), user('ok'), assistant(), user('ok'), assistant()]) c.ids[message.toolName] = c.manager.appendMessage(message);
  assert.deepEqual((await c.turn(f, 22000)).entries.map(e => e.targetId), [c.ids.grep, c.ids.ls, c.ids.find]);
});
test('a long run under one user message is never trimmed, and its results age by user messages', async t => {
  const f = trimFixture(t, overrides);
  const rounds = [user('Look through everything')];
  for (let i = 0; i < 12; i++) rounds.push(assistant('read'), {...result('read', 20000), toolName:`read${i}`, toolCallId:`read${i}`});
  rounds.push(assistant());
  const c = conversation(rounds);
  // Pi ends a turn after every tool round; the bot is still using these reads.
  assert.equal(await c.turn(f, 23000), undefined);
  for (const message of [user('Go on'), assistant(), user('And then'), assistant()]) c.manager.appendMessage(message);
  assert.equal(await c.turn(f, 23000), undefined, 'the third most recent user message is the first one');
  c.manager.appendMessage(user('Thanks')); c.manager.appendMessage(assistant());
  assert.equal((await c.turn(f, 23000)).entries.length, 12);
});
test('no trim when it would not bring usage well under the compaction point, and the check stays armed', async t => {
  const f = trimFixture(t, overrides);
  const c = conversation([user('Hi'), assistant('read'), result('read', 20000), assistant(), user('Go on'), assistant(), user('More'), assistant()]);
  // read is since the third most recent user message, so nothing can be cleared.
  assert.equal(await c.turn(f, 23000), undefined);
  c.manager.appendMessage(user('And')); c.manager.appendMessage(assistant());
  assert.equal(await c.turn(f, 23000), undefined, 'clearing 5,000 tokens from 23,000 stays over 17,203');
  assert.deepEqual((await c.turn(f, 21500)).entries.map(e => e.targetId), [c.ids.read]);
});
test('the trim line follows the global reserve when the model has no override', async t => {
  const f = trimFixture(t, {...overrides, modelOverrides:{}});
  const c = conversation(history);
  // Compaction at 16,384, the line at 13,107.
  assert.equal(await c.turn(f, 13000), undefined);
  assert.equal((await c.turn(f, 13500)).entries.length, 2);
  const g = trimFixture(t, {...overrides, enabled:false});
  assert.equal(await conversation(history).turn(g, 30000), undefined);
  // A reserve larger than the window cannot put the point under half of it.
  const h = trimFixture(t, {...overrides, modelOverrides:{'test/primary':{reserveTokens:30000}}});
  assert.equal(await conversation(history).turn(h, 12000), undefined);
  assert.equal((await conversation(history).turn(h, 13500)).entries.length, 2);
});
test('the compaction settings are the ones this process started with', async t => {
  const f = trimFixture(t, overrides);
  // The daemon rewrites the file for a later section; Pi keeps what it loaded.
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({compaction:{...overrides, modelOverrides:{}}}));
  const c = conversation(history);
  assert.equal(await c.turn(f, 13500), undefined);
  assert.equal((await c.turn(f, 21500)).entries.length, 2);
});
