import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAcp } from './acp.ts';

const context = {messages: [
  {role: 'system', content: 'Persona', toolsAdded: [{name: 'memory', description: 'Remember', parameters: {type: 'object'}}], timestamp: 0},
  {role: 'user', content: [{type: 'text', text: 'Remember tea'}], timestamp: 1},
]};
const model = {api: 'hexbot-acp', provider: 'copilot-acp', id: 'copilot-acp'};
test('ACP stream retains Pi tools and emits text, thinking, tool calls, and completion', async () => {
  let provider;
  registerAcp({registerProvider(name, value) {assert.equal(name, 'copilot-acp');provider = value;}}, {}, async (name, args) => {
    assert.equal(name, 'hexbot_acp_complete');
    assert.equal(args.context.systemPrompt, 'Persona');
    assert.equal(args.context.tools[0].name, 'memory');
    assert.equal(args.checked, true);
    return {text: 'Done', thinking: 'Reason', toolCalls: [{id: 't', name: 'memory', arguments: {action: 'add'}}], stopReason: 'toolUse'};
  });
  const stream = provider.streamSimple(model, context, {onPayload: value => ({...value, checked: true})});
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']);
  const result = await stream.result();
  assert.equal(result.stopReason, 'toolUse');
  assert.deepEqual(result.content.at(-1), {type: 'toolCall', id: 't', name: 'memory', arguments: {action: 'add'}});
});
test('ACP stream propagates transport failures and aborted requests', async () => {
  let provider;
  registerAcp({registerProvider(_name, value) {provider = value;}}, {}, async () => {throw new Error('Login required');});
  let result = await provider.streamSimple(model, context).result();
  assert.equal(result.stopReason, 'error'); assert.equal(result.errorMessage, 'Login required');
  result = await provider.streamSimple(model, context, {signal: AbortSignal.abort()}).result();
  assert.equal(result.stopReason, 'aborted');
});
