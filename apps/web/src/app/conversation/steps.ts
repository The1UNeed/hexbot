import type { Message, ToolCall, ToolCallStatus } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

/** Present and past phrasing per built-in tool; unknown tools fall back to their name. */
const VERBS: Record<string, [live: string, done: string]> = {
  browser_click: ['Clicking', 'Clicked'],
  browser_navigate: ['Browsing', 'Browsed'],
  browser_type: ['Typing', 'Typed'],
  clarify: ['Asking', 'Asked'],
  cronjob_manage: ['Scheduling', 'Scheduled'],
  delegate_task: ['Delegating', 'Delegated'],
  execute_code: ['Running code', 'Ran code'],
  hexbot_rename_section: ['Naming the section', 'Named the section'],
  hexbot_soul: ['Updating soul', 'Updated soul'],
  image_generate: ['Generating an image', 'Generated an image'],
  ls: ['Listing files', 'Listed files'],
  memory: ['Updating memory', 'Updated memory'],
  message_bot: ['Asking a teammate', 'Asked a teammate'],
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
  ls: ' in ',
  patch: ' ',
  read_file: ' ',
  search_files: ' for ',
  terminal: ' ',
  web_extract: ' ',
  web_search: ' for ',
  write_file: ' '
}

/**
 * Phrasing for those tools when no preview came with the call, as room members
 * see another person's bot: "Ran a command", never a bare "Ran".
 */
const NO_PREVIEW: Record<string, [live: string, done: string]> = {
  patch: ['Editing a file', 'Edited a file'],
  read_file: ['Reading a file', 'Read a file'],
  terminal: ['Running a command', 'Ran a command'],
  web_extract: ['Reading a page', 'Read a page'],
  write_file: ['Writing a file', 'Wrote a file']
}

/**
 * Housekeeping the bot does for itself. Shown while it happens, then dropped
 * from the transcript; the Computer tab in the panel still lists every call.
 */
export const QUIET_TOOLS = new Set([
  // The question card is the clarify tool's whole UI; a step row would repeat it.
  'clarify',
  // The new title in the roster and the header is the rename's whole result.
  'hexbot_rename_section',
  // Memory and soul writes get their own marks under the bubble (memoryMarks).
  'hexbot_soul',
  'memory',
  // Asking another bot gets its own row with that bot's face (asks).
  'message_bot',
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

/** The tool a bot asks another bot with; its row carries the other bot's face. */
export const ASKING_TOOL = 'message_bot'

/** One bot this turn asked for help, with the thread id once the daemon reported it. */
export interface Ask {
  /** The thread section on `target`, from the tool result; null until the ask completed. */
  sectionId: null | string
  /** The message was sent without waiting for a reply (`wait: false`); nothing came back. */
  sent: boolean
  status: ToolCallStatus
  /** The target bot's name; null when a room member got the call stripped of its arguments. */
  target: null | string
}

/**
 * The daemon's result as an object. Live calls carry Pi's `{content, details}` with the daemon's
 * result in `details`; restored history carries the result as a JSON string.
 */
function resultOf(call: ToolCall): Record<string, unknown> {
  if (typeof call.result !== 'string') {
    const result = record(call.result)

    return 'details' in result ? record(result.details) : result
  }

  try {
    return record(JSON.parse(call.result))
  } catch {
    return {}
  }
}

/** Who a `message_bot` call asked: its `to` argument, else the daemon's context line. */
export const askTarget = (call: ToolCall): null | string =>
  string(record(call.args).to) || call.summary?.trim() || null

/**
 * The bots this turn asked, one entry per bot in first-ask order. Asking the
 * same bot twice is one row: the thread between the two is one conversation.
 * Running while any ask to that bot still runs.
 */
export function asks(message: Message): Ask[] {
  const byTarget = new Map<string, Ask>()

  for (const call of message.toolCalls) {
    if (call.name !== ASKING_TOOL) {
      continue
    }

    const target = askTarget(call)
    const key = target ?? ''
    const previous = byTarget.get(key)
    const result = resultOf(call)
    const sectionId = string(result.section_id) || previous?.sectionId || null

    const status: ToolCallStatus =
      call.status === 'running' || previous?.status === 'running' ? 'running' : call.status

    // One row per bot: it "helped" if any ask to it waited for a reply.
    const sent = result.status === 'sent' && (previous?.sent ?? true)

    byTarget.set(key, { sectionId, sent, status, target })
  }

  return [...byTarget.values()]
}

/**
 * The ask row's line: "Research is asking Writer" while it runs, "Writer
 * helped" once the reply is in, "Sent to Writer" when no reply was waited
 * for. "A teammate" stands in when a room member is not told the name.
 */
export function askLabel(
  ask: Pick<Ask, 'sent' | 'status'>,
  target: null | string,
  sender: null | string
): string {
  const name = target ?? 'a teammate'

  if (ask.status === 'running') {
    return sender ? `${sender} is asking ${name}` : `Asking ${name}`
  }

  if (ask.status === 'error') {
    return `Asked ${name}`
  }

  if (ask.sent) {
    return `Sent to ${name}`
  }

  return target ? `${target} helped` : 'A teammate helped'
}

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
  const connector = PREVIEW[call.name]
  const detail = connector === undefined ? '' : preview(call)
  const verbs = (detail ? undefined : NO_PREVIEW[call.name]) ?? VERBS[call.name]

  const verb = verbs
    ? verbs[tense === 'live' ? 0 : 1]
    : `${tense === 'live' ? 'Using' : 'Used'} ${humanize(call.name)}`

  return detail ? `${verb}${connector}${detail}` : verb
}

/**
 * The step in progress, phrased for the working face; nothing while the bot
 * thinks or writes. An ask in progress has its own row and is not repeated here.
 */
export function runningLabel(message: Message): string | undefined {
  const running = message.toolCalls.findLast(
    call => call.status === 'running' && call.name !== ASKING_TOOL
  )

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

/** What the bot is doing in plain words, per built-in tool; never the command or the query. */
const ACTIVITY: Record<string, string> = {
  browser_click: 'is browsing the web',
  browser_navigate: 'is browsing the web',
  browser_type: 'is browsing the web',
  clarify: 'is asking you something',
  cronjob_manage: 'is setting up a routine',
  delegate_task: 'is asking another bot',
  execute_code: 'is running code',
  hexbot_rename_section: 'is naming the section',
  hexbot_soul: 'is updating its soul',
  image_generate: 'is making an image',
  ls: 'is working with files',
  memory: 'is updating its memory',
  patch: 'is working with files',
  read_file: 'is working with files',
  search_files: 'is working with files',
  session_search: 'is looking through past sections',
  skill_manage: 'is updating its skills',
  skill_view: 'is reading a skill',
  skills_list: 'is checking its skills',
  terminal: 'is running a command',
  text_to_speech: 'is recording a voice reply',
  todo_list: 'is planning',
  video_generate: 'is making a video',
  vision_analyze: 'is looking at an image',
  web_extract: 'is reading a web page',
  web_search: 'is searching the web',
  write_file: 'is working with files'
}

/** Brand spellings for connector servers; anything else is capitalised. */
const SERVICES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  hubspot: 'HubSpot',
  linkedin: 'LinkedIn',
  youtube: 'YouTube'
}

/**
 * The connector behind an `mcp_<server>_<tool>` call. A server name may hold
 * underscores, so a server the app has loaded is matched by its full name
 * first (longest wins), "project_tools" reading as "Project tools";
 * otherwise the first segment stands in.
 */
function connectorName(tool: string): null | string {
  if (!tool.startsWith('mcp_')) {
    return null
  }

  const known = Object.values(useConnectors.getState().byBot)
    .flat()
    .flatMap(connector => connector.mcp?.name ?? [])
    .filter(server => tool.startsWith(`mcp_${server}_`))
    .sort((a, b) => b.length - a.length)[0]

  const server = known ?? /^mcp_([^_]+)_/.exec(tool)?.[1]

  if (!server) {
    return null
  }

  const words = humanize(server)

  return SERVICES[server.toLowerCase()] ?? words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The running step for the live status, in plain words: "Scout is searching
 * the web", "Scout is running a command", or "Connecting to GitHub" for a
 * connector's tool (`mcp_<server>_<tool>`). The step itself stays behind a click.
 */
export function activityLabel(call: ToolCall, name: string): string {
  const service = connectorName(call.name)

  if (service) {
    return `Connecting to ${service}`
  }

  return `${name} ${ACTIVITY[call.name] ?? `is using ${humanize(call.name)}`}`
}

/**
 * One quiet line for a finished turn, with no steps or costs in it: "Thought
 * for 12s" or "Worked for 3s" (or "Worked on 2 steps" when restored history
 * has no timing). A step still waiting on an approval reads as live work.
 * Empty when only housekeeping ran.
 */
export function workSummary(message: Message, name = 'The bot'): string {
  const running = message.toolCalls.findLast(call => call.status === 'running')

  if (running) {
    return activityLabel(running, name)
  }

  const seconds = workSeconds(message)

  if (message.thinking) {
    return `Thought for ${formatSeconds(seconds ?? 0)}`
  }

  const steps = visibleSteps(message.toolCalls)

  if (!steps.length) {
    return ''
  }

  return seconds
    ? `Worked for ${formatSeconds(seconds)}`
    : `Worked on ${steps.length} step${steps.length === 1 ? '' : 's'}`
}

export interface LiveStatusLine {
  /** The running step, when a tool is what the bot is doing right now. */
  call?: ToolCall
  label: string
}

/**
 * The live line at the foot of a running turn: the running step in plain
 * words while a tool runs, a wait notice on a slow provider, else what the
 * bot is doing ("Scout is thinking", "Scout is writing", "Scout is working").
 */
export function liveStatus(message: Message, name: string): LiveStatusLine {
  // An ask in progress has its own row with the other bot's face.
  const running = message.toolCalls.findLast(
    call => call.status === 'running' && call.name !== ASKING_TOOL
  )

  if (running) {
    return { call: running, label: activityLabel(running, name) }
  }

  if (message.activity) {
    return { label: message.activity }
  }

  if (message.text) {
    return { label: `${name} is writing` }
  }

  return { label: message.thinking ? `${name} is thinking` : `${name} is working` }
}
