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
  codemode: ['Running code', 'Ran code'],
  execute_code: ['Running code', 'Ran code'],
  hexbot_rename_section: ['Naming the chat', 'Named the chat'],
  hexbot_show_html: ['Drawing', 'Drew'],
  hexbot_soul: ['Updating soul', 'Updated soul'],
  image_generate: ['Generating an image', 'Generated an image'],
  ls: ['Listing files', 'Listed files'],
  memory: ['Updating memory', 'Updated memory'],
  message_bot: ['Asking a teammate', 'Asked a teammate'],
  patch: ['Editing', 'Edited'],
  read_file: ['Reading', 'Read'],
  search_files: ['Searching files', 'Searched files'],
  session_search: ['Searching past conversations', 'Searched past conversations'],
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
  hexbot_show_html: ' ',
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
 * Phrasing for those tools when no preview came with the call: "Ran a
 * command", never a bare "Ran".
 */
const NO_PREVIEW: Record<string, [live: string, done: string]> = {
  patch: ['Editing a file', 'Edited a file'],
  read_file: ['Reading a file', 'Read a file'],
  terminal: ['Running a command', 'Ran a command'],
  web_extract: ['Reading a page', 'Read a page'],
  write_file: ['Writing a file', 'Wrote a file']
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const string = (value: unknown) => (typeof value === 'string' ? value : '')

/** The tool a bot asks another bot with; its row carries the other bot's face. */
export const ASKING_TOOL = 'message_bot'

/** One bot this turn asked for help, with the thread id once the daemon reported it. */
export interface Ask {
  /** The thread section on `target`, from the tool result; null until the ask completed. */
  sectionId: null | string
  /** The message was sent without waiting for a reply (`wait: false`); nothing came back. */
  sent: boolean
  status: ToolCallStatus
  /** The target bot's name; null when the call came without its arguments. */
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
 * for. "A teammate" stands in when the call did not name the target.
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
  const service = connectorName(call.name)

  if (service) {
    return `${tense === 'live' ? 'Connecting to' : 'Used'} ${service}`
  }

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

/** What the bot is doing in plain words, per built-in tool; never the command or the query. */
const ACTIVITY: Record<string, string> = {
  browser_click: 'is browsing the web',
  browser_navigate: 'is browsing the web',
  browser_type: 'is browsing the web',
  clarify: 'is asking you something',
  cronjob_manage: 'is setting up a routine',
  delegate_task: 'is asking another bot',
  codemode: 'is running code',
  execute_code: 'is running code',
  hexbot_rename_section: 'is naming the chat',
  hexbot_show_html: 'is drawing',
  hexbot_soul: 'is updating its soul',
  image_generate: 'is making an image',
  ls: 'is working with files',
  memory: 'is updating its memory',
  patch: 'is working with files',
  read_file: 'is working with files',
  search_files: 'is working with files',
  session_search: 'is looking through past conversations',
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
    .filter(
      server =>
        tool.startsWith(`mcp_${server}_`) ||
        tool.startsWith(`mcp__${server.replaceAll('-', '_')}__`)
    )
    .sort((a, b) => b.length - a.length)[0]

  const server = known ?? /^mcp__(.+?)__/.exec(tool)?.[1] ?? /^mcp_([^_]+)_/.exec(tool)?.[1]

  if (!server) {
    return null
  }

  const words = humanize(server)

  return SERVICES[server.toLowerCase()] ?? words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The running step for the side panel, in plain words: "Scout is searching
 * the web", "Scout is running a command", or "Connecting to GitHub" for a
 * connector's tool (`mcp_<server>_<tool>`). The conversation never shows it.
 */
export function activityLabel(call: ToolCall, name: string): string {
  const service = connectorName(call.name)

  if (service) {
    return `Connecting to ${service}`
  }

  return `${name} ${ACTIVITY[call.name] ?? `is using ${humanize(call.name)}`}`
}

/** Tools that look for something; the face searches with them. */
const SEARCHING = new Set(['search_files', 'session_search', 'web_search', 'x_search'])

/** The face a bot wears while it works: thinking, searching, writing, or working. */
export type LiveMood = 'searching' | 'thinking' | 'working' | 'writing'

/**
 * The face a bot wears over a message while it streams: thinking before
 * anything happens, searching or working while a step runs, writing while
 * its words stream. None once the message is done.
 */
export function liveMood(message: Message): LiveMood | undefined {
  if (!message.streaming) {
    return undefined
  }

  // An ask in progress has its own row with the other bot's face.
  const running = message.toolCalls.findLast(
    call => call.status === 'running' && call.name !== ASKING_TOOL
  )

  if (running && !message.checking) {
    return SEARCHING.has(running.name) ? 'searching' : 'working'
  }

  if (message.checking || message.activity) {
    return 'working'
  }

  if (message.text) {
    return 'writing'
  }

  if (message.thinking) {
    return 'thinking'
  }

  // Nothing has happened yet: the bot thinks until it does, whatever the model shows.
  return message.toolCalls.length ? 'working' : 'thinking'
}
