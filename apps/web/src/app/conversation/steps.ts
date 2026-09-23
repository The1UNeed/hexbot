import type { Message, ToolCall } from '../../lib/types'

/** Present and past phrasing per built-in tool; unknown tools fall back to their name. */
const VERBS: Record<string, [live: string, done: string]> = {
  browser_click: ['Clicking', 'Clicked'],
  browser_navigate: ['Browsing', 'Browsed'],
  browser_type: ['Typing', 'Typed'],
  clarify: ['Asking', 'Asked'],
  cronjob_manage: ['Scheduling', 'Scheduled'],
  delegate_task: ['Delegating', 'Delegated'],
  execute_code: ['Running code', 'Ran code'],
  hexbot_soul: ['Updating soul', 'Updated soul'],
  image_generate: ['Generating an image', 'Generated an image'],
  memory: ['Updating memory', 'Updated memory'],
  patch: ['Editing', 'Edited'],
  read_file: ['Reading', 'Read'],
  search_files: ['Searching files', 'Searched files'],
  session_search: ['Searching past sections', 'Searched past sections'],
  skill_manage: ['Updating a skill', 'Updated a skill'],
  skill_view: ['Reading a skill', 'Read a skill'],
  skills_list: ['Listing skills', 'Listed skills'],
  terminal: ['Running', 'Ran'],
  text_to_speech: ['Generating speech', 'Generated speech'],
  todo_list: ['Updating tasks', 'Updated tasks'],
  video_generate: ['Generating a video', 'Generated a video'],
  vision_analyze: ['Looking at the image', 'Looked at the image'],
  web_extract: ['Reading', 'Read'],
  web_search: ['Searching the web', 'Searched the web'],
  write_file: ['Writing', 'Wrote']
}

/** Tools whose argument preview reads well after the verb, with its connector. */
const PREVIEW: Record<string, string> = {
  patch: ' ',
  read_file: ' ',
  search_files: ' for ',
  terminal: ' ',
  web_extract: ' ',
  web_search: ' for ',
  write_file: ' '
}

/**
 * Housekeeping the bot does for itself. Shown while it happens, then dropped
 * from the transcript; the Computer tab in the panel still lists every call.
 */
export const QUIET_TOOLS = new Set([
  // The question card is the clarify tool's whole UI; a step row would repeat it.
  'clarify',
  // Memory and soul writes get their own marks under the bubble (memoryMarks).
  'hexbot_soul',
  'memory',
  'session_search',
  'skill_view',
  'skills_list',
  'todo_list'
])

export interface MemoryMark {
  kind: 'memory' | 'soul'
  text: string
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const string = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * Whether a call actually wrote. Restored history marks every tool row `ok`,
 * so the result is read too: the memory tool reports `success: false`, the
 * soul tool `error`, and both are JSON strings.
 */
function succeeded(call: ToolCall): boolean {
  if (call.status !== 'ok') {
    return false
  }

  const raw = typeof call.result === 'string' ? call.result : null
  let body: unknown = raw ? null : call.result

  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      return true
    }
  }

  const result = record(body)

  return result.success !== false && !('error' in result)
}

/** What one finished call wrote, in reading order for the mark's detail. */
function markFor(call: ToolCall): MemoryMark | null {
  if (!succeeded(call)) {
    return null
  }

  const args = record(call.args)

  if (call.name === 'hexbot_soul') {
    const text = string(args.text)

    return args.action === 'write' && text ? { kind: 'soul', text } : null
  }

  if (call.name !== 'memory') {
    return null
  }

  const operations = Array.isArray(args.operations) ? args.operations.map(record) : [args]

  const lines = operations.flatMap(operation => {
    const written = string(operation.content) || string(operation.new_text)
    const removed = string(operation.old_text)

    return written ? [written] : removed ? [`Removed: ${removed}`] : []
  })

  return lines.length ? { kind: 'memory', text: lines.join('\n') } : null
}

/** Every memory or soul write the turn made, in order. */
export const memoryMarks = (message: Message): MemoryMark[] =>
  message.toolCalls.flatMap(call => {
    const mark = markFor(call)

    return mark ? [mark] : []
  })

const humanize = (name: string) => name.replace(/[_-]+/g, ' ').trim() || 'tool'

const preview = (call: ToolCall) => {
  const text = (call.summary ?? '').replace(/\s+/g, ' ').trim()

  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** "Searching the web for weather" while running, "Searched the web for weather" after. */
export function toolLabel(
  call: ToolCall,
  tense: 'done' | 'live' = call.status === 'running' ? 'live' : 'done'
): string {
  const verbs = VERBS[call.name]

  const verb = verbs
    ? verbs[tense === 'live' ? 0 : 1]
    : `${tense === 'live' ? 'Using' : 'Used'} ${humanize(call.name)}`

  const connector = PREVIEW[call.name]
  const detail = connector === undefined ? '' : preview(call)

  return detail ? `${verb}${connector}${detail}` : verb
}

/** The step in progress, phrased for the working face; nothing while the bot thinks or writes. */
export function runningLabel(message: Message): string | undefined {
  const running = message.toolCalls.findLast(call => call.status === 'running')

  return running ? toolLabel(running, 'live') : undefined
}

/**
 * Work shorter than this stays hidden: no panel while it runs, no line after
 * it. Most quick replies never think or call a tool for that long.
 */
export const MIN_WORK_S = 2

/** Whether the turn did anything worth showing: a reasoning trace or a visible step. */
export const hasWork = (message: Message) =>
  Boolean(message.thinking || visibleSteps(message.toolCalls).length)

/**
 * Seconds from the turn start to the last reasoning or tool event. Restored
 * history has neither timestamp; its tool durations stand in when known.
 */
export function workSeconds(message: Message): null | number {
  if (message.createdAt > 0 && message.workUntil) {
    return Math.max(0, (message.workUntil - message.createdAt) / 1000)
  }

  const timed = message.toolCalls.filter(call => call.durationS !== null)

  return timed.length ? timed.reduce((total, call) => total + (call.durationS ?? 0), 0) : null
}

/**
 * True once the work has run for `MIN_WORK_S`. While streaming that is time
 * since the turn started; afterwards, the measured work. Unknown timing
 * (restored history) counts as long enough.
 */
export function workShown(message: Message, now = Date.now()): boolean {
  if (!hasWork(message)) {
    return false
  }

  const seconds = message.streaming
    ? message.createdAt > 0
      ? (now - message.createdAt) / 1000
      : 0
    : workSeconds(message)

  return seconds === null || seconds >= MIN_WORK_S
}

export const visibleSteps = (calls: ToolCall[]) => calls.filter(call => !QUIET_TOOLS.has(call.name))

const formatSeconds = (seconds: number) =>
  seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${Math.max(1, Math.round(seconds))}s`

/**
 * One line for a finished turn: "Searched the web for weather · 3s", or
 * "4 steps · 12s". Empty when every call was housekeeping.
 */
export function stepsSummary(calls: ToolCall[]): string {
  const steps = visibleSteps(calls)

  if (!steps.length) {
    return ''
  }

  const seconds = calls.reduce((total, call) => total + (call.durationS ?? 0), 0)

  const head =
    steps.length === 1 && steps[0] ? toolLabel(steps[0], 'done') : `${steps.length} steps`

  return seconds > 0 ? `${head} · ${formatSeconds(seconds)}` : head
}

/**
 * One line for a finished turn that thought: "Thought for 12s", or
 * "Thought for 12s · 3 steps". Turns that only ran tools keep `stepsSummary`.
 */
export function workSummary(message: Message): string {
  if (!message.thinking) {
    return stepsSummary(message.toolCalls)
  }

  const head = `Thought for ${formatSeconds(workSeconds(message) ?? 0)}`
  const steps = visibleSteps(message.toolCalls)

  if (!steps.length) {
    return head
  }

  return `${head} · ${steps.length === 1 && steps[0] ? toolLabel(steps[0], 'done') : `${steps.length} steps`}`
}

/** The panel headline while the turn runs: the running step, a wait notice, else "Thinking". */
export function liveLabel(message: Message): string {
  return (
    runningLabel(message) ?? message.activity ?? (message.text ? workSummary(message) : 'Thinking')
  )
}
