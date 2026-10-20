#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({input: process.stdin});
const config = JSON.parse(fs.readFileSync(process.env.HEXBOT_SESSION_CONFIG));
const bot = path.basename(path.dirname(process.env.PI_CODING_AGENT_DIR));
const section = path.basename(path.dirname(process.env.HEXBOT_SESSION_CONFIG));
const log = path.join(config.home, 'chain-responses.jsonl');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const tool = (id, name, args) => emit({type: 'extension_ui_request', id,
  method: 'input', title: '__HEXBOT_TOOL__' + JSON.stringify({name, args})});
const upstream = id => tool(id, 'message_bot', {to: 'owl', text: 'Original work', wait: true});
const detail = id => tool(id, 'message_bot', {to: 'fox', text: 'A detail', wait: true});
const finish = text => {
  emit({type: 'message_end', message: {role: 'assistant',
    content: [{type: 'text', text}], stopReason: 'stop'}});
  emit({type: 'agent_settled'});
};
const blocked = response => response.error?.startsWith('owl is waiting on this request.')
  ? 'CHAIN_BLOCKED' : 'CHAIN_BYPASSED';
let scenario;
rl.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'extension_ui_response') {
    const response = JSON.parse(command.value || '{}');
    fs.appendFileSync(log, JSON.stringify({bot, section, id: command.id, response}) + '\n');
    switch (command.id) {
      case 'root-request': return finish(response.result?.reply || JSON.stringify(response));
      case 'parent-check':
        if (!response.error) return finish('CONTROL_BYPASSED');
        if (scenario === 'async') {
          tool('async-request', 'message_bot', {to: 'fox', text: 'A detail', wait: false});
        } else if (scenario === 'queued') {
          emit({type: 'extension_ui_request', method: 'setStatus', statusText: 'Ready for queued input'});
        } else {
          tool('spawn-child', 'delegate_task', {goal: 'child probe', output_schema: {
            type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok']}});
        }
        return;
      case 'async-check':
      case 'user-check': return finish(blocked(response));
      case 'child-check':
        if (!response.error) return finish('CHILD_BYPASSED');
        return detail('child-detail');
      case 'child-detail': return tool('spawn-nested', 'delegate_task', {goal: 'nested probe'});
      case 'nested-check':
        if (!response.error) return finish('NESTED_BYPASSED');
        return detail('nested-detail');
      case 'nested-detail': return finish('NESTED_BLOCKED');
      case 'correction-check': return finish(JSON.stringify({ok: !!response.error}));
      case 'fresh-check': return finish(response.error ? 'FRESH_BLOCKED' : 'FRESH_ALLOWED');
      case 'pass-on': return finish(response.error ? 'PASS_ON_BLOCKED' : 'PASS_ON_ALLOWED');
    }
    return;
  }
  emit({type: 'response', id: command.id, command: command.type, success: true, data: {}});
  if (command.type === 'abort') return emit({type: 'agent_settled'});
  if (command.type !== 'prompt') return;
  emit({type: 'agent_start'});
  emit({type: 'message_end', message: {role: 'user', content: command.message}});
  if (bot === 'owl' && section === 'first') {
    tool('root-request', 'message_bot', {to: 'cat', text: command.message, wait: true});
  } else if (bot === 'owl' || bot === 'fox') {
    finish('Detail complete');
  } else if (command.message === 'fresh' || command.message === 'independent') {
    upstream('fresh-check');
  } else if (command.message.startsWith('Correct only the JSON form')) {
    upstream('correction-check');
  } else if (config.parent_session && command.message.includes('Task: nested probe')) {
    upstream('nested-check');
  } else if (config.parent_session && command.message.includes('Task: child probe')) {
    upstream('child-check');
  } else if (command.message.startsWith('@owl: ')) {
    scenario = command.message.slice('@owl: '.length);
    upstream('parent-check');
  } else if (command.message === '[reply from fox] late') {
    tool('pass-on', 'message_bot', {to: 'owl', text: 'Passing this on', wait: true});
  } else if (command.message.startsWith('[reply from fox]')) {
    upstream('async-check');
  } else if (command.message === 'queued check') {
    upstream('user-check');
  } else if (command.message.startsWith('[Delegated tasks completed]')) {
    finish(config.parent_session ? 'Correct this invalid JSON' : command.message);
  } else {
    finish('Unexpected prompt: ' + command.message);
  }
});
