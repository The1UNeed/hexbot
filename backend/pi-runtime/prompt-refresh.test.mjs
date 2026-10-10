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
  // A fake daemon: `prompt` is what it would build now, `offered` its last
  // offer, and `persisted` the saved prompt a reopened section starts on.
  const state = {prompt:'Changed prompt', persisted:'Original prompt', offered:undefined, drop:false, dropAdopt:false, requests:[], hashes:[], adopts:[], events:[], replies:0};
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:!prePrompt, reserveTokens:8192, keepRecentTokens:1}, retry:{enabled:false}});
  let session;
  let sessionFile;
  const start = async () => {
    config.prompt = state.persisted;
    writeFileSync(process.env.HEXBOT_SESSION_CONFIG, JSON.stringify(config));
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
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(home, join(home, 'sessions'));
    ({session} = await createAgentSession({cwd:home, agentDir:home, modelRuntime, resourceLoader, settingsManager, sessionManager, tools:['probe']}));
    sessionFile = sessionManager.getSessionFile();
    await session.bindExtensions({uiContext:{async input(title) {
      const {name, args} = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
      if (name === 'hexbot_session_settings') return JSON.stringify({result:config});
      if (name === 'hexbot_session_prompt' && args.adopt) {
        state.adopts.push(args.adopt);
        if (args.adopt !== hash(state.offered ?? '')) return JSON.stringify({error:'prompt was not offered'});
        state.persisted = state.offered;
        if (state.dropAdopt) return undefined;
        return JSON.stringify({result:{adopted:true}});
      }
      if (name === 'hexbot_session_prompt') {
        state.hashes.push(args.current);
        const offer = args.current !== hash(state.prompt) || state.persisted !== state.prompt;
        state.offered = offer ? state.prompt : undefined;
        if (state.drop) return undefined;
        return JSON.stringify({result:offer ? {text:state.prompt} : null});
      }
      return JSON.stringify({result:null});
    }}, onError:error => assert.fail(error.message)});
    await session.setModel(modelRuntime.getModel('refresh-fixture', 'fixture'));
  };
  await start();
  t.after(() => session.dispose());
  return {get session() { return session; }, settingsManager, state, async restart() {
    session.dispose();
    await start();
  }};
}

test('Pi mid-run auto-compaction keeps the old prompt through continuation and later ordinary runs', {timeout:30000}, async t => {
  const {session, state} = await fixture(t, {midRun:true});
  await session.prompt('Use the probe');
  assert.deepEqual(state.events, ['start', 'request', 'compact:threshold', 'request']);
  assert.deepEqual(state.requests, ['Original prompt', 'Original prompt']);
  assert.deepEqual(state.hashes, [hash('Original prompt')]);
  await session.prompt('Next ordinary run');
  assert.equal(state.requests.at(-1), 'Original prompt');
  // A later compaction offers the change again.
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
  assert.equal(state.persisted, 'Original prompt');
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

for (const boundary of ['mid-run', 'manual', 'pre-prompt']) {
  test(`Pi ${boundary} compaction saves only the adopted prompt across retirement and restart`, {timeout:30000}, async t => {
    const f = await fixture(t, {midRun:boundary === 'mid-run', prePrompt:boundary === 'pre-prompt'});
    await f.session.prompt('First run');
    if (boundary === 'manual') {
      await f.session.compact();
      assert.equal(f.state.persisted, 'Original prompt', 'an offer alone is not saved');
      assert.deepEqual(f.state.adopts, []);
      await f.session.prompt('Adopt at the next run');
    }
    if (boundary === 'pre-prompt') {
      f.settingsManager.setCompactionEnabled(true);
      await f.session.prompt('Compact before starting');
    }
    const expected = boundary === 'mid-run' ? 'Original prompt' : 'Changed prompt';
    assert.equal(f.state.requests.at(-1), expected);
    assert.equal(f.state.persisted, expected);
    assert.deepEqual(f.state.adopts, boundary === 'mid-run' ? [] : [hash(expected)]);
    // Recreate Pi and its extension from the saved prompt and the durable
    // conversation, as both idle retirement and a daemon restart do.
    for (const reason of ['idle retirement', 'daemon restart']) {
      await f.restart();
      await f.session.prompt(`Ordinary turn after ${reason}`);
      assert.equal(f.state.requests.at(-1), expected);
      assert.equal(f.state.persisted, expected);
    }
  });
}

test('Pi keeps its old prompt when adoption is refused or its reply is lost', {timeout:30000}, async t => {
  const f = await fixture(t);
  await f.session.prompt('First run');
  await f.session.compact();
  // The daemon offered something else in the meantime: refused, nothing saved.
  f.state.offered = 'Another prompt';
  await f.session.prompt('Adoption refused');
  assert.equal(f.state.requests.at(-1), 'Original prompt');
  assert.equal(f.state.persisted, 'Original prompt');
  // The daemon saves the prompt, but its reply is lost, so Pi keeps the old one.
  await f.session.compact();
  f.state.dropAdopt = true;
  await f.session.prompt('Adoption reply lost');
  assert.equal(f.state.requests.at(-1), 'Original prompt');
  assert.equal(f.state.persisted, 'Changed prompt');
  f.state.dropAdopt = false;
  // The next compaction offers it again and adopting it is idempotent.
  await f.session.compact();
  await f.session.prompt('Adopted');
  assert.equal(f.state.requests.at(-1), 'Changed prompt');
  assert.deepEqual(f.state.adopts, [hash('Changed prompt'), hash('Changed prompt'), hash('Changed prompt')]);
  // With the row and the live prompt in step, nothing more is offered.
  await f.session.compact();
  await f.session.prompt('Unchanged');
  assert.deepEqual(f.state.adopts.length, 3);
});

test('Pi restart before adoption ignores an undelivered or unused offer', {timeout:30000}, async t => {
  for (const drop of [false, true]) {
    const f = await fixture(t);
    await f.session.prompt('First run');
    f.state.drop = drop;
    await f.session.compact();
    assert.equal(f.state.persisted, 'Original prompt');
    await f.restart();
    await f.session.prompt('Ordinary turn after restart');
    assert.equal(f.state.requests.at(-1), 'Original prompt');
    assert.deepEqual(f.state.adopts, []);
  }
});
