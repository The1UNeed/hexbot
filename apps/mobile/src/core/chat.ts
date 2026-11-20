import type { GatewayEvent } from '@hermes/shared'
import { splitAttached } from '../../../web/src/lib/media'
import { agreedThenFailed } from '../../../web/src/lib/settled-cards'
import type { EmailDraft, EmailDraftAnswer, PluginForm } from '../../../web/src/lib/types'

import type {
  ChatMessage,
  ChatState,
  ChatTool,
  EmailDraftForm,
  PendingApproval,
  SignInForm,
  TurnState
} from './types'
export const emptyTurn = (): TurnState => ({
  streaming: '',
  interim: [],
  busy: false,
  activity: '',
  checking: '',
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
/** The file's own name: an attachment is kept as `<32-hex id>-<name>`. */
const fileName = (path: string) =>
  (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path).replace(/^[0-9a-f]{32}-(?=.)/, '')
/**
 * The files a bot shared in a message (`hexbot_share_file`), once each, in the
 * order it shared them. Files it only wrote or edited along the way stay out.
 */
export function sharedFiles(tools: ChatTool[] = []): { name: string; path: string }[] {
  const seen = new Set<string>()
  return tools.flatMap(tool => {
    if (tool.name !== 'hexbot_share_file' || tool.status !== 'ok') return []
    const path = (parseArgs(tool.args) as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || !path.trim() || seen.has(path)) return []
    seen.add(path)
    return [{ name: fileName(path), path }]
  })
}
/** A sign-in card's fields, from an `approval.request`. */
const isSignIn = (value: unknown): value is SignInForm =>
  typeof value === 'object' &&
  value !== null &&
  (value as SignInForm).kind === 'sign_in' &&
  typeof (value as SignInForm).site === 'string' &&
  typeof (value as SignInForm).title === 'string'

/** A plugin card's fields, from an `approval.request`. */
const isPlugin = (value: unknown): value is PluginForm =>
  typeof value === 'object' &&
  value !== null &&
  (value as PluginForm).kind === 'plugin' &&
  ['enable', 'install', 'setup'].includes((value as PluginForm).action) &&
  typeof (value as PluginForm).id === 'string' &&
  typeof (value as PluginForm).name === 'string' &&
  Array.isArray((value as PluginForm).fields)

/** A draft card's email, from an `approval.request`. */
const isEmailDraft = (value: unknown): value is EmailDraftForm =>
  typeof value === 'object' &&
  value !== null &&
  (value as EmailDraftForm).kind === 'email_draft' &&
  Array.isArray((value as EmailDraftForm).to) &&
  typeof (value as EmailDraftForm).body === 'string'

/** A card with its answer: the choice and, for a draft card, the email as it went. */
export function answeredApproval(
  approval: PendingApproval,
  answer: { choice?: unknown; draft?: unknown; mail_action?: unknown }
): PendingApproval {
  const decision =
    answer.choice === 'deny' || answer.choice === 'once' || answer.choice === 'session'
      ? answer.choice
      : 'once'
  const action = answer.mail_action
  const mail: EmailDraftAnswer | undefined =
    (action === 'send' || action === 'save') && answer.draft && typeof answer.draft === 'object'
      ? { draft: answer.draft as EmailDraft, mail_action: action }
      : undefined
  return { ...approval, decision, ...(mail && { outcome: mail }) }
}

const detailOf = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
/**
 * A section's history as messages. Hidden rows are dropped, with one
 * exception, as in the web app: in a thread between bots (`sender` given),
 * the asking bot's questions arrive as hidden user rows `@<sender>: <text>`
 * and become its messages, prefix stripped.
 */
export function historyMessages(raw: unknown[], sender?: string | null): ChatMessage[] {
  const messages: ChatMessage[] = []
  const args = new Map<string, unknown>()
  const prefix = sender ? `@${sender}: ` : null
  for (const value of raw) {
    const row = value as Record<string, unknown>
    if (row.hidden || row.display_kind === 'hidden') {
      const asked = prefix && row.role === 'user' ? textContent(row.content ?? row.text) : ''
      if (prefix && asked.startsWith(prefix))
        messages.push({
          id: String(row.id ?? row.row_id ?? `history-${messages.length}`),
          // The asking bot's bubble, drawn with its face like a bot in a room.
          role: 'assistant',
          sender: sender!,
          text: asked.slice(prefix.length),
          ...(typeof row.timestamp === 'number' &&
            row.timestamp > 0 && { createdAt: row.timestamp * 1000 })
        })
      continue
    }
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
      // The files you sent are listed under your words; each shows as it did live.
      const said = textContent(row.content ?? row.text)
      const { files, text } = row.role === 'user' ? splitAttached(said) : { files: [], text: said }
      if (text || files.length || (Array.isArray(row.tool_calls) && row.tool_calls.length))
        messages.push({
          id: String(row.id ?? row.row_id ?? `history-${messages.length}`),
          role: row.role,
          text,
          ...(files.length && { attachments: files }),
          // Rows carry `timestamp` in Unix seconds.
          ...(typeof row.timestamp === 'number' &&
            row.timestamp > 0 && { createdAt: row.timestamp * 1000 }),
          ...(typeof row.input_id === 'string' && { inputId: row.input_id }),
          ...(typeof row.row_id === 'string' && { rowId: row.row_id })
        })
    }
  }
  return messages
}
type TurnPart = { row?: string; text: string; tools: ChatTool[] }
/**
 * A finished turn's messages, each with the tools it called, as history
 * keeps them: the bot's words before a tool, then the tool, so a card it
 * showed sits under those words and above the reply. A tool called without
 * words gets an empty message of its own in its place.
 */
function turnParts(state: TurnState, final: { row?: string; text: string }): TurnPart[] {
  const said: TurnPart[] = state.interim.map((text, index) => ({
    row: state.interimIds?.[index],
    text,
    tools: []
  }))
  const last: TurnPart = { ...final, tools: [] }
  // Empty messages for tools called without words, by the words they follow.
  const quiet = new Map<number, TurnPart[]>()
  for (const tool of state.tools) {
    const after = tool.after
    const before = after ? said[after - 1] : undefined
    if (after === undefined || after > said.length) last.tools.push(tool)
    else if (before && (!tool.row || !before.row || tool.row === before.row)) before.tools.push(tool)
    else {
      const group = quiet.get(after) ?? []
      let part = group.find(item => item.row === tool.row)
      if (!part) {
        part = { row: tool.row, text: '', tools: [] }
        group.push(part)
        quiet.set(after, group)
      }
      part.tools.push(tool)
    }
  }
  return [
    ...said.flatMap((part, index) => [...(quiet.get(index) ?? []), part]),
    ...(quiet.get(said.length) ?? []),
    last
  ].filter(part => part.text || part.tools.length)
}
/** A message the bot's heartbeat posted in the open chat, once by its history row id. */
export function heartbeatMessage(state: ChatState, id: string, text: string): ChatState {
  if (state.messages.some(m => m.id === id)) return state
  return {
    ...state,
    messages: [...state.messages, { id, role: 'assistant', rowId: id, text, createdAt: Date.now() }]
  }
}
export function reduceChat(state: ChatState, event: GatewayEvent): ChatState {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const text = typeof p.text === 'string' ? p.text : ''
  const sessionId = event.session_id ?? ''
  // The assistant fragment the event belongs to: its durable history row.
  const row = typeof p.message_id === 'string' ? p.message_id : undefined
  switch (event.type) {
    case 'message.start':
      return {
        ...state,
        busy: true,
        streaming: '',
        interim: [],
        interimIds: [],
        streamId: undefined,
        tools: [],
        error: null,
        turnAt: state.messages.length
      }
    case 'message.delta':
      return { ...state, busy: true, streaming: state.streaming + text, streamId: row ?? state.streamId }
    case 'message.interim':
      return {
        ...state,
        interim: [...state.interim, p.already_streamed ? state.streaming || text : text],
        // Each bubble keeps the history row it is, which a reaction names.
        interimIds: [...(state.interimIds ?? []), row ?? state.streamId],
        streamId: undefined,
        streaming: p.already_streamed ? '' : state.streaming
      }
    case 'message.complete': {
      const parts = turnParts(state, { row: row ?? state.streamId, text: text || state.streaming })
      const at = Math.min(state.turnAt ?? state.messages.length, state.messages.length)
      return {
        ...state,
        turnAt: undefined,
        messages: [
          ...state.messages.slice(0, at),
          ...parts.map((part, index): ChatMessage => ({
            id: `${sessionId}-${String((event as GatewayEvent & { seq?: number }).seq ?? state.messages.length)}-${index}`,
            role: 'assistant',
            text: part.text,
            createdAt: Date.now(),
            tools: part.tools.length ? part.tools : undefined,
            ...(part.row && { rowId: part.row })
          })),
          ...state.messages.slice(at)
        ],
        busy: false,
        streaming: '',
        interim: [],
        interimIds: [],
        streamId: undefined,
        activity: '',
        // The turn is over, so no review is left; the daemon's clear may be lost.
        checking: '',
        tools: [],
        approvals: [],
        questions: [],
        error: typeof p.error === 'string' ? p.error : null
      }
    }
    case 'status.update':
      // Only the daemon's empty `checking` line ends the label; other status
      // lines leave it, since another review may still be running.
      if (p.kind === 'checking') return { ...state, checking: text, activity: text }
      if (p.kind === 'idle' || p.kind === 'done' || p.kind === 'error' || p.kind === 'interrupted')
        // The daemon says the turn ended after its last message, so nothing is running.
        return { ...state, activity: state.checking || text, busy: false, turnAt: undefined }
      return {
        ...state,
        activity: state.checking || text,
        busy: state.busy || p.kind === 'working' || p.kind === 'waiting'
      }
    case 'thinking.delta':
      return { ...state, activity: state.checking || text }
    case 'tool.start':
      return {
        ...state,
        tools: [
          ...state.tools.filter(t => t.id !== String(p.tool_id)),
          {
            id: String(p.tool_id ?? `tool-${state.tools.length}`),
            name: String(p.name ?? p.tool_name ?? 'tool'),
            after: state.interim.length,
            ...(row && { row }),
            ...(typeof p.context === 'string' && { action: p.context }),
            args: parseArgs(p.args ?? p.args_text),
            detail: '',
            status: 'running'
          }
        ],
        activity:
          state.checking ||
          (typeof p.tool_name === 'string'
            ? `Using ${p.tool_name}`
            : typeof p.name === 'string'
              ? `Using ${p.name}`
              : 'Working'),
        busy: true
      }
    case 'tool.complete': {
      const failed = Boolean(p.is_error || (p.result as Record<string, unknown>)?.error)
      // The card it showed says so when the work the user agreed to failed.
      const broke = agreedThenFailed({ result: p.result ?? p.result_text, status: failed ? 'error' : 'ok' })
      return {
        ...state,
        approvals: broke
          ? state.approvals.map(a =>
              a.toolId === String(p.tool_id) && a.decision && a.decision !== 'deny'
                ? { ...a, failed: true }
                : a
            )
          : state.approvals,
        tools: state.tools.map(t =>
          t.id === String(p.tool_id)
            ? {
                ...t,
                status: failed ? 'error' : 'ok',
                detail: detailOf(p.result ?? p.result_text)
              }
            : t
        ),
        activity: state.checking
      }
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
        choices: Array.isArray(p.choices) ? (p.choices as string[]) : ['once', 'deny'],
        ...(typeof p.tool_id === 'string' && { toolId: p.tool_id }),
        ...((isSignIn(p.form) || isPlugin(p.form) || isEmailDraft(p.form)) && { form: p.form })
      }
      return {
        ...state,
        busy: true,
        approvals: [...state.approvals.filter(a => a.requestId !== request.requestId), request]
      }
    }
    case 'clarify.request': {
      if (typeof p.request_id !== 'string') return state
      const answered = (id: string) => Object.prototype.hasOwnProperty.call(p.answers ?? {}, id)
      // Re-sent or replayed: keep the card shown, so its answers only move forward.
      if (state.questions.some(q => q.requestId === p.request_id))
        return {
          ...state,
          questions: state.questions
            .map(q =>
              q.requestId === p.request_id
                ? { ...q, questions: q.questions.filter(question => !answered(question.id)) }
                : q
            )
            .filter(q => q.questions.length)
        }
      const questions = (Array.isArray(p.questions) ? p.questions : [p])
        .filter((q: Record<string, unknown>) => !answered(String(q.qid ?? p.request_id)))
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
    // Answered here or on another app, or the bot stopped waiting: that card goes.
    case 'clarify.expire':
    case 'clarify.resolved':
      return { ...state, questions: state.questions.filter(q => q.requestId !== p.request_id) }
    // Answered here or on another app: the card stays with the answer until
    // the turn ends, when the message's tools show it from then on.
    case 'approval.resolved':
      return {
        ...state,
        approvals: state.approvals.map(a =>
          a.requestId === p.request_id ? answeredApproval(a, p) : a
        )
      }
    // The bot stopped waiting before anyone answered: that card goes.
    case 'approval.expire':
      return {
        ...state,
        approvals: state.approvals.filter(a => a.requestId !== p.request_id || a.decision)
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
  for (const event of events) {
    if (event.type === 'message.complete')
      return { state: { ...reduceChat(state, event), messages: state.messages }, reread: true }
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
  return { state, reread: false }
}
