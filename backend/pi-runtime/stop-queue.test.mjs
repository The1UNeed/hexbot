import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';

// Keep the Rust Stop fixtures honest about the installed Pi's run/queue
// boundary. The provider waits on explicit barriers and spends no credits.
test('Pi retains follow-ups through abort and an idle prompt starts a fresh run', {timeout:10000}, async t => {
  const home = mkdtempSync(join(tmpdir(), 'hexbot-stop-queue-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  const started = Promise.withResolvers();
  const abortSeen = Promise.withResolvers();
  const releaseAbort = Promise.withResolvers();
  const events = [];
  const requests = [];
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}});
  const resourceLoader = new DefaultResourceLoader({cwd:home, agentDir:home, settingsManager,
    noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
    extensionFactories:[pi => {
      pi.registerProvider('stop-fixture', {
        api:'stop-fixture', apiKey:'fixture', baseUrl:'fixture://local',
        models:[{id:'fixture', name:'fixture', reasoning:false, input:['text'], cost:{input:0, output:0, cacheRead:0, cacheWrite:0}, contextWindow:32768, maxTokens:4096}],
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          const text = context.messages.at(-1).content.map(block => block.text ?? '').join('');
          requests.push(text);
          (async () => {
            if (text === 'block') {
              const aborted = Promise.withResolvers();
              options.signal.addEventListener('abort', () => {
                abortSeen.resolve();
                aborted.resolve();
              }, {once:true});
              started.resolve();
              await aborted.promise;
              await releaseAbort.promise;
            }
            const stopReason = options.signal.aborted ? 'aborted' : 'stop';
            const message = {role:'assistant', api:model.api, provider:model.provider, model:model.id,
              content:[{type:'text', text:stopReason === 'aborted' ? '' : `Reply to ${text}`}], stopReason, timestamp:Date.now(),
              usage:{input:1, output:1, cacheRead:0, cacheWrite:0, totalTokens:2, cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}}};
            stream.push(stopReason === 'aborted' ? {type:'error', reason:'aborted', error:message} : {type:'done', reason:'stop', message});
            stream.end();
          })().catch(error => { stream.end(); throw error; });
          return stream;
        },
      });
      pi.on('before_agent_start', event => { events.push(`before:${event.prompt}`); });
    }],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({authPath:join(home, 'auth.json'), modelsPath:null, modelsStorePath:join(home, 'models.json'), refreshOnCreate:false});
  const {session} = await createAgentSession({cwd:home, agentDir:home, modelRuntime, resourceLoader, settingsManager, sessionManager:SessionManager.inMemory(), tools:[]});
  t.after(() => { releaseAbort.resolve(); session.dispose(); });
  await session.bindExtensions({});
  await session.setModel(modelRuntime.getModel('stop-fixture', 'fixture'));
  session.subscribe(event => {
    if (['agent_start', 'agent_settled'].includes(event.type)) events.push(event.type);
    if (event.type === 'message_end' && event.message.role === 'user') events.push(`user:${event.message.content.map(block => block.text).join('')}`);
  });
  const run = session.prompt('block');
  await started.promise;
  let disposition;
  const followUp = message => session.prompt(message, {streamingBehavior:'followUp', preflightResult:value => { disposition = value; }});
  await followUp('result before abort');
  assert.equal(disposition, 'queued');
  const abort = session.abort();
  await abortSeen.promise;
  await followUp('result during abort');
  assert.equal(disposition, 'queued');
  assert.equal(session.pendingMessageCount, 2);
  releaseAbort.resolve();
  await Promise.all([abort, run]);
  assert.equal(session.isStreaming, false);
  assert.equal(session.pendingMessageCount, 2);
  assert.deepEqual(events, ['before:block', 'agent_start', 'user:block', 'agent_settled']);
  assert.deepEqual(requests, ['block']);

  await followUp('result after abort');
  assert.equal(disposition, 'started');
  assert.equal(session.pendingMessageCount, 0);
  assert.deepEqual(requests, ['block', 'result after abort', 'result before abort', 'result during abort']);
  assert.deepEqual(events, [
    'before:block', 'agent_start', 'user:block', 'agent_settled',
    'before:result after abort', 'agent_start', 'user:result after abort',
    'user:result before abort', 'user:result during abort', 'agent_settled',
  ]);
});
