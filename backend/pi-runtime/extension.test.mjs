import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import hexbot, {canonicalPath, credentialPath, protectedPath, shellEnvironment, sanitizeSearchResult, hostWriteTier} from './extension.ts';

// These gates assume the OS sandbox is in place, as it always is on macOS. On
// Linux the probe looks for bwrap on PATH, so a stand-in that passes the probe
// and runs the command after "--" plays bubblewrap here. isolation.test.mjs
// covers the real sandbox; the no-sandbox path has its own test below.
const shims = mkdtempSync(join(tmpdir(), 'hexbot-bwrap-shim-'));
writeFileSync(join(shims, 'bwrap'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] && shift\nexec "$@"\n', {mode:0o755});
process.env.PATH = `${shims}:${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(shims, {recursive:true, force:true}));

function fixture(t, mode = 'manual', enabledToolsets = []) {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-gates-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const config = {home, cwd:home, prompt:'Frozen prompt', tools:[], enabledToolsets, provider:'test', model:'primary'};
  const path = join(home, 'config.json'); writeFileSync(path, JSON.stringify(config));
  process.env.HEXBOT_SESSION_CONFIG = path;
  const handlers = {}, tools = {}, requests = [], choices = [], models = [];
  const settings = {...config, approvalMode:mode};
  const ctx = {model:{provider:'test',id:'primary'}, modelRegistry:{find:(provider,id)=>({provider,id})}, ui:{
    async input(title) {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length)); requests.push(request);
      if (request.name === 'hexbot_session_settings') return JSON.stringify({result:settings});
      return JSON.stringify({result:{}});
    },
    async select(title, options) {choices.push({...JSON.parse(title.slice('__HEXBOT_APPROVAL__'.length)), options}); return ctx.choice ?? 'deny';}
  }};
  const pi = {on:(name,handler)=>handlers[name]=handler, registerTool:tool=>tools[tool.name]=tool, registerProvider(){}, async setModel(model){models.push(model);ctx.model=model;return true;}, sendMessage(){}, getThinkingLevel(){}};
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
  return {home, handlers, tools, settings, ctx, requests, choices, models, gate, run, swap};
}

test('case cannot disguise credential or host configuration paths on case-insensitive file systems', {skip: process.platform !== 'darwin'}, async t => {
  const f = fixture(t, 'manual', ['file']);
  mkdirSync(join(f.home, 'profiles/owl'), {recursive:true});
  writeFileSync(join(f.home, 'profiles/owl/auth.json'), 'secret');
  for (const path of ['profiles/owl/AUTH.JSON', 'PROFILES/OWL/auth.json', '.ENV', 'Connect.JSON', 'profiles/owl/.Env']) {
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
    console.log(JSON.stringify(out));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {env:{...process.env, PATH:home, HEXBOT_SESSION_CONFIG:config}, encoding:'utf8'}));
  assert.deepEqual(result, {manualDenied:true, smartDenied:true, reason:result.reason, sessionPasses:true, afterSession:true, asked:3, offPasses:true});
  assert.match(result.reason, /no OS sandbox/);
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
