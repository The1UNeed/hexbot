// Trusted Pi transport fixture for the native Rust boundary probe. This never
// executes model code. The separate native extension probes use production Pi.
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
writeFileSync(new URL('../fixture.pid',import.meta.url),String(process.pid));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let next = 0;
createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') {
    emit({type:'extension_ui_request',method:'setStatus',statusText:'native-boundary:' + command.value});
    emit({type:'agent_settled'});
    return;
  }
  emit({type:'response',id:command.id,command:command.type,success:true,data:{}});
  if (command.type === 'prompt') {
    emit({type:'agent_start'});
    emit({type:'message_end',message:{role:'user',content:command.message}});
    emit({type:'extension_ui_request',id:`native-code-${++next}`,method:'input',title:'__HEXBOT_TOOL__' + JSON.stringify({name:'execute_code',args:{code:'print("untrusted command must not run")',full_access:true,reason:'probe'}})});
  }
  if (command.type === 'abort') emit({type:'agent_settled'});
});
