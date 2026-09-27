import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import hexbot from './extension.ts';

test('tool dialog receives the execution abort signal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hexbot-extension-'));
  const previous = process.env.HEXBOT_SESSION_CONFIG;
  try {
    const config = join(directory, 'config.json');
    writeFileSync(config, JSON.stringify({readOnlyTools: [], tools: [{name: 'execute_code'}]}));
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
