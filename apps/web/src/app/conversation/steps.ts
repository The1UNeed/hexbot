import { type Ask, ASKING_TOOL, asksOf } from '../../lib/asks'
import type { Message, ToolCall } from '../../lib/types'
import { phaseLabel, stepLabel, stepMood, type WorkLabel, workspaceLabel } from '../../lib/work-label'
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
  hexbot_passwords: ['Using a saved password', 'Used a saved password'],
  hexbot_plugins: ['Checking plugins', 'Checked plugins'],
  hexbot_share_file: ['Sharing a file', 'Shared a file'],
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

/**
 * The bots' computer, by `computer_use` action. The daemon sends the
 * action as the call's summary.
 */
const COMPUTER: Record<string, [live: string, done: string]> = {
  click: ['Clicking', 'Clicked'],
  double_click: ['Clicking', 'Clicked'],
  drag: ['Dragging', 'Dragged'],
  key: ['Pressing keys', 'Pressed keys'],
  launch: ['Opening an app', 'Opened an app'],
  middle_click: ['Clicking', 'Clicked'],
  move: ['Moving the pointer', 'Moved the pointer'],
  open: ['Opening a page', 'Opened a page'],
  right_click: ['Clicking', 'Clicked'],
  screenshot: ['Looking at the screen', 'Looked at the screen'],
  scroll: ['Scrolling', 'Scrolled'],
  shell: ['Running a command', 'Ran a command'],
  type: ['Typing', 'Typed'],
  wait: ['Waiting', 'Waited'],
  windows: ['Checking windows', 'Checked windows']
}

/** Email, by `hexbot_mail` action, which the daemon sends as the call's summary. */
const MAIL: Record<string, [live: string, done: string]> = {
  draft: ['Drafting an email', 'Drafted an email'],
  read: ['Reading an email', 'Read an email'],
  search: ['Searching email', 'Searched email']
}

/** "Searching email", or the plain phrase when the action is unknown. */
export function mailLabel(action: null | string | undefined, tense: 'done' | 'live'): string {
  const verbs = MAIL[(action ?? '').trim()]

  return verbs
    ? verbs[tense === 'live' ? 0 : 1]
    : tense === 'live'
      ? 'Checking email'
      : 'Checked email'
}

/** "Clicking on the computer", or the plain phrase when the action is unknown. */
export function computerLabel(action: null | string | undefined, tense: 'done' | 'live'): string {
  const verbs = COMPUTER[(action ?? '').trim()]

  if (!verbs) {
    return tense === 'live' ? 'Using the computer' : 'Used the computer'
  }

  return `${verbs[tense === 'live' ? 0 : 1]} on the computer`
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

export { type Ask, ASKING_TOOL, askLabel, askTarget, askWords } from '../../lib/asks'
export { workspaceLabel } from '../../lib/work-label'

/** The bots this turn asked, one entry per bot in first-ask order. */
export const asks = (message: Pick<Message, 'toolCalls'>): Ask[] => asksOf(message.toolCalls)

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

  if (call.name === 'computer_use') {
    return computerLabel(call.summary, tense)
  }

  if (call.name === 'hexbot_mail') {
    return mailLabel(call.summary, tense)
  }

  const workspace = workspaceLabel(call.name, call.summary, tense)

  if (workspace) {
    return workspace
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
  hexbot_passwords: 'is signing in',
  hexbot_plugins: 'is looking at plugins',
  hexbot_share_file: 'is sharing a file',
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

  if (call.name === 'computer_use') {
    return `${name} is ${computerLabel(call.summary, 'live').replace(/^\w/, c => c.toLowerCase())}`
  }

  if (call.name === 'hexbot_mail') {
    return `${name} is ${mailLabel(call.summary, 'live').replace(/^\w/, c => c.toLowerCase())}`
  }

  const workspace = workspaceLabel(call.name, call.summary, 'live')

  if (workspace) {
    return `${name} is ${workspace.replace(/^\w/, c => c.toLowerCase())}`
  }

  return `${name} ${ACTIVITY[call.name] ?? `is using ${humanize(call.name)}`}`
}

/**
 * The face a bot wears while it works: thinking, searching, reading, writing,
 * listening for someone's answer, working, or on the computer.
 */
export type LiveMood =
  | 'computer'
  | 'listening'
  | 'reading'
  | 'searching'
  | 'thinking'
  | 'working'
  | 'writing'

/** The step the status line and the face follow; an ask in progress has its own row. */
const runningStep = (message: Message) =>
  message.toolCalls.findLast(call => call.status === 'running' && call.name !== ASKING_TOOL)

/**
 * The face a bot wears over a message while it streams: thinking before
 * anything happens; while a step runs, the face of that step (peering while
 * it searches, eyes down the page while it reads, a pencil while it writes,
 * a pointer on the computer); writing while its words stream. None once the
 * message is done.
 */
export function liveMood(message: Message): LiveMood | undefined {
  if (!message.streaming) {
    return undefined
  }

  const running = runningStep(message)

  if (running && !message.checking) {
    return stepMood(running)
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

/**
 * The live status line's words: the running step ("Opening" "Taobao"), else
 * what the bot does between steps: "Thinking…" before anything happens,
 * "Typing…" while it writes its reply, "Working…" otherwise. While Auto mode
 * checks a step the line only says the bot is working; the step has not run.
 */
export function workLabel(message: Message): WorkLabel {
  const running = message.checking ? undefined : runningStep(message)

  if (running) {
    return stepLabel(running, connectorName(running.name))
  }

  if (!message.streaming || message.checking || message.activity) {
    return phaseLabel('working')
  }

  if (message.text) {
    return phaseLabel('typing')
  }

  return phaseLabel(message.thinking || !message.toolCalls.length ? 'thinking' : 'working')
}

/** The line as a sentence about the bot, for screen readers: "Scout is opening Taobao". */
export function workSentence(name: string, label: WorkLabel): string {
  const words = `${label.verb}${label.object ? ` ${label.object}` : ''}`.replace(/…$/, '')

  return `${name} is ${words.charAt(0).toLowerCase()}${words.slice(1)}`
}

/**
 * The live face of every section with a reply streaming in an open
 * transcript, by section. The sidebar and the header read it so they wear
 * the face the chat shows on that reply.
 */
export function liveMoodsOf(
  bySession: Record<
    string,
    { messages: Message[]; sectionId?: string; streamingMessageId: null | string }
  >
): Record<string, LiveMood> {
  const moods: Record<string, LiveMood> = {}

  for (const { messages, sectionId, streamingMessageId } of Object.values(bySession)) {
    const message = streamingMessageId
      ? messages.findLast(item => item.id === streamingMessageId)
      : undefined

    const mood = message && liveMood(message)

    if (sectionId && mood) {
      moods[sectionId] = mood
    }
  }

  return moods
}
