import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

const {SessionManager} = await import(pathToFileURL(join(process.env.PI_MODULES,
  '@earendil-works/pi-coding-agent/dist/core/session-manager.js')));
const {convertMessages} = await import(pathToFileURL(join(process.env.PI_MODULES,
  '@earendil-works/pi-ai/dist/api/openai-completions.js')));
const model = {id: 'model', provider: 'test', api: 'openai-completions', input: ['text'], reasoning: false};

function inspect(path, phase, clean) {
  const messages = SessionManager.open(path).buildSessionContext().messages;
  const calls = messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === 'toolCall').map(b => b.id));
  const results = messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId);
  assert.deepEqual(results.filter(id => !calls.includes(id)), [], `${phase}: Pi orphan`);
  const payload = convertMessages(model, {messages, tools: []}, {}, {});
  const wireCalls = payload.flatMap(m => (m.tool_calls || []).map(c => c.id));
  const wireResults = payload.filter(m => m.role === 'tool').map(m => m.tool_call_id);
  assert.deepEqual(wireResults.filter(id => !wireCalls.includes(id)), [], `${phase}: provider orphan`);
  if (clean) {
    assert.deepEqual(calls, ['call-1']);
    assert.deepEqual(results, calls);
    assert.deepEqual(wireCalls, calls);
    assert.deepEqual(wireResults, calls);
    assert(messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Keep human dialogue')));
    assert(messages.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('UNIQUE_FILE_CONTENT')));
    assert(!messages.some(m => m.role === 'assistant' && m.content.length === 1
      && m.content[0].type === 'text' && m.content[0].text === 'REPORT_TEXT'));
    assert(!JSON.stringify(messages).includes('Contaminated summary'));
  }
  console.log(JSON.stringify({phase, calls, results, wireCalls, wireResults, messages, payload}));
}

if (process.env.SOURCE_FILE) inspect(process.env.SOURCE_FILE, 'original', false);
inspect(process.env.CHAT_FILE, 'adopted', true);
const manager = SessionManager.open(process.env.CHAT_FILE);
const human = manager.getEntries().find(e => e.type === 'message' && e.message.role === 'user');
assert(human);
manager.appendCompaction('Clean summary of owner discussion', human.id, 100);
inspect(process.env.CHAT_FILE, 'compacted', true);
