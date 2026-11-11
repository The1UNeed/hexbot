/**
 * Asks: one bot messaging another with `message_bot`. Read off a turn's tool
 * calls for the row that marks it in a conversation: "Research is asking
 * Writer", "Writer helped", "Messaged Writer". Pure, so the mobile app reads
 * asks with the same rules.
 */

/** A tool call as either client holds it. */
export interface AskCall {
  args?: unknown
  name: string
  /** Pi's `{content, details}` live, a JSON string from history, or plain text. */
  result?: unknown
  status: 'error' | 'ok' | 'running'
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

/**
 * The daemon's result as an object. Live calls carry Pi's `{content, details}` with the daemon's
 * result in `details`; restored history carries the result as a JSON string.
 */
function resultOf(call: AskCall): Record<string, unknown> {
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
  string(argsOf(call.args).to) || call.summary?.trim() || null

/**
 * The bots this turn asked, one entry per bot in first-ask order. Asking the
 * same bot twice is one row: the thread between the two is one conversation.
 * Running while any ask to that bot still runs.
 */
export function asksOf(calls: readonly AskCall[]): Ask[] {
  const byTarget = new Map<string, Ask>()

  for (const call of calls) {
    if (call.name !== ASKING_TOOL) {
      continue
    }

    const target = askTarget(call)
    const key = target ?? ''
    const previous = byTarget.get(key)
    const result = resultOf(call)
    const sectionId = string(result.section_id) || previous?.sectionId || null

    const status: Ask['status'] =
      call.status === 'running' || previous?.status === 'running' ? 'running' : call.status

    // One row per bot: it "helped" if any ask to it waited for a reply.
    const sent = result.status === 'sent' && (previous?.sent ?? true)

    byTarget.set(key, { sectionId, sent, status, target })
  }

  return [...byTarget.values()]
}

/**
 * The ask row's line around the other bot's name: "Research is asking" Writer
 * while it runs, Writer "helped" once the reply is in, "Messaged" Writer when
 * no reply was waited for.
 */
export function askWords(
  ask: Pick<Ask, 'sent' | 'status'>,
  sender: null | string
): { after: string; before: string } {
  if (ask.status === 'running') {
    return { after: '', before: sender ? `${sender} is asking` : 'Asking' }
  }

  if (ask.status === 'error') {
    return { after: '', before: 'Asked' }
  }

  return ask.sent ? { after: '', before: 'Messaged' } : { after: 'helped', before: '' }
}

/**
 * The same line as one string: "Research is asking Writer", "Writer helped",
 * "Messaged Writer". "A teammate" stands in when the call did not name the
 * target.
 */
export function askLabel(
  ask: Pick<Ask, 'sent' | 'status'>,
  target: null | string,
  sender: null | string
): string {
  const { after, before } = askWords(ask, sender)
  const name = target ?? (before ? 'a teammate' : 'A teammate')

  return [before, name, after].filter(Boolean).join(' ')
}

