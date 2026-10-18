import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync, renameSync, existsSync} from 'node:fs';

if (process.env.FIXTURE_PIDS_REPORT) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true, stdio:'inherit'});
  child.unref();
  writeFileSync(process.env.FIXTURE_PIDS_REPORT, JSON.stringify({server:process.pid, child:child.pid, args:process.argv.slice(2), token:process.env.FIXTURE_TOKEN}));
}
if (process.env.FIXTURE_IGNORE_EOF) setInterval(() => {}, 1000);
const tools = [
  {name:'inspect',description:'Report fixture process',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
  {name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}},
  {name:'change',description:'Change a record',inputSchema:{type:'object',properties:{}}},
];
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    if (process.env.FIXTURE_INIT_HANG) return;
    if (process.env.FIXTURE_REPORT) {
      const report = process.env.FIXTURE_REPORT, temporary = report + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN,unrelated:process.env.UNRELATED_SECRET ?? null}));
      renameSync(temporary, report);
    }
    if (process.env.FIXTURE_READY_URL) fetch(process.env.FIXTURE_READY_URL, {method:'POST', body:JSON.stringify({token:process.env.FIXTURE_TOKEN})}).catch(() => {});
    result = {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  } else if (message.method === 'tools/list') result = {tools};
  else if (message.method === 'tools/call' && process.env.FIXTURE_EXIT_CALL) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'exiting'}]}}) + '\n', () => process.exit(0));
    return;
  }
  else if (message.method === 'tools/call' && process.env.FIXTURE_HOLD_CALL) {
    if (process.env.FIXTURE_CALL_REPORT) writeFileSync(process.env.FIXTURE_CALL_REPORT, 'called');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/call-waiting',params:{}}) + '\n'); return;
  }
  else if (message.method === 'tools/call') result = {content:[{type:'text',text:message.params.name === 'inspect' ? JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN ?? null,planted:existsSync('mcp-smoke-planted.txt')}) : message.params.name === 'echo' ? message.params.arguments.text : 'changed'}]};
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\n');
});
