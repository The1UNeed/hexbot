// Trusted Pi transport fixture for the native Rust boundary probe. This never
// executes model code. The separate native extension probes use production Pi.
import {createInterface} from 'node:readline';
import {appendFileSync, readFileSync, existsSync} from 'node:fs';
// This branch is invoked only after a failing native probe. It diagnoses the
// trusted module loader without writing evidence of a Runtime-owned process.
if (process.argv.includes('--hexbot-fixture-diagnose')) {
  console.log(JSON.stringify({fixture:'loaded',executable:process.execPath,module:import.meta.url,cwd:process.cwd()}));
  process.exit(0);
}
const record = event => appendFileSync(new URL('../fixture.events.jsonl',import.meta.url),JSON.stringify(event)+'\n');
record({event:'start',pid:process.pid});
process.on('exit',code => record({event:'exit',pid:process.pid,code}));
process.on('uncaughtExceptionMonitor',error => record({event:'exception',pid:process.pid,name:error.name,code:error.code ?? null}));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let next = 0;
createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  // Command names suffice to locate protocol failure; never record prompts,
  // tool arguments, environment values or extension replies.
  record({event:'command',pid:process.pid,type:command.type});
  if (command.type === 'extension_ui_response') {
    emit({type:'extension_ui_request',method:'setStatus',statusText:'native-boundary:' + command.value});
    emit({type:'agent_settled'});
    return;
  }
  emit({type:'response',id:command.id,command:command.type,success:true,data:{}});
  if (command.type === 'prompt') {
    emit({type:'agent_start'});
    emit({type:'message_end',message:{role:'user',content:command.message}});
    let code = 'print("untrusted command must not run")';
    const request = new URL('../code.json',import.meta.url);
    if (existsSync(request)) code = JSON.parse(readFileSync(request,'utf8')).code;
    emit({type:'extension_ui_request',id:`native-code-${++next}`,method:'input',title:'__HEXBOT_TOOL__' + JSON.stringify({name:'execute_code',args:{code,full_access:true,reason:'probe'}})});
  }
  if (command.type === 'abort') emit({type:'agent_settled'});
});
