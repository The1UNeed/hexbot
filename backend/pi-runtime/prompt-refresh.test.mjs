import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream, getCurrentSystemPrompt} from '@earendil-works/pi-ai';
import hexbot from './extension.ts';

const hash = text => createHash('sha256').update(text).digest('hex');

// Exercise the installed Pi's actual compaction, run and provider boundaries.
// Only the provider and daemon bridge are fixtures; no provider credits/network.
async function fixture(t, {midRun = false, prePrompt = false} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-prompt-refresh-'));
  const previous = process.env.HEXBOT_SESSION_CONFIG;
  process.env.HEXBOT_SESSION_CONFIG = join(home, 'session.json');
  const config = {home, cwd:home, prompt:'Original prompt', tools:[], provider:'refresh-fixture', model:'fixture', approvalMode:'off'};
  writeFileSync(process.env.HEXBOT_SESSION_CONFIG, JSON.stringify(config));
  t.after(() => {
    if (previous === undefined) delete process.env.HEXBOT_SESSION_CONFIG;
    else process.env.HEXBOT_SESSION_CONFIG = previous;
    rmSync(home, {recursive:true, force:true});
  });
  const state = {prompt:'Changed prompt', persisted:'Original prompt', drop:false, requests:[], hashes:[], events:[], replies:0};
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:!prePrompt, reserveTokens:8192, keepRecentTokens:1}, retry:{enabled:false}});
  const resourceLoader = new DefaultResourceLoader({cwd:home, agentDir:home, settingsManager,
    noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
    extensionFactories:[hexbot, pi => {
      pi.registerProvider('refresh-fixture', {
        api:'refresh-fixture', apiKey:'fixture', baseUrl:'fixture://local',
        models:[{id:'fixture', name:'fixture', reasoning:false, input:['text'], cost:{input:0, output:0, cacheRead:0, cacheWrite:0}, contextWindow:32768, maxTokens:4096}],
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          (async () => {
            try {
              await options.onPayload?.({}, model);
              state.requests.push(getCurrentSystemPrompt(context.messages));
              state.events.push('request');
              const first = state.replies++ === 0;
              const tool = first && midRun;
              const input = first && (midRun || prePrompt) ? 26000 : 100;
              const output = {role:'assistant', api:model.api, provider:model.provider, model:model.id,
                content:tool ? [{type:'toolCall', id:'probe-1', name:'probe', arguments:{}}] : [{type:'text', text:'Done'}],
                stopReason:tool ? 'toolUse' : 'stop', timestamp:Date.now(),
                usage:{input, output:10, cacheRead:0, cacheWrite:0, totalTokens:input+10, cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}}};
              stream.push({type:'done', reason:output.stopReason, message:output});
              stream.end();
            } catch (error) { stream.end(); throw error; }
          })();
          return stream;
        },
      });
      pi.registerTool({name:'probe', label:'probe', description:'Fixture tool', parameters:{type:'object', properties:{}},
        async execute() { return {content:[{type:'text', text:'probed'}]}; }});
      pi.on('before_agent_start', () => { state.events.push('start'); });
      pi.on('session_before_compact', event => ({compaction:{summary:'Fixture summary', firstKeptEntryId:event.preparation.firstKeptEntryId, tokensBefore:event.preparation.tokensBefore}}));
      pi.on('session_compact', event => { state.events.push(`compact:${event.reason}`); });
    }],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({authPath:join(home, 'auth.json'), modelsPath:null, modelsStorePath:join(home, 'models-cache.json'), refreshOnCreate:false});
  const {session} = await createAgentSession({cwd:home, agentDir:home, modelRuntime, resourceLoader, settingsManager, sessionManager:SessionManager.inMemory(home), tools:['probe']});
  t.after(() => session.dispose());
  await session.bindExtensions({uiContext:{async input(title) {
    const {name, args} = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
    if (name === 'hexbot_session_settings') return JSON.stringify({result:config});
    if (name === 'hexbot_session_prompt') {
      state.hashes.push(args.current);
      state.persisted = state.prompt;
      if (state.drop) return undefined;
      return JSON.stringify({result:args.current === hash(state.prompt) ? null : {text:state.prompt}});
    }
    return JSON.stringify({result:null});
  }}, onError:error => assert.fail(error.message)});
  await session.setModel(modelRuntime.getModel('refresh-fixture', 'fixture'));
  return {session, settingsManager, state};
}

test('Pi mid-run auto-compaction keeps the old prompt through continuation and later ordinary runs', {timeout:30000}, async t => {
  const {session, state} = await fixture(t, {midRun:true});
  await session.prompt('Use the probe');
  assert.deepEqual(state.events, ['start', 'request', 'compact:threshold', 'request']);
  assert.deepEqual(state.requests, ['Original prompt', 'Original prompt']);
  assert.deepEqual(state.hashes, [hash('Original prompt')]);
  await session.prompt('Next ordinary run');
  assert.equal(state.requests.at(-1), 'Original prompt');
  // A later compaction is eligible even though the daemon already stored it.
  await session.compact();
  await session.prompt('After manual compaction');
  assert.equal(state.requests.at(-1), 'Changed prompt');
  assert.deepEqual(state.hashes, [hash('Original prompt'), hash('Original prompt')]);
});

test('Pi manual /compact refreshes on the next run and retries an interrupted bridge', {timeout:30000}, async t => {
  const {session, state} = await fixture(t);
  await session.prompt('First run');
  state.drop = true;
  await session.compact();
  assert.equal(state.persisted, 'Changed prompt');
  await session.prompt('Delivery was interrupted');
  assert.equal(state.requests.at(-1), 'Original prompt');
  state.drop = false;
  await session.compact();
  await session.prompt('Retry after compaction');
  assert.equal(state.requests.at(-1), 'Changed prompt');
  await session.compact();
  await session.prompt('Unchanged');
  assert.equal(state.requests.at(-1), 'Changed prompt');
  assert.deepEqual(state.hashes, [hash('Original prompt'), hash('Original prompt'), hash('Changed prompt')]);
});

test('Pi pre-prompt _checkCompaction refreshes before the new run first request', {timeout:30000}, async t => {
  const {session, settingsManager, state} = await fixture(t, {prePrompt:true});
  await session.prompt('First run');
  settingsManager.setCompactionEnabled(true);
  await session.prompt('Trigger pre-prompt compaction');
  assert.deepEqual(state.events, ['start', 'request', 'compact:threshold', 'start', 'request']);
  assert.deepEqual(state.requests, ['Original prompt', 'Changed prompt']);
});
