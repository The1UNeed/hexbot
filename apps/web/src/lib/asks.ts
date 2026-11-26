/**
 * Asks: one bot messaging another with `message_bot`. Read off a turn's tool
 * calls for the centered row that marks it in a conversation: "Messaging
 * Writer", "Message from Writer", "Messaged Writer". Pure, so the mobile app
 * reads asks with the same rules.
 */

/** A tool call as either client holds it. */
export interface AskCall {
  args?: unknown
  name: string
  /** Stable per-call occurrence identifier from the daemon, when available. */
  occurrenceId?: string
  /** Pi's `{content, details}` live, a JSON string from history, or plain text. */
  result?: unknown
  status: 'error' | 'ok' | 'running' | 'unresolved'
  /** The daemon's context line: who was asked. */
  summary?: null | string
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
  status: AskCall['status']
  /** The target bot's name; null when the call came without its arguments. */
  target: null | string
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return record(value)
  }

  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}

/**
 * The daemon's result as an object. Live calls carry Pi's `{content, details}` with the daemon's
 * result in `details` (either directly or serialized as JSON) or in `content[i].text`; restored
 * history carries the result as a JSON string.
 */
function resultOf(call: AskCall): Record<string, unknown> {
  const parsed = parseObject(call.result)

  if ('details' in parsed) {
    const details = parseObject(parsed.details)

    if (Object.keys(details).length) {
      return details
    }
  }

  if (Array.isArray(parsed.content)) {
    for (const item of parsed.content) {
      const text = string(record(item).text)

      if (text) {
        const inner = parseObject(text)

        if (Object.keys(inner).length) {
          return inner
        }
      }
    }
  }

  return parsed
}

/** A call's arguments, which history may keep as a JSON string. */
function argsOf(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string') {
    return record(args)
  }

  try {
    return record(JSON.parse(args))
  } catch {
    return {}
  }
}

/** Who a `message_bot` call asked: its `to` argument, else the daemon's context line. */
export const askTarget = (call: AskCall): null | string =>
  string(argsOf(call.args).to) || call.summary || null

/**
 * True when two `message_bot` calls have identical target, exact text, and wait mode
 * so interchangeable hydrated/running entries can be consumed one at a time.
 */
export function askSameSignature(a: AskCall, b: AskCall): boolean {
  const targetA = askTarget(a)
  const targetB = askTarget(b)

  if (targetA !== targetB) {
    return false
  }

  const parsedA = argsOf(a.args)
  const parsedB = argsOf(b.args)
  const textA = typeof parsedA.text === 'string' ? parsedA.text : undefined
  const textB = typeof parsedB.text === 'string' ? parsedB.text : undefined

  if (textA !== textB) {
    return false
  }

  return askExpectedSent(a.args) === askExpectedSent(b.args)
}

/**
 * Whether a `message_bot` call's arguments specify an async send (`wait: false` -> `true`)
 * or a synchronous reply (`wait !== false` -> `false`). Returns `null` when arguments are absent.
 */
export function askExpectedSent(args: unknown): boolean | null {
  const parsed = argsOf(args)

  if (!Object.keys(parsed).length) {
    return null
  }

  return parsed.wait === false
}

/**
 * True when two untagged `message_bot` calls can refer to the same occurrence:
 * compatible target, wait/send mode, and (when both settled) outcome and thread.
 */
export function asksCompatible(a: AskCall, b: AskCall): boolean {
  if (a.occurrenceId && b.occurrenceId) {
    return a.occurrenceId === b.occurrenceId
  }

  const targetA = askTarget(a)
  const targetB = askTarget(b)

  if (targetA && targetB && targetA !== targetB) {
    return false
  }

  const parsedA = argsOf(a.args)
  const parsedB = argsOf(b.args)

  if (
    typeof parsedA.text === 'string' &&
    typeof parsedB.text === 'string' &&
    parsedA.text !== parsedB.text
  ) {
    return false
  }

  const expectedA = askExpectedSent(a.args)
  const expectedB = askExpectedSent(b.args)

  if (expectedA !== null && expectedB !== null && expectedA !== expectedB) {
    return false
  }

  const askA = asksOf([a])[0]
  const askB = asksOf([b])[0]

  if (!askA || !askB) {
    return true
  }

  if (a.status === 'running' && b.status === 'running') {
    const sentA = askExpectedSent(a.args)
    const sentB = askExpectedSent(b.args)

    return sentA === null || sentB === null || sentA === sentB
  }

  if (a.status === 'running' || b.status === 'running') {
    const running = a.status === 'running' ? a : b
    const settled = a.status === 'running' ? askB : askA

    if (settled.status === 'ok') {
      const expectedSent = askExpectedSent(running.args)

      if (expectedSent !== null && expectedSent !== settled.sent) {
        return false
      }
    }

    return true
  }

  if (askA.status !== askB.status) {
    return false
  }

  if (askA.status === 'ok' && askA.sent !== askB.sent) {
    return false
  }

  if (askA.sectionId && askB.sectionId && askA.sectionId !== askB.sectionId) {
    return false
  }

  if (askA.status === 'ok') {
    const resultA = resultOf(a)
    const resultB = resultOf(b)
    const replyA = string(resultA.reply).trim()
    const replyB = string(resultB.reply).trim()

    if (replyA && replyB && replyA !== replyB) {
      return false
    }

    const msgIdA = string(resultA.message_id).trim()
    const msgIdB = string(resultB.message_id).trim()

    if (msgIdA && msgIdB && msgIdA !== msgIdB) {
      return false
    }
  } else if (askA.status === 'error') {
    const errA = string(resultOf(a).error).trim()
    const errB = string(resultOf(b).error).trim()

    if (errA && errB && errA !== errB) {
      return false
    }
  }

  return true
}

/**
 * The bots this turn asked, one entry per bot in first-ask order. Asking the
 * same bot twice is one row: the thread between the two is one conversation.
 * Precedence is order-independent and matches room SQL aggregation: running >
 * any reply received > any async send succeeded > all calls failed.
 */
export function asksOf(calls: readonly AskCall[]): Ask[] {
  const byTarget = new Map<
    string,
    {
      replied: boolean
      running: boolean
      sectionId: null | string
      sent: boolean
      target: null | string
    }
  >()

  for (const call of calls) {
    if (call.name !== ASKING_TOOL) {
      continue
    }

    const target = askTarget(call)
    const key = target ?? ''

    const entry = byTarget.get(key) ?? {
      replied: false,
      running: false,
      sectionId: null,
      sent: false,
      target
    }

    const result = resultOf(call)
    entry.sectionId = string(result.section_id) || entry.sectionId

    if (call.status === 'running') {
      entry.running = true
    } else if (call.status === 'ok') {
      const explicitReply = typeof result.reply === 'string' || result.status === 'replied'

      if (result.status === 'sent' || (!explicitReply && askExpectedSent(call.args) === true)) {
        entry.sent = true
      } else {
        entry.replied = true
      }
    }

    byTarget.set(key, entry)
  }

  return [...byTarget.values()].map(entry => {
    if (entry.running) {
      return { sectionId: entry.sectionId, sent: false, status: 'running', target: entry.target }
    }

    if (entry.replied) {
      return { sectionId: entry.sectionId, sent: false, status: 'ok', target: entry.target }
    }

    if (entry.sent) {
      return { sectionId: entry.sectionId, sent: true, status: 'ok', target: entry.target }
    }

    return { sectionId: entry.sectionId, sent: false, status: 'error', target: entry.target }
  })
}

/**
 * The ask row's line around the other bot's pill: "Messaging" Writer while it
 * runs, "Message from" Writer once the reply is in, "Messaged" Writer when no
 * reply was waited for. Keeping the bot on the right across every state lets
 * the pill stay anchored while the status word settles smoothly.
 */
export function askWords(
  ask: Pick<Ask, 'sent' | 'status'>,
  _sender?: null | string
): { after: string; before: string } {
  if (ask.status === 'running') {
    return { after: '', before: 'Messaging' }
  }

  if (ask.status === 'error') {
    return { after: '', before: 'Asked' }
  }

  return ask.sent ? { after: '', before: 'Messaged' } : { after: '', before: 'Message from' }
}

/**
 * The same line as one string: "Messaging Writer", "Message from Writer",
 * "Messaged Writer". "a teammate" stands in when the call did not name the
 * target.
 */
export function askLabel(
  ask: Pick<Ask, 'sent' | 'status'>,
  target: null | string,
  sender?: null | string
): string {
  const { after, before } = askWords(ask, sender)
  const name = target ?? (before ? 'a teammate' : 'A teammate')

  return [before, name, after].filter(Boolean).join(' ')
}
