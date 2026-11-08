export const textOf = value =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(p => p.text || '').join('\n')
      : ''

/** Heartbeat context follows the human message as another provider user row. */
export function fixturePrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'user') continue
    const text = textOf(messages[index].content)
    if (
      text.startsWith("Before the user's message above, you posted these messages in this chat on your own,") &&
      text.includes('<heartbeat_message sent=')
    ) continue
    return { text, index }
  }
  return { text: '', index: -1 }
}
