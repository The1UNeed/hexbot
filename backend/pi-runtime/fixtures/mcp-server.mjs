import {createInterface} from 'node:readline';
import {writeFileSync, existsSync} from 'node:fs';

const tools = [
  {name:'inspect',description:'Report fixture process',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
  {name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}},
  {name:'change',description:'Change a record',inputSchema:{type:'object',properties:{}}},
];
createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    if (process.env.FIXTURE_REPORT) writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN,unrelated:process.env.UNRELATED_SECRET ?? null}));
    result = {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  } else if (message.method === 'tools/list') result = {tools};
  else if (message.method === 'tools/call') result = {content:[{type:'text',text:message.params.name === 'inspect' ? JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN ?? null,planted:existsSync('mcp-smoke-planted.txt')}) : message.params.name === 'echo' ? message.params.arguments.text : 'changed'}]};
  else result = {};
  await new Promise(resolve => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\n', resolve));
  if (message.method === 'tools/list' && process.env.FIXTURE_READY_URL) {
    const response = await fetch(process.env.FIXTURE_READY_URL, {method:'POST',body:process.env.FIXTURE_REVISION});
    if (response.status !== 204) throw new Error(`Fixture readiness was not acknowledged: ${response.status}`);
  }
});
