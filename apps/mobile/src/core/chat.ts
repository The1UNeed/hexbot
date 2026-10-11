import type { GatewayEvent } from '@hermes/shared'
import type {
  Bot,
  ChatMessage,
  ChatState,
  ChatTool,
  PendingApproval,
  PendingQuestion,
  TurnState
} from './types'
export const emptyTurn = (): TurnState => ({
  streaming: '',
  interim: [],
  busy: false,
  waiting: false,
  resumedWaiting: false,
  waitingRevision: 0,
  activity: '',
  tools: [],
  approvals: [],
  questions: [],
  settlements: {},
  error: null
})
export const emptyChat = (): ChatState => ({ ...emptyTurn(), messages: [], turns: {} })
const textContent = (raw: unknown): string =>
  typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw
          .map(part =>
            typeof part === 'string' ? part : part?.type === 'text' ? (part.text ?? '') : ''
          )
          .join('\n')
      : ''
export const parseArgs = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
const detailOf = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
const requestKey = (kind: string, sessionId: string, requestId: string) =>
  JSON.stringify([kind, sessionId, requestId])
const answerMap = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}
const choiceOf = (value: unknown) =>
  value === 'once' || value === 'session' || value === 'deny' ? value : undefined
const resumeAnswered = (state: ChatState, accepted: boolean, revision: number): ChatState =>
  accepted && state.busy && state.waiting && !state.approvals.length && !state.questions.length
    ? { ...state, waiting: false, resumedWaiting: true, waitingRevision: revision, activity: '' }
    : state

/** Only a roster wait naming this exact session can be superseded by its accepted answer. */
export function settledBot(bot: Bot, state: TurnState, sessionId: string | null): Bot {
  if (
    bot.status !== 'needs_you' ||
    !sessionId ||
    bot.status_detail?.session_id !== sessionId ||
    !state.resumedWaiting ||
    state.waiting ||
    state.approvals.length ||
    state.questions.length
  )
    return bot
  return {
    ...bot,
    status: state.busy ? 'working' : state.error ? 'stopped' : 'idle',
    status_detail: { ...bot.status_detail, text: state.activity, action: null }
  }
}

/** A successful roster read retires older evidence, but cannot undo answers accepted during it. */
export function rosterChat(state: ChatState, started: number): ChatState {
  return {
    ...state,
    resumedWaiting: state.resumedWaiting && state.waitingRevision > started,
    turns: Object.fromEntries(
      Object.entries(state.turns).map(([id, turn]) => [
        id,
        turn.waitingRevision > started ? turn : { ...turn, resumedWaiting: false }
      ])
    )
  }
}

/** Successful local responses use the same canonical projection as remote settlements. */
export function approvalResponse(
  pending: PendingApproval,
  choice: string,
  result: Record<string, unknown>
): GatewayEvent | undefined {
  if (result.resolved !== true) return
  const canonical = choiceOf(
    result.choice ??
      (choice === 'always' ? (pending.choices.includes('session') ? 'session' : 'once') : choice)
  )
  if (!canonical) return
  return {
    type: 'approval.resolved',
    session_id: pending.sessionId,
    payload: { request_id: pending.requestId, choice: canonical }
  }
}
export function clarifyResponse(
  pending: PendingQuestion,
  questionId: string,
  answer: string,
  result: Record<string, unknown>
): GatewayEvent {
  const answers =
    result.answers === undefined ? { [questionId]: answer } : answerMap(result.answers)
  const status =
    result.status === 'waiting' || result.status === 'answered'
      ? result.status
      : pending.questions.every(q => Object.hasOwn(answers, q.id))
        ? 'answered'
        : 'waiting'
  return {
    type: 'clarify.resolved',
    session_id: pending.sessionId,
    payload: { request_id: pending.requestId, answers, status }
  }
}
export function historyMessages(raw: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const args = new Map<string, unknown>()
  for (const value of raw) {
    const row = value as Record<string, unknown>
    if (row.hidden || row.display_kind === 'hidden') continue
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      args.set(String(call.id), parseArgs(call.function?.arguments))
    }
    if (row.role === 'tool') {
      let target = messages.at(-1)
      if (target?.role !== 'assistant') {
        target = { id: `history-tool-${messages.length}`, role: 'assistant', text: '' }
        messages.push(target)
      }
      const id = String(row.tool_call_id ?? row.tool_id ?? row.row_id)
      const tool: ChatTool = {
        id,
        name: String(row.name ?? 'tool'),
        args: row.args ?? args.get(id),
        detail: detailOf(row.text ?? row.content),
        status: row.is_error ? 'error' : 'ok'
      }
      target.tools = [...(target.tools ?? []), tool]
    } else if (row.role === 'user' || row.role === 'assistant') {
      const text = textContent(row.content ?? row.text)
      if (text || (Array.isArray(row.tool_calls) && row.tool_calls.length))
        messages.push({ id: String(row.id ?? `history-${messages.length}`), role: row.role, text })
    }
  }
  return messages
}
export function reduceChat(state: ChatState, event: GatewayEvent): ChatState {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const text = typeof p.text === 'string' ? p.text : ''
  const sessionId = event.session_id ?? ''
  const revision = (event as GatewayEvent & { mobileRevision?: number }).mobileRevision ?? 0
  switch (event.type) {
    case 'message.start':
      return {
        ...state,
        busy: true,
        waiting: false,
        resumedWaiting: false,
        streaming: '',
        interim: [],
        tools: [],
        error: null
      }
    case 'message.delta':
      return { ...state, busy: true, streaming: state.streaming + text }
    case 'message.interim':
      return {
        ...state,
        interim: [...state.interim, p.already_streamed ? state.streaming || text : text],
        streaming: p.already_streamed ? '' : state.streaming
      }
    case 'message.complete': {
      const parts = [...state.interim, text || state.streaming].filter(Boolean)
      if (!parts.length && state.tools.length) parts.push('')
      const settlements = { ...state.settlements }
      for (const card of state.approvals)
        settlements[requestKey('approval', card.sessionId, card.requestId)] = { closed: true }
      for (const card of state.questions) {
        const key = requestKey('clarify', card.sessionId, card.requestId)
        settlements[key] = { ...settlements[key], closed: true }
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          ...parts.map((part, index): ChatMessage => ({
            id: `${sessionId}-${String((event as GatewayEvent & { seq?: number }).seq ?? state.messages.length)}-${index}`,
            role: 'assistant',
            text: part,
            tools: index === parts.length - 1 ? state.tools : undefined
          }))
        ],
        busy: false,
        waiting: false,
        streaming: '',
        interim: [],
        activity: '',
        tools: [],
        approvals: [],
        questions: [],
        settlements,
        error: typeof p.error === 'string' ? p.error : null
      }
    }
    case 'status.update': {
      const waiting =
        p.kind === 'waiting' ||
        (p.kind === 'working' && (state.approvals.length > 0 || state.questions.length > 0))
      return {
        ...state,
        activity: p.kind === 'working' && waiting ? state.activity : text,
        waiting,
        resumedWaiting: waiting ? false : state.resumedWaiting,
        busy:
          p.kind === 'idle' || p.kind === 'done' || p.kind === 'error' || p.kind === 'interrupted'
            ? false
            : state.busy || p.kind === 'working' || p.kind === 'waiting'
      }
    }
    case 'thinking.delta':
      return { ...state, activity: text }
    case 'tool.start':
      return {
        ...state,
        tools: [
          ...state.tools.filter(t => t.id !== String(p.tool_id)),
          {
            id: String(p.tool_id ?? `tool-${state.tools.length}`),
            name: String(p.name ?? p.tool_name ?? 'tool'),
            args: parseArgs(p.args ?? p.args_text),
            detail: '',
            status: 'running'
          }
        ],
        activity:
          typeof p.tool_name === 'string'
            ? `Using ${p.tool_name}`
            : typeof p.name === 'string'
              ? `Using ${p.name}`
              : 'Working',
        busy: true
      }
    case 'tool.complete':
      return {
        ...state,
        tools: state.tools.map(t =>
          t.id === String(p.tool_id)
            ? {
                ...t,
                status: p.is_error || (p.result as Record<string, unknown>)?.error ? 'error' : 'ok',
                detail: detailOf(p.result ?? p.result_text)
              }
            : t
        ),
        activity: ''
      }
    case 'error':
      return {
        ...state,
        error: typeof p.message === 'string' ? p.message : 'The bot could not finish.',
        busy: false
      }
    case 'approval.request': {
      if (typeof p.request_id !== 'string') return state
      const saved = state.settlements[requestKey('approval', sessionId, p.request_id)]
      if (saved?.choice || saved?.closed) return state
      const request = {
        requestId: p.request_id,
        sessionId,
        command: String(p.command ?? p.tool_name ?? 'Approve this action'),
        reason: typeof p.reason === 'string' ? p.reason : undefined,
        choices: Array.isArray(p.choices) ? (p.choices as string[]) : ['once', 'deny']
      }
      return {
        ...state,
        busy: true,
        waiting: true,
        resumedWaiting: false,
        activity: 'Waiting for approval',
        approvals: [
          ...state.approvals.filter(
            a => a.requestId !== request.requestId || a.sessionId !== sessionId
          ),
          request
        ]
      }
    }
    case 'approval.resolved': {
      const choice = choiceOf(p.choice)
      if (typeof p.request_id !== 'string' || !sessionId || !choice) return state
      const key = requestKey('approval', sessionId, p.request_id)
      const approvals = state.approvals.filter(
        a => a.requestId !== p.request_id || a.sessionId !== sessionId
      )
      return resumeAnswered(
        {
          ...state,
          approvals,
          settlements: { ...state.settlements, [key]: { ...state.settlements[key], choice } }
        },
        approvals.length !== state.approvals.length,
        revision
      )
    }
    case 'clarify.request': {
      if (typeof p.request_id !== 'string') return state
      const key = requestKey('clarify', sessionId, p.request_id)
      const saved = state.settlements[key]
      if (saved?.closed) return state
      const answers = { ...answerMap(p.answers), ...saved?.answers }
      const questions = (Array.isArray(p.questions) ? p.questions : [p])
        .filter(
          (q: Record<string, unknown>) =>
            !Object.prototype.hasOwnProperty.call(answers ?? {}, String(q.qid ?? p.request_id))
        )
        .map((q: Record<string, unknown>) => ({
          id: String(q.qid ?? p.request_id),
          text: String(q.question ?? ''),
          choices: Array.isArray(q.choices) ? (q.choices as string[]) : [],
          multiSelect: q.multi_select === true
        }))
      if (!questions.length && saved?.answered) return state
      return {
        ...state,
        busy: true,
        waiting: true,
        resumedWaiting: false,
        activity: 'Waiting for your answer',
        settlements: { ...state.settlements, [key]: { ...saved, answers } },
        questions: [
          ...state.questions.filter(q => q.requestId !== p.request_id || q.sessionId !== sessionId),
          { requestId: p.request_id, sessionId, questions }
        ]
      }
    }
    case 'clarify.resolved': {
      if (
        typeof p.request_id !== 'string' ||
        !sessionId ||
        (p.status !== 'waiting' && p.status !== 'answered')
      )
        return state
      const key = requestKey('clarify', sessionId, p.request_id)
      const saved = state.settlements[key]
      const answers = { ...answerMap(p.answers), ...saved?.answers }
      const card = state.questions.find(
        q => q.requestId === p.request_id && q.sessionId === sessionId
      )
      const answered =
        p.status === 'answered' &&
        (!card || card.questions.every(q => Object.hasOwn(answers, q.id)))
      const questions = state.questions.flatMap(q => {
        if (q !== card) return [q]
        const remaining = q.questions.filter(question => !Object.hasOwn(answers, question.id))
        return answered ? [] : [{ ...q, questions: remaining }]
      })
      return resumeAnswered(
        {
          ...state,
          questions,
          settlements: {
            ...state.settlements,
            [key]: { ...saved, answers, answered: saved?.answered || answered }
          }
        },
        Boolean(card && answered),
        revision
      )
    }
    case 'clarify.expire': {
      if (typeof p.request_id !== 'string' || !sessionId) return state
      const key = requestKey('clarify', sessionId, p.request_id)
      return {
        ...state,
        questions: state.questions.filter(
          q => q.requestId !== p.request_id || q.sessionId !== sessionId
        ),
        settlements: { ...state.settlements, [key]: { ...state.settlements[key], closed: true } }
      }
    }
    default:
      return state
  }
}
/**
 * Replays events that arrived while history loaded onto that history. They
 * may come from before the snapshot or after it, so none of them adds to the
 * transcript. `reread` is true when a turn finished in that window: the
 * history is read again and shows its replies once. A turn still running
 * keeps its live state, without the interim replies and tools the history
 * already has; its replies come from the history once it finishes.
 */
export function replayChat(
  state: ChatState,
  events: GatewayEvent[]
): { state: ChatState; reread: boolean } {
  const shown = new Set(state.messages.flatMap(m => m.tools?.map(t => t.id) ?? []))
  let reread = false
  for (const event of events) {
    if (event.type === 'message.complete') {
      state = { ...reduceChat(state, event), messages: state.messages }
      reread = true
      continue
    }
    const next =
      event.type === 'message.interim'
        ? {
            ...state,
            streaming: (event.payload as { already_streamed?: unknown })?.already_streamed
              ? ''
              : state.streaming
          }
        : reduceChat(state, event)
    state = { ...next, tools: next.tools.filter(t => !shown.has(t.id)) }
  }
  return { state, reread }
}

/** A pending snapshot predates the events received while its RPC was loading. */
export function restoreChat(
  state: ChatState,
  sessionId: string,
  pending: Record<string, unknown> | undefined,
  events: GatewayEvent[]
): { state: ChatState; reread: boolean } {
  if (pending)
    state = reduceChat(state, { type: 'clarify.request', session_id: sessionId, payload: pending })
  return replayChat(
    state,
    events.filter(event => event.session_id === sessionId)
  )
}
