/** What a tool call reads as in the transcript: done, and while it runs. */
const LABELS: Record<string, [string, string]> = {
  bash: ['Ran a command', 'Running a command'],
  clarify: ['Asked you', 'Asking you'],
  delegate_task: ['Handed off a task', 'Handing off a task'],
  edit: ['Edited a file', 'Editing a file'],
  edit_file: ['Edited a file', 'Editing a file'],
  find: ['Searched files', 'Searching files'],
  grep: ['Searched files', 'Searching files'],
  hexbot_show_html: ['Showed a visual', 'Drawing a visual'],
  ls: ['Listed files', 'Listing files'],
  memory: ['Updated memory', 'Updating memory'],
  message_bot: ['Messaged a bot', 'Messaging a bot'],
  patch: ['Edited a file', 'Editing a file'],
  read: ['Read a file', 'Reading a file'],
  read_file: ['Read a file', 'Reading a file'],
  search_files: ['Searched files', 'Searching files'],
  terminal: ['Ran a command', 'Running a command'],
  web_extract: ['Read a web page', 'Reading a web page'],
  web_fetch: ['Read a web page', 'Reading a web page'],
  web_search: ['Searched the web', 'Searching the web'],
  write: ['Wrote a file', 'Writing a file'],
  write_file: ['Wrote a file', 'Writing a file']
}

export function toolLabel(name: string, running = false) {
  const known = LABELS[name]
  if (known) return known[running ? 1 : 0]
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool'
}

/** "Using write_file" from the daemon becomes "Writing a file". */
export function activityLabel(activity: string) {
  const match = /^Using (\S+)$/.exec(activity)
  return match ? toolLabel(match[1]!, true) : activity
}

/**
 * Tool results often arrive as MCP-style JSON (`{content: [{text}]}`), sometimes
 * with JSON inside the text. Return the text a person would want to read.
 */
export function readableResult(detail: string): string {
  const text = detail.trim()
  if (!/^[[{]/.test(text)) return text
  try {
    const value = JSON.parse(text) as { content?: { text?: unknown }[] }
    const parts = Array.isArray(value?.content)
      ? value.content.flatMap(part => (typeof part?.text === 'string' ? [part.text] : []))
      : []
    if (parts.length) return readableResult(parts.join('\n'))
    return JSON.stringify(value, null, 2)
  } catch {
    return text
  }
}

/** One line for the transcript; structured results stay on the tool card. */
export function resultLine(detail: string) {
  const text = readableResult(detail)
  if (/^[[{]/.test(text)) return ''
  return (
    text
      .split('\n')
      .find(line => line.trim())
      ?.trim() ?? ''
  )
}
