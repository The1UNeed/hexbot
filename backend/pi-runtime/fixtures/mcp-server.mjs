import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';

const tools = [
  {name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}},
  {name:'change',description:'Change a record',inputSchema:{type:'object',properties:{}}},
];
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    if (process.env.FIXTURE_REPORT) writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({cwd:process.cwd(),token:process.env.FIXTURE_TOKEN,unrelated:process.env.UNRELATED_SECRET ?? null}));
    result = {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  } else if (message.method === 'tools/list') result = {tools};
  else if (message.method === 'tools/call') result = {content:[{type:'text',text:message.params.name === 'echo' ? message.params.arguments.text : 'changed'}]};
  else result = {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\n');
});
