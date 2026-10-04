import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once, EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {shellEnvironment} from './extension.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
test('real Pi connects on the first codemode call, gates nested tools, and freezes declarations', {timeout:45000}, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hexbot-pi-mcp-')));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const home = join(dir, 'home'), cwd = join(dir, 'work'), agent = join(home, 'pi');
  mkdirSync(agent, {recursive:true}); mkdirSync(join(cwd,'.pi'), {recursive:true});
  const serverCwd = join(home, 'runtime/mcp/fixture');
  mkdirSync(serverCwd, {recursive:true,mode:0o700});
  writeFileSync(join(cwd, 'planted.txt'), 'workspace');
  const marker = join(dir,'untrusted');
  writeFileSync(join(cwd,'.pi/mcp.json'), JSON.stringify({mcpServers:{rogue:{command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`]}}}));
  const requests = [], approvals = [], events = [], errors = [];
  let script = 'text(await tools.mcp__fixture__echo({text:"connected"})); text(await tools.mcp__fixture__change({})); text(await tools.bash({command:"echo nested",full_access:true}));';
  const server = createServer(async (req,res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const called = request.messages.at(-1)?.role === 'tool';
    const delta = called ? {role:'assistant',content:'Done'} : {role:'assistant',tool_calls:[{index:0,id:`c${requests.length}`,type:'function',function:{name:'codemode',arguments:JSON.stringify({code:script})}}]};
    const frame = (delta,finish_reason=null) => JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta,finish_reason}]});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(`data: ${frame(delta)}\n\ndata: ${frame({},called?'stop':'tool_calls')}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  writeFileSync(join(agent,'models.json'), JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'test',models:[{id:'test',name:'Test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:4096}]}}}));
  const config = {home,cwd,provider:'fixture',model:'test',prompt:'Frozen connected tools: mcp__fixture',tools:[],enabledToolsets:['terminal','file'],mcpServers:['fixture'],approvalMode:'smart',mcpState:{fixture:{revision:'initial'}}};
  const configPath = join(home,'config.json'), session = join(home,'conversation.jsonl');
  writeFileSync(configPath, JSON.stringify(config));
  const secret = '!echo secret-$HOME-${KEY}';
  let serverToken = secret;
  const env = {...shellEnvironment(process.env),PI_CODING_AGENT_DIR:agent,HEXBOT_SESSION_CONFIG:configPath};
  assert(!JSON.stringify(env).includes(secret));
  const child = spawn(process.execPath, [join(root,'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),'--mode','rpc','--no-approve','--session',session,'--no-extensions','-e','builtin:mcp','-e','builtin:codemode','-e',join(root,'extension.ts'),'--no-builtin-tools','--exclude-tools','powershell','--provider','fixture','--model','test'], {cwd,env,stdio:['pipe','pipe','pipe']});
  t.after(async () => {if (child.exitCode === null) {child.kill('SIGTERM'); await once(child,'exit');}});
  child.stderr.on('data', data => errors.push(String(data)));
  const bus = new EventEmitter();
  let registrations = 0, choice = 'deny';
  const send = value => child.stdin.write(JSON.stringify(value)+'\n');
  createInterface({input:child.stdout}).on('line', line => {
    let event; try {event=JSON.parse(line);} catch {errors.push(line);return;}
    events.push(event);
    if (event.type === 'extension_ui_request') {
      if (event.method === 'input' && event.title.startsWith('__HEXBOT_TOOL__')) {
        const request = JSON.parse(event.title.slice('__HEXBOT_TOOL__'.length));
        let result = {};
        if (request.name === 'hexbot_session_settings') result = config;
        if (request.name === 'hexbot_mcp_servers') {registrations++; result = config.mcpState.fixture ? [{name:'fixture',revision:config.mcpState.fixture.revision,config:{cwd:serverCwd,command:process.execPath,args:[join(root,'fixtures/mcp-server.mjs')],env:{FIXTURE_TOKEN:serverToken,FIXTURE_REPORT:join(dir,'child.json')},exposure:'codemode'}}] : [];}
        send({type:'extension_ui_response',id:event.id,value:JSON.stringify({result})});
      } else if (event.method === 'select') {
        approvals.push(JSON.parse(event.title.slice('__HEXBOT_APPROVAL__'.length)));
        send({type:'extension_ui_response',id:event.id,value:choice});
      }
    }
    if (event.type === 'agent_settled') bus.emit('settled');
  });
  const turn = async text => {
    const done = once(bus,'settled', {signal:AbortSignal.timeout(15000)});
    send({type:'prompt',message:text}); await done;
    const failures = events.filter(e => e.type === 'extension_error');
    assert.deepEqual(failures, [], JSON.stringify({failures,errors}));
  };
  await turn('First');
  assert.equal(registrations, 1);
  assert(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'mcp__fixture__echo' && !e.isError), JSON.stringify({events,errors}));
  assert(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'mcp__fixture__change' && e.isError));
  assert.equal(approvals[0].tool, 'mcp__fixture__change');
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'child.json'))), {cwd:serverCwd,token:secret,unrelated:null});
  assert.equal(existsSync(marker), false);
  choice = 'once';
  script = 'text(await tools.bash({command:"echo nested",full_access:true})); text(await tools.write({path:"/usr/local/hexbot-never-written.txt",content:"x"}));';
  // Approve bash, deny the outside write.
  config.approvalMode = 'manual';
  const originalPush = approvals.push.bind(approvals);
  approvals.push = value => {if (value.tool === 'write') choice = 'deny';return originalPush(value);};
  await turn('Second');
  assert(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'bash' && e.parentToolCallId && !e.isError));
  assert(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'write' && e.parentToolCallId && e.isError));
  assert.equal(registrations, 1);
  config.approvalMode = 'off';
  config.mcpState.fixture.revision = 'changed';
  serverToken = 'replacement-token';
  script = 'text(await tools.mcp__fixture__echo({text:"fresh connection"}));';
  // Pi reconnects asynchronously. Wait for the fixture's initialization event,
  // not a sleep; the immediate call may fail while the old client is closing.
  let watcher;
  const reconnected = new Promise(resolve => {
    watcher = watch(dir, () => {
      try {
        if (JSON.parse(readFileSync(join(dir,'child.json'))).token === serverToken) { watcher.close(); resolve(); }
      } catch { /* A write may still be in progress. */ }
    });
  });
  t.after(() => watcher.close());
  const reconnectStart = events.length;
  await turn('Reconnect');
  await reconnected;
  assert.equal(registrations, 2);
  const attempt = events.slice(reconnectStart).find(e => e.type === 'tool_execution_end' && e.toolName === 'codemode');
  if (attempt.isError) assert.match(JSON.stringify(attempt.result), /does not exist|not connected/);
  const start = events.length;
  await turn('Use the fresh connection');
  assert.equal(JSON.parse(readFileSync(join(dir,'child.json'))).token, serverToken);
  assert(events.slice(start).some(e => e.type === 'tool_execution_end' && e.toolName === 'mcp__fixture__echo' && !e.isError));
  delete config.mcpState.fixture;
  const removed = events.length;
  await turn('Removed');
  assert(events.slice(removed).some(e => e.type === 'tool_execution_end' && e.toolName === 'codemode' && e.isError));
  assert(!events.slice(removed).some(e => e.type === 'tool_execution_end' && e.toolName === 'mcp__fixture__echo' && !e.isError));
  for (const request of requests) {
    assert.deepEqual(request.tools, requests[0].tools);
    assert.equal(request.messages[0].content, config.prompt);
  }
  for (const text of [readFileSync(configPath,'utf8'),readFileSync(session,'utf8'),JSON.stringify(requests),JSON.stringify(events)]) assert(!text.includes(secret));
});
