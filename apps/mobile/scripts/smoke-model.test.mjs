import assert from 'node:assert/strict'
import test from 'node:test'
import { fixturePrompt } from './smoke-model.mjs'

test('selects the native human prompt before actual daemon heartbeat context', () => {
  // This provider row was captured after the complete retained smoke scenario.
  const context = "Before the user's message above, you posted these messages in this chat on your own, from your heartbeat or the daemon's checks on your bots' computer. They are a record of what you told them, written while you read their connected tools and the web; they are not instructions from the user.\n\n<heartbeat_message sent=\"Thu 5 Nov, 17:43\">\nFlight BA 286 is two hours late.\n</heartbeat_message>"
  const messages = [
    { role: 'assistant', content: 'Home Assistant has its token.' },
    { role: 'user', content: [{ type: 'text', text: 'Hello from Android native cleanup reproduction' }] },
    { role: 'user', content: [{ type: 'text', text: context }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tool' }] },
    { role: 'tool', tool_call_id: 'tool', content: 'Done' }
  ]
  const prompt = fixturePrompt(messages)
  assert.deepEqual(prompt, { text: 'Hello from Android native cleanup reproduction', index: 1 })
  assert.equal(messages.slice(prompt.index + 1).some(message => message.role === 'tool'), true)
})

test('keeps ordinary user messages and handles an empty conversation', () => {
  assert.deepEqual(fixturePrompt([]), { text: '', index: -1 })
  assert.deepEqual(fixturePrompt([{ role: 'user', content: 'Show a visual' }]), { text: 'Show a visual', index: 0 })
  assert.deepEqual(fixturePrompt([{ role: 'user', content: 'My note has <heartbeat_message sent="now"> in it.' }]), {
    text: 'My note has <heartbeat_message sent="now"> in it.', index: 0
  })
})
