import assert from 'node:assert/strict';
import test from 'node:test';
import oneShotProvider from './one-shot-provider.ts';

function fixture(config, reply) {
  const previous = process.env.HEXBOT_ONE_SHOT_PROVIDER;
  process.env.HEXBOT_ONE_SHOT_PROVIDER = JSON.stringify(config);
  const providers = {}, handlers = {}, requests = [];
  try {
    // There is deliberately no tool, MCP, prompt, or resource registration API.
    oneShotProvider({
      registerProvider(name, value) { providers[name] = value; },
      on(name, handler) { handlers[name] = handler; },
      getThinkingLevel() { return 'off'; },
    });
  } finally {
    if (previous === undefined) delete process.env.HEXBOT_ONE_SHOT_PROVIDER;
    else process.env.HEXBOT_ONE_SHOT_PROVIDER = previous;
  }
  const context = {model: {provider: config.provider, id: config.model}, ui: {
    async input(title) {
      const request = JSON.parse(title.slice('__HEXBOT_TOOL__'.length));
      requests.push(request);
      return JSON.stringify({result: typeof reply === 'function' ? reply(request) : reply});
    },
  }};
  handlers.session_start({}, context);
  return {providers, handlers, requests, context};
}

const transcript = {messages: [
  {role: 'system', content: 'Reviewer prompt', toolsAdded: [], timestamp: 0},
  {role: 'user', content: [{type: 'text', text: 'Review this step'}], timestamp: 1},
]};
test('one-shot provider registers custom ACP models and completes without tools', async () => {
  const f = fixture({provider: 'copilot-acp', model: 'review-model'}, {text: '{"decision":"allow","risk":"low"}'});
  assert.ok(f.providers['copilot-acp'].models.some(model => model.id === 'review-model'));
  const model = {provider: 'copilot-acp', id: 'review-model', api: 'hexbot-acp'};
  const result = await f.providers['copilot-acp'].streamSimple(model, transcript).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content[0].text, '{"decision":"allow","risk":"low"}');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].name, 'hexbot_acp_complete');
  assert.equal(f.requests[0].args.context.systemPrompt, 'Reviewer prompt');
  assert.deepEqual(f.requests[0].args.context.tools, []);
  assert.deepEqual(Object.keys(f.handlers).sort(), ['before_provider_headers', 'before_provider_request', 'session_start']);
});
test('one-shot ACP rejects declared tools and returned tool calls', async () => {
  const f = fixture({provider: 'copilot-acp'}, {toolCalls: [{id: 'x', name: 'bash', arguments: {command: 'touch bad'}}]});
  const model = {provider: 'copilot-acp', id: 'copilot-acp', api: 'hexbot-acp'};
  let result = await f.providers['copilot-acp'].streamSimple(model, transcript).result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /cannot use tools/);
  const withTools = structuredClone(transcript);
  withTools.messages[0].toolsAdded.push({name: 'bash'});
  result = await f.providers['copilot-acp'].streamSimple(model, withTools).result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /cannot use tools/);
  assert.equal(f.requests.length, 1);
});
test('daemon-auth providers keep their header and request hooks', async () => {
  for (const provider of ['nous', 'qwen-oauth', 'minimax-oauth']) {
    const f = fixture({provider, model: 'review-model'}, request => request.name === 'hexbot_provider_auth'
      ? {headers: {authorization: 'Bearer test-token'}} : {...request.args.payload, adapted: true});
    const event = {headers: {existing: 'header'}};
    await f.handlers.before_provider_headers(event, f.context);
    assert.deepEqual(event.headers, {existing: 'header', authorization: 'Bearer test-token'});
    assert.deepEqual(f.requests[0], {name: 'hexbot_provider_auth', args: {provider}});
    const result = await f.handlers.before_provider_request({payload: {messages: []}}, f.context);
    assert.deepEqual(result, {messages: [], adapted: true});
    assert.deepEqual(f.requests[1], {name: 'hexbot_provider_request', args: {provider, model: 'review-model', thinking: 'off', payload: {messages: []}}});
  }
});
