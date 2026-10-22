// Transport-fixture tests only; these do not establish Windows containment.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'hexbot-pi-transport-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'pi'));
  const launcher = join(root,'pi/launch.mjs');
  copyFileSync(new URL('./fixtures/windows-daemon-pi.mjs',import.meta.url),launcher);
  return {root,launcher,records:() => readFileSync(join(root,'fixture.events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}

test('trusted Pi fixture responds and records every owned process exit', t => {
  const f = fixture(t);
  const input = [
    {id:'state',type:'get_state'},
    {id:'prompt',type:'prompt',message:'fixture only'},
    {type:'extension_ui_response',value:'{"error":"refused"}'},
  ].map(JSON.stringify).join('\n')+'\n';
  const output = execFileSync(process.execPath,[f.launcher],{input,encoding:'utf8',timeout:5000}).trim().split('\n').map(JSON.parse);
  assert.equal(output[0].command,'get_state');
  assert.equal(output[0].success,true);
  assert(output.some(event => event.type === 'extension_ui_request' && event.title?.startsWith('__HEXBOT_TOOL__')));
  assert(output.some(event => event.statusText === 'native-boundary:{"error":"refused"}'));
  const records = f.records();
  assert.deepEqual(records.map(({event}) => event), ['start','command','command','command','exit']);
  assert.equal(records.at(-1).code,0);
  assert(records.every(({pid}) => pid === records[0].pid));
});

test('trusted loader diagnostics never create Runtime lifecycle evidence', t => {
  const f = fixture(t);
  const output = execFileSync(process.execPath,[f.launcher,'--hexbot-fixture-diagnose'],{encoding:'utf8',timeout:5000});
  assert.equal(JSON.parse(output).fixture,'loaded');
  assert.equal(existsSync(join(f.root,'fixture.events.jsonl')),false);
});

test('fixture protocol failure records exception type and nonzero exit without input data', t => {
  const f = fixture(t);
  const output = spawnSync(process.execPath,[f.launcher],{input:'private-input-must-not-be-logged\n',encoding:'utf8',timeout:5000});
  assert.equal(output.status,1);
  const records = f.records();
  assert.deepEqual(records.map(({event}) => event),['start','exception','exit']);
  assert.equal(records[1].name,'SyntaxError');
  assert.equal(records[2].code,1);
  assert.doesNotMatch(JSON.stringify(records),/private-input/);
});
