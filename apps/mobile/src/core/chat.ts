import type { GatewayEvent } from '@hermes/shared'
import type { ChatMessage, ChatState, ChatTool, TurnState } from './types'
export const emptyTurn = (): TurnState => ({
  streaming: '',
  interim: [],
  busy: false,
  activity: '',
  tools: [],
  approvals: [],
  questions: [],
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
  switch (event.type) {
    case 'message.start':
      return { ...state, busy: true, streaming: '', interim: [], tools: [], error: null }
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
        streaming: '',
        interim: [],
        activity: '',
        tools: [],
        approvals: [],
        questions: [],
        error: typeof p.error === 'string' ? p.error : null
      }
    }
    case 'status.update':
      return {
        ...state,
        activity: text,
        busy:
          p.kind === 'idle' || p.kind === 'done' || p.kind === 'error' || p.kind === 'interrupted'
            ? false
            : state.busy || p.kind === 'working' || p.kind === 'waiting'
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
        approvals: [...state.approvals.filter(a => a.requestId !== request.requestId), request]
      }
    }
    case 'clarify.request': {
      if (typeof p.request_id !== 'string') return state
      const answers = p.answers as Record<string, string> | undefined
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
      return {
        ...state,
        busy: true,
        questions: [
          ...state.questions.filter(q => q.requestId !== p.request_id),
          { requestId: p.request_id, sessionId, questions }
        ]
      }
    }
    case 'clarify.expire':
      return { ...state, questions: state.questions.filter(q => q.requestId !== p.request_id) }
    default:
      return state
  }
}
/**
 * Replays events that arrived while history loaded. A turn that finished in
 * that window may already be in the history; its reply is not added twice.
 */
export function replayChat(state: ChatState, events: GatewayEvent[]): ChatState {
  const last = state.messages.at(-1)
  for (const event of events) {
    const next = reduceChat(state, event)
    const added = next.messages.slice(state.messages.length)
    state =
      event.type === 'message.complete' &&
      last?.role === 'assistant' &&
      added.at(-1)?.text === last.text
        ? { ...next, messages: state.messages }
        : next
  }
  return state
}
