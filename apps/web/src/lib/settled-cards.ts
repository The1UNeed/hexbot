/**
 * Answered cards rebuilt from the tool call that showed them. A live card
 * lives in the app's memory only, so after a reload, a reconnect or on
 * another app, a draft card, sign-in card or plugin card would vanish from
 * the chat. The call's arguments and stored result say what the card showed
 * and how the user answered, so both apps draw it again from history.
 * Pure, so the mobile app can share it.
 */
import type {
  EmailDraft,
  EmailDraftAnswer,
  EmailDraftForm,
  MailService,
  PluginForm,
  SignInForm
} from './types'

export interface SettledCard {
  /** `once` when the user went ahead, `deny` when they closed the card. */
  decision: 'deny' | 'once'
  form: EmailDraftForm | PluginForm | SignInForm
  /** The user agreed, but what the card was for didn't work. */
  failed?: true
  /** A draft card's email as it went, and whether it was sent or saved. */
  outcome?: EmailDraftAnswer
}

/** The tool call as either app keeps it. */
export interface CardTool {
  args: unknown
  name: string
  /** The tool's result: its JSON text from history, or the object a live event carries. */
  result: unknown
  status: 'error' | 'ok' | 'running' | 'unresolved'
}

/**
 * What each tool returns when the user closed its card, word for word as the
 * daemon writes it (`runtime_mail.rs`, `runtime_passwords.rs`,
 * `runtime_plugins.rs`). Any other failure came before a card showed.
 */
const CLOSED = {
  hexbot_mail: 'The user closed the draft without sending it.',
  hexbot_passwords: 'The user closed the sign-in card.',
  hexbot_plugins: 'The user said no.'
} as const

/**
 * A plugin or sign-in card the user agreed on whose change then failed
 * (`after_agreeing` in `runtime.rs`).
 */
const AGREED = "The user agreed on the card, but it didn't work:"

const MAIL_NAMES: Record<MailService, string> = {
  google: 'Gmail',
  imap: 'IMAP mail',
  microsoft: 'Outlook'
}

type Fields = Record<string, unknown>

const record = (value: unknown): Fields | null => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The words of a live result's content, as history stores them. */
const contentText = (fields: Fields) =>
  Array.isArray(fields.content) ? fields.content.map(part => text(record(part)?.text)).join('') : ''

/**
 * What a call returned. History keeps the tool's JSON as text; a live event
 * carries Pi's result, `{ content, details }`, where `details` is that JSON.
 */
const output = (result: unknown): Fields | null => {
  const fields = record(result)

  if (!fields || !Array.isArray(fields.content)) {
    return fields
  }

  const details = record(fields.details)

  return details && Object.keys(details).length ? details : record(contentText(fields))
}

/** The error text a failed call stored, from history or a live event. */
const failure = (result: unknown) => {
  const fields = record(result)

  return fields ? text(fields.error) || contentText(fields) : text(result)
}

const closed = (tool: CardTool, name: keyof typeof CLOSED) =>
  tool.status === 'error' && failure(tool.result).startsWith(CLOSED[name])

const service = (value: unknown): MailService | null =>
  value === 'google' || value === 'microsoft' || value === 'imap' ? value : null

/** The host of a sign-in page's address, as the daemon names its site. */
const host = (url: string) => {
  try {
    const { hostname, protocol } = new URL(url)

    // As `passwords::host` names it: the host alone, without www.
    return protocol === 'http:' || protocol === 'https:'
      ? hostname.toLowerCase().replace(/^www\./, '')
      : ''
  } catch {
    return ''
  }
}

/** The user agreed on the card this call showed, and the work then failed. */
export const agreedThenFailed = (tool: Pick<CardTool, 'result' | 'status'>) =>
  tool.status === 'error' && failure(tool.result).startsWith(AGREED)

/** A readable name from a plugin id, for results from before they named it. */
const plainName = (id: string) => {
  const name = (id.split(':').at(-1) ?? id).replace(/[-_]+/g, ' ').trim()

  return name ? name[0]!.toUpperCase() + name.slice(1) : id
}

function emailCard(tool: CardTool, args: Fields): SettledCard | null {
  if (args.action !== 'draft') {
    return null
  }

  const result = tool.status === 'ok' ? output(tool.result) : null
  const went = result && (result.sent === true || result.saved_to_drafts === true)

  if (!went && !closed(tool, 'hexbot_mail')) {
    return null
  }

  const from = result ?? args
  const mail = service(result?.account) ?? service(args.account) ?? 'imap'

  // What went comes from the result, which keeps no Bcc; a closed card shows
  // the bot's draft.
  const draft: EmailDraft = {
    bcc: strings(from.bcc),
    body: text(from.body),
    cc: strings(from.cc),
    reply_to: text(args.reply_to) || null,
    subject: text(from.subject),
    to: strings(from.to)
  }

  return {
    decision: went ? 'once' : 'deny',
    form: {
      ...draft,
      from: '',
      kind: 'email_draft',
      service: mail,
      service_name: MAIL_NAMES[mail]
    },
    ...(went && { outcome: { draft, mail_action: result.sent === true ? 'send' : 'save' } })
  }
}

function signInCard(tool: CardTool, args: Fields): SettledCard | null {
  if (args.action !== 'ask') {
    return null
  }

  const result = tool.status === 'ok' ? output(tool.result) : null
  const saved = Boolean(result && typeof result.id === 'string')
  const failed = agreedThenFailed(tool)

  if (!saved && !failed && !closed(tool, 'hexbot_passwords')) {
    return null
  }

  const url = text(args.url)
  const site = text(result?.site) || host(url)
  // A card for a saved login, asked by its id alone, was named from the
  // vault; a closed one stored no name, so it keeps a plain one.
  const title = text(result?.title) || text(args.title).trim() || site || 'Sign-in'

  return {
    decision: saved || failed ? 'once' : 'deny',
    ...(failed && { failed: true as const }),
    form: {
      kind: 'sign_in',
      site,
      title,
      ...(url && { url }),
      ...(text(result?.username || args.username) && {
        username: text(result?.username || args.username)
      })
    }
  }
}

function pluginCard(tool: CardTool, args: Fields): SettledCard | null {
  const action = args.action

  if (action !== 'install' && action !== 'enable' && action !== 'setup') {
    return null
  }

  const result = tool.status === 'ok' ? output(tool.result) : null

  // Turning on a plugin that already was shows no card.
  const done = Boolean(result && typeof result.plugin === 'string' && result.note !== 'Already on.')

  const failed = agreedThenFailed(tool)

  if (!done && !failed && !closed(tool, 'hexbot_plugins')) {
    return null
  }

  const id =
    text(result?.plugin) || text(args.id) || (text(args.name) && `package:${text(args.name)}`)

  if (!id) {
    return null
  }

  return {
    decision: done || failed ? 'once' : 'deny',
    ...(failed && { failed: true as const }),
    form: {
      action,
      bot: text(args.bot),
      ...(action === 'install' &&
        text(args.description) && { description: text(args.description) }),
      fields: [],
      id,
      kind: 'plugin',
      name: text(result?.name) || (action === 'install' && text(args.name)) || plainName(id)
    }
  }
}

/** The answered card a finished tool call showed, or null when it showed none. */
export function settledCard(tool: CardTool): SettledCard | null {
  if (tool.status === 'running' || tool.status === 'unresolved') {
    return null
  }

  const args = record(tool.args)

  if (!args) {
    return null
  }

  switch (tool.name) {
    case 'hexbot_mail':
      return emailCard(tool, args)

    case 'hexbot_passwords':
      return signInCard(tool, args)

    case 'hexbot_plugins':
      return pluginCard(tool, args)

    default:
      return null
  }
}
