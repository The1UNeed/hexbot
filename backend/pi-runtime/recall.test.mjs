import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import hexbot from './extension.ts';

const text = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');

// The installed Pi with Hexbot's extension; only the provider and the daemon
// bridge are fixtures. `requests` holds each provider request's messages.
async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-recall-'));
  const previous = process.env.HEXBOT_SESSION_CONFIG;
  process.env.HEXBOT_SESSION_CONFIG = join(home, 'session.json');
  const config = {home, cwd:home, prompt:'Prompt', tools:[], provider:'recall-fixture', model:'fixture', approvalMode:'off'};
  writeFileSync(process.env.HEXBOT_SESSION_CONFIG, JSON.stringify(config));
  t.after(() => {
    if (previous === undefined) delete process.env.HEXBOT_SESSION_CONFIG;
    else process.env.HEXBOT_SESSION_CONFIG = previous;
    rmSync(home, {recursive:true, force:true});
  });
  const state = {requests:[], errors:[]};
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}});
  let session;
  let sessionFile;
  const start = async () => {
    const resourceLoader = new DefaultResourceLoader({cwd:home, agentDir:home, settingsManager,
      noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
      extensionFactories:[hexbot, pi => {
        pi.registerProvider('recall-fixture', {
          api:'recall-fixture', apiKey:'fixture', baseUrl:'fixture://local',
          models:[{id:'fixture', name:'fixture', reasoning:false, input:['text'], cost:{input:0, output:0, cacheRead:0, cacheWrite:0}, contextWindow:32768, maxTokens:4096}],
          streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            state.requests.push(context.messages.map(message => `${message.role}:${text(message)}`));
            const output = {role:'assistant', api:model.api, provider:model.provider, model:model.id,
              content:[{type:'text', text:`Reply ${state.requests.length}`}], stopReason:'stop', timestamp:Date.now(),
              usage:{input:10, output:10, cacheRead:0, cacheWrite:0, totalTokens:20, cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}}};
            queueMicrotask(() => {
              stream.push({type:'done', reason:'stop', message:output});
              stream.end();
            });
            return stream;
          },
        });
      }],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({authPath:join(home, 'auth.json'), modelsPath:null, modelsStorePath:join(home, 'models-cache.json'), refreshOnCreate:false});
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(home, join(home, 'sessions'));
    ({session} = await createAgentSession({cwd:home, agentDir:home, modelRuntime, resourceLoader, settingsManager, sessionManager, tools:[]}));
    sessionFile = sessionManager.getSessionFile();
    // As rpc-mode.js binds them.
    await session.bindExtensions({
      uiContext:{async input(title) {
        const {name} = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
        if (name === 'hexbot_session_settings') return JSON.stringify({result:config});
        if (name === 'hexbot_mcp_servers') return JSON.stringify({result:[]});
        return JSON.stringify({result:null});
      }, notify() {}},
      commandContextActions:{
        waitForIdle:() => session.waitForIdle(),
        navigateTree:(id, options) => session.navigateTree(id, options),
      },
      onError:error => state.errors.push(error.error),
    });
    await session.setModel(modelRuntime.getModel('recall-fixture', 'fixture'));
  };
  await start();
  t.after(() => session.dispose());
  return {get session() { return session; }, state, async restart() {
    session.dispose();
    await start();
  }};
}

const inputs = session => session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user');

test('Recall returns the chat to just before the latest message, across a restart', {timeout:30000}, async t => {
  const f = await fixture(t);
  await f.session.prompt('First');
  await f.session.prompt('Second');
  await f.session.prompt(`/hexbot-recall ${inputs(f.session).at(-1).id}`);
  assert.deepEqual(f.state.errors, []);
  assert.deepEqual(inputs(f.session).map(entry => text(entry.message)), ['First']);
  await f.session.prompt('Third');
  // The next request is the first one's prefix and its reply: the cache holds.
  assert.deepEqual(f.state.requests, [
    ['system:Prompt', 'user:First'],
    ['system:Prompt', 'user:First', 'assistant:Reply 1', 'user:Second'],
    ['system:Prompt', 'user:First', 'assistant:Reply 1', 'user:Third'],
  ]);
  // Pi resumes from the file's last entry, which the recall recorded.
  await f.restart();
  assert.deepEqual(inputs(f.session).map(entry => text(entry.message)), ['First', 'Third']);
});

test('Recall survives a restart before the next message', {timeout:30000}, async t => {
  const f = await fixture(t);
  await f.session.prompt('First');
  await f.session.prompt('Second');
  await f.session.prompt(`/hexbot-recall ${inputs(f.session).at(-1).id}`);
  await f.restart();
  assert.deepEqual(inputs(f.session).map(entry => text(entry.message)), ['First']);
  await f.session.prompt('Third');
  assert.deepEqual(f.state.requests.at(-1), ['system:Prompt', 'user:First', 'assistant:Reply 1', 'user:Third']);
});

test('Recall takes back only the latest message', {timeout:30000}, async t => {
  const f = await fixture(t);
  await f.session.prompt('First');
  await f.session.prompt('Second');
  const before = f.session.sessionManager.getLeafId();
  for (const args of [inputs(f.session)[0].id, '', 'missing']) {
    await f.session.prompt(`/hexbot-recall ${args}`);
  }
  assert.equal(f.state.errors.length, 3);
  assert.ok(f.state.errors.every(error => error === 'Only the latest message can be recalled'));
  assert.equal(f.session.sessionManager.getLeafId(), before);
});
