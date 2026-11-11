/**
 * The words on a bot's live status line, and the face it wears with them:
 * "Opening Taobao", "Searching the web for CER dates", "Typing…". Built from
 * the step the bot is running and its arguments, so nothing is asked of the
 * model and prompts and their cache are left alone. Mobile uses the same
 * rules.
 */

import { baseName } from './media'
import { siteName } from './tags'

/** A step as either client holds it: the tool, the daemon's context line, its arguments. */
export interface WorkStep {
  args?: unknown
  name: string
  /** The daemon's one-line context: a `computer_use` or `hexbot_mail` action, a path, a query. */
  summary?: null | string
}

/**
 * A status line in two parts: what the bot does, then what it does it to.
 * The second part is the specific one and is drawn stronger.
 */
export interface WorkLabel {
  object?: string
  verb: string
}

/** The face that goes with a step. */
export type StepMood = 'computer' | 'listening' | 'reading' | 'searching' | 'working' | 'writing'

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return {}
    }
  }

  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : Array.isArray(value)
      ? text(value[0])
      : ''

const OBJECT_MAX = 60

const short = (value: string) =>
  value.length > OBJECT_MAX ? `${value.slice(0, OBJECT_MAX - 1)}…` : value

/** A page by its site's name, a file by its own. */
const pageName = (target: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)
    ? (siteName(target) ?? short(target))
    : short(baseName(target))

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

const humanize = (name: string) => name.replace(/[_-]+/g, ' ').trim() || 'a tool'

/** The bots' computer, by `computer_use` action. */
const COMPUTER: Record<string, WorkLabel> = {
  click: { object: 'on the computer', verb: 'Clicking' },
  double_click: { object: 'on the computer', verb: 'Clicking' },
  drag: { object: 'on the computer', verb: 'Dragging' },
  key: { object: 'on the computer', verb: 'Pressing keys' },
  launch: { object: 'an app', verb: 'Opening' },
  middle_click: { object: 'on the computer', verb: 'Clicking' },
  move: { object: 'the pointer', verb: 'Moving' },
  open: { object: 'a page', verb: 'Opening' },
  right_click: { object: 'on the computer', verb: 'Clicking' },
  screenshot: { object: 'the screen', verb: 'Looking at' },
  scroll: { object: 'on the computer', verb: 'Scrolling' },
  shell: { object: 'a command', verb: 'Running' },
  type: { object: 'on the computer', verb: 'Typing' },
  wait: { object: 'on the computer', verb: 'Waiting' },
  windows: { object: 'the windows', verb: 'Checking' }
}

/** Steps whose words never change. */
const FIXED: Record<string, WorkLabel> = {
  clarify: { object: 'you', verb: 'Asking' },
  codemode: { object: 'code', verb: 'Running' },
  cronjob_manage: { object: 'a scheduled job', verb: 'Setting up' },
  delegate_task: { object: 'a task', verb: 'Handing off' },
  execute_code: { object: 'code', verb: 'Running' },
  hexbot_bots: { object: 'your bots', verb: 'Looking after' },
  hexbot_connector_read: { object: 'a connected service', verb: 'Reading from' },
  hexbot_connector_write: { object: 'a connected service', verb: 'Writing to' },
  hexbot_jobs: { object: 'scheduled jobs', verb: 'Setting up' },
  hexbot_notify: { object: 'you', verb: 'Notifying' },
  hexbot_passwords: { object: 'to a site', verb: 'Signing in' },
  hexbot_plugins: { object: 'plugins', verb: 'Checking' },
  hexbot_react: { object: 'to your message', verb: 'Reacting' },
  hexbot_rooms: { object: 'rooms', verb: 'Setting up' },
  hexbot_settings: { object: 'settings', verb: 'Checking' },
  image_generate: { object: 'an image', verb: 'Making' },
  skill_manage: { object: 'a skill', verb: 'Updating' },
  skills_list: { object: 'its skills', verb: 'Checking' },
  terminal: { object: 'a command', verb: 'Running' },
  text_to_speech: { object: 'a voice reply', verb: 'Recording' },
  todo_list: { object: 'the next steps', verb: 'Planning' },
  video_generate: { object: 'a video', verb: 'Making' },
  vision_analyze: { object: 'an image', verb: 'Looking at' }
}

/**
 * The user's calendar, tasks, files, documents, spreadsheets and
 * presentations, by tool and action. The daemon sends the action as the
 * call's summary. The first pair is for an action this app doesn't know.
 */
const WORKSPACE: Record<string, Record<string, [live: string, done: string]>> = {
  hexbot_calendar: {
    '': ['Using the calendar', 'Used the calendar'],
    calendars: ['Checking calendars', 'Checked calendars'],
    create: ['Adding an event', 'Added an event'],
    delete: ['Deleting an event', 'Deleted an event'],
    list: ['Checking the calendar', 'Checked the calendar'],
    update: ['Changing an event', 'Changed an event']
  },
  hexbot_documents: {
    '': ['Working on a document', 'Worked on a document'],
    append: ['Adding to a document', 'Added to a document'],
    create: ['Writing a document', 'Wrote a document'],
    read: ['Reading a document', 'Read a document'],
    replace: ['Editing a document', 'Edited a document'],
    search: ['Searching documents', 'Searched documents']
  },
  hexbot_drive: {
    '': ['Working with your files', 'Worked with your files'],
    download: ['Downloading a file', 'Downloaded a file'],
    read: ['Reading a file', 'Read a file'],
    search: ['Searching your files', 'Searched your files'],
    upload: ['Uploading a file', 'Uploaded a file']
  },
  hexbot_presentations: {
    '': ['Working on a presentation', 'Worked on a presentation'],
    add: ['Adding slides', 'Added slides'],
    create: ['Making a presentation', 'Made a presentation'],
    read: ['Reading a presentation', 'Read a presentation'],
    replace: ['Editing a presentation', 'Edited a presentation'],
    search: ['Searching presentations', 'Searched presentations']
  },
  hexbot_spreadsheets: {
    '': ['Working on a spreadsheet', 'Worked on a spreadsheet'],
    append: ['Adding rows', 'Added rows'],
    create: ['Making a spreadsheet', 'Made a spreadsheet'],
    read: ['Reading a spreadsheet', 'Read a spreadsheet'],
    search: ['Searching spreadsheets', 'Searched spreadsheets'],
    write: ['Writing to a spreadsheet', 'Wrote to a spreadsheet']
  },
  hexbot_tasks: {
    '': ['Using your tasks', 'Used your tasks'],
    add: ['Adding a task', 'Added a task'],
    delete: ['Deleting a task', 'Deleted a task'],
    list: ['Checking tasks', 'Checked tasks'],
    lists: ['Checking task lists', 'Checked task lists'],
    update: ['Updating a task', 'Updated a task']
  }
}

/** "Reading a document", or null for a tool that isn't one of these. */
export function workspaceLabel(
  tool: string,
  action: null | string | undefined,
  tense: 'done' | 'live'
): null | string {
  const actions = WORKSPACE[tool]

  if (!actions) {
    return null
  }

  return (actions[(action ?? '').trim()] ?? actions['']!)[tense === 'live' ? 0 : 1]
}

/**
 * The connector behind an `mcp__<server>__<tool>` or `mcp_<server>_<tool>`
 * call, by its first segment. The web app knows the loaded servers and passes
 * a better name as `service`.
 */
function serviceOf(tool: string): null | string {
  const server = /^mcp__(.+?)__/.exec(tool)?.[1] ?? /^mcp_([^_]+)_/.exec(tool)?.[1]

  return server ? capital(humanize(server)) : null
}

/**
 * What a running step reads as: "Opening" "Taobao", "Reading" "notes.md",
 * "Searching the web for" "CER test dates". A command or a script is never
 * quoted; a page is named by its site and a file by its own name.
 */
export function stepLabel(step: WorkStep, service?: null | string): WorkLabel {
  const args = record(step.args)
  const context = text(step.summary)
  const connector = service ?? serviceOf(step.name)

  if (connector) {
    return { object: connector, verb: 'Using' }
  }

  const workspace = workspaceLabel(step.name, text(args.action) || context, 'live')

  if (workspace) {
    // "Checking" "the calendar": the first word is what it does.
    const cut = workspace.indexOf(' ')

    return { object: workspace.slice(cut + 1), verb: workspace.slice(0, cut) }
  }

  switch (step.name) {
    case 'computer_use': {
      const action = text(args.action) || context
      const label = COMPUTER[action] ?? { object: 'the computer', verb: 'Using' }
      const target = action === 'open' ? text(args.url) : action === 'launch' ? text(args.app) : ''

      if (!target) {
        return label
      }

      return { object: action === 'launch' ? capital(short(target)) : pageName(target), verb: 'Opening' }
    }

    case 'hexbot_mail': {
      const action = text(args.action) || context
      const query = text(args.query)

      if (action === 'draft') {
        return { object: 'an email', verb: 'Drafting' }
      }

      if (action === 'read') {
        return { object: 'an email', verb: 'Reading' }
      }

      if (action === 'search') {
        return query
          ? { object: short(query), verb: 'Searching email for' }
          : { object: 'email', verb: 'Searching' }
      }

      return { object: 'email', verb: 'Checking' }
    }

    case 'web_search':
    case 'x_search': {
      const query = text(args.query) || context
      const where = step.name === 'x_search' ? 'X' : 'the web'

      return query
        ? { object: short(query), verb: `Searching ${where} for` }
        : { object: where, verb: 'Searching' }
    }

    case 'session_search': {
      const query = text(args.query)

      return query
        ? { object: short(query), verb: 'Searching past conversations for' }
        : { object: 'past conversations', verb: 'Searching' }
    }

    case 'search_files': {
      const pattern = text(args.pattern) || context

      return pattern
        ? { object: short(pattern), verb: 'Searching files for' }
        : { object: 'files', verb: 'Searching' }
    }

    case 'browser_navigate':
    case 'web_extract': {
      const url = text(args.urls) || text(args.url) || context
      const verb = step.name === 'web_extract' ? 'Reading' : 'Opening'

      return { object: url ? pageName(url) : 'a page', verb }
    }

    case 'ls':

    case 'patch':

    case 'read_file':
    case 'write_file': {
      const path = text(args.path) || text(args.file_path) || context

      const [verb, generic] = (
        {
          ls: ['Looking in', 'a folder'],
          patch: ['Editing', 'a file'],
          read_file: ['Reading', 'a file'],
          write_file: ['Writing', 'a file']
        } as const
      )[step.name]

      return { object: path ? short(baseName(path)) : generic, verb }
    }

    case 'hexbot_share_file': {
      const path = text(args.path) || context

      return { object: path ? short(baseName(path)) : 'a file', verb: 'Sharing' }
    }

    case 'hexbot_show_html': {
      const title = text(args.title) || context

      return { object: title ? short(title) : 'a visual', verb: 'Drawing' }
    }

    case 'skill_view': {
      const name = text(args.name) || context

      return { object: name ? `the ${short(name)} skill` : 'a skill', verb: 'Reading' }
    }

    case 'memory': {
      const action = text(args.action)

      return action === 'read'
        ? { object: text(args.notes) ? 'its notes' : 'its memory', verb: 'Reading' }
        : action === 'note'
          ? { object: 'a note', verb: 'Writing' }
          : { object: 'its memory', verb: 'Updating' }
    }

    case 'hexbot_soul':
      return text(args.action) === 'read' || !text(args.text)
        ? { object: 'its soul', verb: 'Reading' }
        : { object: 'its soul', verb: 'Updating' }

    case 'hexbot_heartbeat':
      return text(args.action) === 'write'
        ? { object: 'its checklist', verb: 'Updating' }
        : { object: 'its checklist', verb: 'Reading' }
    case 'message_bot': {
      const to = text(args.to) || context

      return { object: to || 'a teammate', verb: args.wait === false ? 'Messaging' : 'Asking' }
    }

    default:
      return FIXED[step.name] ?? { object: humanize(step.name), verb: 'Using' }
  }
}

/** What the bot does between steps. */
export type WorkPhase = 'thinking' | 'typing' | 'working'

const PHASES: Record<WorkPhase, WorkLabel> = {
  thinking: { verb: 'Thinking…' },
  typing: { verb: 'Typing…' },
  working: { verb: 'Working…' }
}

/** "Thinking…" before anything happens, "Typing…" while the reply is written. */
export const phaseLabel = (phase: WorkPhase): WorkLabel => PHASES[phase]

/** The whole line as one string, for screen readers and one-line places. */
export const labelText = (label: WorkLabel) =>
  label.object ? `${label.verb} ${label.object}` : label.verb

const SEARCHING = new Set(['ls', 'search_files', 'session_search', 'skills_list', 'web_search', 'x_search'])

const READING = new Set(['read_file', 'skill_view', 'vision_analyze', 'web_extract'])

const WRITING = new Set(['hexbot_show_html', 'patch', 'skill_manage', 'todo_list', 'write_file'])

const WORKSPACE_READS = new Set(['calendars', 'download', 'list', 'lists', 'read'])

const WORKSPACE_WRITES = new Set(['add', 'append', 'create', 'replace', 'update', 'upload', 'write'])

const LISTENING = new Set(['clarify', 'delegate_task', 'message_bot'])

/**
 * The face for a step: a pointer on the computer, peering while it looks for
 * something, eyes down the page while it reads, a pencil while it writes,
 * turned to listen while it waits on someone.
 */
export function stepMood(step: WorkStep): StepMood {
  const action = text(record(step.args).action) || text(step.summary)

  if (step.name === 'computer_use') {
    return 'computer'
  }

  if (step.name === 'hexbot_mail') {
    return action === 'search' ? 'searching' : action === 'draft' ? 'writing' : 'reading'
  }

  if (workspaceLabel(step.name, action, 'live')) {
    return action === 'search'
      ? 'searching'
      : WORKSPACE_READS.has(action)
        ? 'reading'
        : WORKSPACE_WRITES.has(action)
          ? 'writing'
          : 'working'
  }

  if (step.name === 'memory' || step.name === 'hexbot_soul' || step.name === 'hexbot_heartbeat') {
    return stepLabel(step).verb === 'Reading' ? 'reading' : 'writing'
  }

  return SEARCHING.has(step.name)
    ? 'searching'
    : READING.has(step.name)
      ? 'reading'
      : WRITING.has(step.name)
        ? 'writing'
        : LISTENING.has(step.name)
          ? 'listening'
          : 'working'
}
