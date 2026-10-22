// Unit/integration fixture only: run the production Rust protocol and dir handles.
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const manifest = fileURLToPath(new URL('../../hexbot-core/Cargo.toml',import.meta.url));
export function fileBridgeReply(args) {
  let executable = process.env.HEXBOT_TEST_PI_FILE_FIXTURE;
  if (!executable) {
    const records = execFileSync('cargo',['build','--locked','--manifest-path',manifest,'--example','pi_file_fixture','--message-format=json'],{encoding:'utf8',maxBuffer:8*1024*1024});
    executable = records.trim().split('\n').map(line => JSON.parse(line)).find(record => record.reason === 'compiler-artifact' && record.target.name === 'pi_file_fixture' && record.executable)?.executable;
    if (!executable) throw new Error('Rust Pi file fixture did not build');
    process.env.HEXBOT_TEST_PI_FILE_FIXTURE = executable;
  }
  const event = {type:'extension_ui_request',id:randomUUID(),method:'input',title:'__HEXBOT_TOOL__'+JSON.stringify({name:'hexbot_pi_file',args})};
  return execFileSync(executable,[],{input:JSON.stringify(event),encoding:'utf8',maxBuffer:2*1024*1024}).trim();
}
