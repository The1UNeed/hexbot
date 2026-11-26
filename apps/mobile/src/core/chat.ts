import type { GatewayEvent } from '@hermes/shared'
import {
  askExpectedSent,
  askSameSignature,
  asksCompatible,
  asksOf,
  askTarget
} from '../../../web/src/lib/asks'
import { splitAttached } from '../../../web/src/lib/media'
import { agreedThenFailed } from '../../../web/src/lib/settled-cards'
import type { EmailDraft, EmailDraftAnswer, PluginForm } from '../../../web/src/lib/types'

import type {
  ChatMessage,
  ChatState,
  ChatTool,
  EmailDraftForm,
  PendingApproval,
  RoomTurnAsk,
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
export const emptyChat = (): ChatState => ({
  ...emptyTurn(),
  messages: [],
  turns: {},
  completingAsks: {}
})
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

/** Preserve `section_id` on persisted nested calls (such as a failed `message_bot` inside `codemode`). */
const nestedToolResult = (nested: Record<string, unknown>): unknown => {
  const sectionId =
    typeof nested.section_id === 'string' && nested.section_id ? nested.section_id : undefined
  if (nested.error != null) {
    if (!sectionId) return nested.error
    if (typeof nested.error === 'object' && !Array.isArray(nested.error)) {
      const obj = nested.error as Record<string, unknown>
      return { ...obj, section_id: obj.section_id ?? sectionId }
    }
    return { error: nested.error, section_id: sectionId }
  }
  if (nested.result != null) {
    if (!sectionId) return nested.result
    if (typeof nested.result === 'object' && !Array.isArray(nested.result)) {
      const obj = nested.result as Record<string, unknown>
      return { ...obj, section_id: obj.section_id ?? sectionId }
    }
    if (typeof nested.result === 'string') {
      try {
        const parsed: unknown = JSON.parse(nested.result)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>
          return { ...obj, section_id: obj.section_id ?? sectionId }
        }
      } catch {
        // Plain text result; keep both text and section_id.
      }
    }
    return { result: nested.result, section_id: sectionId }
  }
  return sectionId ? { section_id: sectionId } : ''
}
/**
 * A section's history as messages. Hidden rows are dropped, with one
 * exception, as in the web app: in a thread between bots (`sender` given),
 * the asking bot's questions arrive as hidden user rows `@<sender>: <text>`
 * and become its messages, prefix stripped.
 */
export function historyMessages(raw: unknown[], sender?: string | null): ChatMessage[] {
  const messages: ChatMessage[] = []
  const formatted = new Map<Record<string, unknown>, ChatMessage>()
  type CallOwner = {
    args: unknown
    exchange: number
    name?: string
    occurrenceId?: string
    row: Record<string, unknown>
    rowId?: string
    turnId?: string
  }
  const callOwners = new Map<string, CallOwner[]>()
  const callOwnersByOccurrence = new Map<string, CallOwner>()
  const prefix = sender ? `@${sender}: ` : null
  const isBoundary = (row: Record<string, unknown>) => {
    if (row.hidden || row.display_kind === 'hidden') {
      const asked = prefix && row.role === 'user' ? textContent(row.content ?? row.text) : ''
      return Boolean(prefix && asked.startsWith(prefix))
    }
    return row.role === 'user'
  }
  let scanExchange = 0
  for (const value of raw) {
    const row = value as Record<string, unknown>
    if (isBoundary(row)) {
      scanExchange += 1
      continue
    }
    if (row.hidden || row.display_kind === 'hidden' || row.role !== 'assistant') continue
    const rowTurnId = typeof row.turn_id === 'string' ? row.turn_id : undefined
    const rowId = typeof row.row_id === 'string' ? row.row_id : undefined
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const callId = String(call.id)
      const callName =
        typeof call.function?.name === 'string' && call.function.name
          ? call.function.name
          : undefined
      const occ =
        typeof call.occurrence_id === 'string' && call.occurrence_id
          ? call.occurrence_id
          : undefined
      const ownerEntry: CallOwner = {
        args: parseArgs(call.function?.arguments),
        exchange: scanExchange,
        ...(callName && { name: callName }),
        ...(occ && { occurrenceId: occ }),
        row,
        rowId,
        turnId: rowTurnId
      }
      const list = callOwners.get(callId) ?? []
      list.push(ownerEntry)
      callOwners.set(callId, list)
      if (occ) callOwnersByOccurrence.set(occ, ownerEntry)
    }
  }
  let exchange = 0
  for (const value of raw) {
    const row = value as Record<string, unknown>
    const rowTurnId = typeof row.turn_id === 'string' ? row.turn_id : undefined
    if (isBoundary(row)) exchange += 1
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
            row.timestamp > 0 && { createdAt: row.timestamp * 1000 }),
          ...(rowTurnId && { turnId: rowTurnId })
        })
      continue
    }
    if (row.role === 'tool') {
      const id = String(row.tool_call_id ?? row.tool_id ?? row.row_id)
      const rowName = typeof row.name === 'string' && row.name ? row.name : undefined
      const explicitRow = typeof row.message_id === 'string' ? row.message_id : undefined
      const occurrenceId =
        typeof row.occurrence_id === 'string' && row.occurrence_id ? row.occurrence_id : undefined
      const occurrenceOwner = occurrenceId ? callOwnersByOccurrence.get(occurrenceId) : undefined
      const declarations = callOwners.get(id) ?? []
      const candidates = declarations.filter(
        entry =>
          (rowTurnId && entry.turnId
            ? entry.turnId === rowTurnId
            : entry.exchange === exchange) &&
          (!explicitRow || entry.rowId === explicitRow) &&
          (!rowName || !entry.name || entry.name === rowName)
      )
      const owner = occurrenceOwner ?? (candidates.length === 1 ? candidates[0] : undefined)
      const ambiguous = !owner && candidates.length > 1
      const previous = messages.at(-1)
      let target: ChatMessage | undefined
      if (owner) {
        target = formatted.get(owner.row)
      } else if (!ambiguous) {
        if (
          previous?.role === 'assistant' &&
          !(rowTurnId && previous.turnId && previous.turnId !== rowTurnId) &&
          !(explicitRow && previous.rowId && previous.rowId !== explicitRow)
        ) {
          target = previous
        }
      }
      if (!target) {
        target = {
          id: `history-tool-${messages.length}`,
          role: 'assistant',
          text: '',
          ...(rowTurnId && { turnId: rowTurnId })
        }
        messages.push(target)
      }
      const toolTurnId = rowTurnId ?? owner?.turnId ?? target.turnId
      const toolRow = explicitRow ?? (ambiguous ? undefined : (owner?.rowId ?? target.rowId))
      const rawSectionId =
        typeof row.section_id === 'string' && row.section_id ? row.section_id : undefined
      const rawToolValue = row.text ?? row.content
      const tool: ChatTool = {
        id,
        name: String(row.name ?? 'tool'),
        args: row.args ?? (ambiguous ? undefined : owner?.args),
        ...(typeof row.context === 'string' && { action: row.context }),
        detail: detailOf(
          rawSectionId
            ? nestedToolResult({
                ...(row.is_error
                  ? { error: rawToolValue ?? 'Tool failed' }
                  : { result: rawToolValue }),
                section_id: rawSectionId
              })
            : rawToolValue
        ),
        status: row.is_error ? 'error' : 'ok',
        ...(toolRow && { row: toolRow }),
        ...(occurrenceId && { occurrenceId }),
        ...(toolTurnId && { turnId: toolTurnId })
      }
      const rawNested = (row.nested_calls as { calls?: unknown } | undefined)?.calls
      const nestedTools: ChatTool[] = Array.isArray(rawNested)
        ? rawNested.map((entry, index) => {
            const nested = (entry ?? {}) as Record<string, unknown>
            return {
              id: String(nested.id ?? `${id}/nested-${index}`),
              name: String(nested.name ?? 'tool'),
              args: parseArgs(nested.arguments),
              detail: detailOf(nestedToolResult(nested)),
              status: nested.status === 'error' ? ('error' as const) : ('ok' as const),
              parentToolCallId: id,
              ...(occurrenceId && { parentOccurrenceId: occurrenceId }),
              ...(toolRow && { row: toolRow }),
              ...(toolTurnId && { turnId: toolTurnId })
            }
          })
        : []
      target.tools = [...(target.tools ?? []), tool, ...nestedTools]
    } else if (row.role === 'user' || row.role === 'assistant') {
      // The files you sent are listed under your words; each shows as it did live.
      const said = textContent(row.content ?? row.text)
      const { files, text } = row.role === 'user' ? splitAttached(said) : { files: [], text: said }
      if (text || files.length || (Array.isArray(row.tool_calls) && row.tool_calls.length)) {
        const message: ChatMessage = {
          id: String(row.id ?? row.row_id ?? `history-${messages.length}`),
          role: row.role,
          text,
          ...(files.length && { attachments: files }),
          // Rows carry `timestamp` in Unix seconds.
          ...(typeof row.timestamp === 'number' &&
            row.timestamp > 0 && { createdAt: row.timestamp * 1000 }),
          ...(typeof row.input_id === 'string' && { inputId: row.input_id }),
          ...(typeof row.row_id === 'string' && { rowId: row.row_id }),
          ...(rowTurnId && { turnId: rowTurnId })
        }
        messages.push(message)
        formatted.set(row, message)
      }
    }
  }
  return messages
}

/**
 * Unmatched `message_bot` declarations from the latest exchange of a busy
 * section snapshot, restored as running live tools so opening a chat mid-ask
 * shows the tappable "Messaging <Bot>" chip before `tool.complete` arrives.
 */
export function pendingTurnTools(
  raw: unknown[],
  sender?: string | null,
  liveAsks?: RoomTurnAsk[]
): ChatTool[] {
  const prefix = sender ? `@${sender}: ` : null
  const isBoundary = (row: Record<string, unknown>) => {
    if (row.hidden || row.display_kind === 'hidden') {
      const asked = prefix && row.role === 'user' ? textContent(row.content ?? row.text) : ''
      return Boolean(prefix && asked.startsWith(prefix))
    }
    return row.role === 'user'
  }
  let maxExchange = 0
  for (const value of raw) {
    if (isBoundary(value as Record<string, unknown>)) maxExchange += 1
  }
  type PendingDecl = {
    args: unknown
    expectedSent: boolean | null
    id: string
    occurrenceId?: string
    row?: string
    target: string | null
    text?: string
    turnId?: string
  }
  const declarations: PendingDecl[] = []
  const results: {
    expectedSent: boolean | null
    id: string
    occurrenceId?: string
    row?: string
    sent: boolean
    status: 'error' | 'ok'
    target: string | null
    text?: string
    turnId?: string
  }[] = []
  const persistedNested: {
    call: { args: unknown; name: string; result: string; status: 'error' | 'ok' }
    id: string
    parentOccurrenceId?: string
    parentToolCallId: string
    turnId?: string
  }[] = []
  let exchange = 0
  let latestTurnId: string | undefined
  for (const value of raw) {
    const row = value as Record<string, unknown>
    if (isBoundary(row)) {
      exchange += 1
      continue
    }
    if (exchange !== maxExchange) continue
    if (row.hidden || row.display_kind === 'hidden') continue
    const rowTurnId = typeof row.turn_id === 'string' ? row.turn_id : undefined
    if (row.role === 'assistant') {
      if (rowTurnId) latestTurnId = rowTurnId
      const rowId = typeof row.row_id === 'string' ? row.row_id : undefined
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const fn = (call as { function?: { arguments?: unknown; name?: unknown } })?.function
        const args = parseArgs(fn?.arguments)
        const fnName = typeof fn?.name === 'string' ? fn.name : undefined
        const isAsk =
          fnName === 'message_bot' ||
          (!fnName &&
            Boolean(
              args &&
                typeof args === 'object' &&
                typeof (args as Record<string, unknown>).to === 'string' &&
                (args as Record<string, unknown>).to
            ))
        if (!isAsk) continue
        const occ = (call as { occurrence_id?: unknown })?.occurrence_id
        const declText =
          args && typeof args === 'object' && typeof (args as Record<string, unknown>).text === 'string'
            ? ((args as Record<string, unknown>).text as string)
            : undefined
        declarations.push({
          args,
          expectedSent: askExpectedSent(args),
          id: String((call as { id?: unknown })?.id ?? ''),
          ...(typeof occ === 'string' && occ ? { occurrenceId: occ } : {}),
          row: rowId,
          target: askTarget({ args, name: 'message_bot', status: 'running' }),
          ...(declText !== undefined ? { text: declText } : {}),
          turnId: rowTurnId
        })
      }
    } else if (
      row.role === 'tool' &&
      (row.name === 'message_bot' || row.tool_name === 'message_bot')
    ) {
      const id = String(row.tool_call_id ?? row.tool_id ?? row.row_id ?? '')
      const explicitRow = typeof row.message_id === 'string' ? row.message_id : undefined
      const occ = typeof row.occurrence_id === 'string' && row.occurrence_id ? row.occurrence_id : undefined
      const resStatus: 'error' | 'ok' = row.is_error ? 'error' : 'ok'
      const resArgs = parseArgs(row.args)
      const resText =
        resArgs &&
        typeof resArgs === 'object' &&
        typeof (resArgs as Record<string, unknown>).text === 'string'
          ? ((resArgs as Record<string, unknown>).text as string)
          : undefined
      const askCall = {
        args: resArgs,
        name: 'message_bot',
        result: row.text ?? row.content,
        status: resStatus,
        summary: typeof row.context === 'string' ? row.context : undefined
      }
      const parsedAsk = asksOf([askCall])[0]
      results.push({
        expectedSent: askExpectedSent(resArgs),
        id,
        ...(occ ? { occurrenceId: occ } : {}),
        row: explicitRow,
        sent: parsedAsk?.sent ?? false,
        status: resStatus,
        target: askTarget(askCall),
        ...(resText !== undefined ? { text: resText } : {}),
        turnId: rowTurnId
      })
    } else if (
      row.role === 'tool' &&
      Array.isArray((row.nested_calls as { calls?: unknown } | undefined)?.calls)
    ) {
      const parentToolCallId = String(row.tool_call_id ?? row.tool_id ?? row.row_id ?? '')
      const parentOccurrenceId =
        typeof row.occurrence_id === 'string' && row.occurrence_id ? row.occurrence_id : undefined
      for (const entry of (row.nested_calls as { calls: Record<string, unknown>[] }).calls) {
        if (entry?.name === 'message_bot' && typeof entry.id === 'string' && entry.id) {
          persistedNested.push({
            call: {
              args: parseArgs(entry.arguments),
              name: 'message_bot',
              result: detailOf(nestedToolResult(entry)),
              status: entry.status === 'error' ? 'error' : 'ok'
            },
            id: entry.id,
            ...(parentOccurrenceId ? { parentOccurrenceId } : {}),
            parentToolCallId,
            turnId: rowTurnId
          })
        }
      }
    }
  }
  const activeDeclarations = latestTurnId
    ? declarations.filter(d => !d.turnId || d.turnId === latestTurnId)
    : declarations
  const matched = new Set<number>()
  for (const res of results) {
    const idx = activeDeclarations.findIndex((decl, i) => {
      if (matched.has(i) || decl.id !== res.id) return false
      if (res.occurrenceId && decl.occurrenceId) return res.occurrenceId === decl.occurrenceId
      if (res.turnId && decl.turnId && res.turnId !== decl.turnId) return false
      if (res.row && decl.row && res.row !== decl.row) return false
      if (res.target && decl.target && res.target !== decl.target) return false
      if (res.text !== undefined && decl.text !== undefined && res.text !== decl.text) return false
      if (
        res.expectedSent !== null &&
        decl.expectedSent !== null &&
        res.expectedSent !== decl.expectedSent
      ) {
        return false
      }
      if (res.status === 'ok' && decl.expectedSent !== null && decl.expectedSent !== res.sent) {
        return false
      }
      return true
    })
    if (idx >= 0) matched.add(idx)
  }
  const snapshotAsks = liveAsks ?? []
  const usedLiveAsks = new Set<number>()
  const matchLiveAsk = (entry: {
    expectedSent: boolean | null
    id: string
    occurrenceId?: string
    row?: string
    sent?: boolean
    status?: 'error' | 'ok'
    target: string | null
    text?: string
    turnId?: string
  }): RoomTurnAsk | undefined => {
    const askIdx = snapshotAsks.findIndex((ask, idx) => {
      if (usedLiveAsks.has(idx) || ask.tool_id !== entry.id || ask.parent_tool_call_id) return false
      if (entry.status) {
        if (ask.status !== entry.status) return false
        if (entry.status === 'ok' && entry.sent !== undefined) {
          const liveAskSummary = asksOf([
            {
              args: parseArgs(ask.args),
              name: 'message_bot',
              result: ask.result ?? (ask.section_id ? { section_id: ask.section_id } : null),
              status: ask.status,
              summary: ask.context
            }
          ])[0]
          if (liveAskSummary && liveAskSummary.sent !== entry.sent) return false
        }
      }
      if (ask.occurrence_id && entry.occurrenceId) return ask.occurrence_id === entry.occurrenceId
      if (ask.turn_id && entry.turnId && ask.turn_id !== entry.turnId) return false
      if (ask.message_id && entry.row && ask.message_id !== entry.row) return false
      const parsed = parseArgs(ask.args)
      const askTargetName = askTarget({
        args: parsed,
        name: 'message_bot',
        status: ask.status,
        summary: ask.context
      })
      if (askTargetName && entry.target && askTargetName !== entry.target) return false
      const askText =
        parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).text === 'string'
          ? ((parsed as Record<string, unknown>).text as string)
          : undefined
      if (askText !== undefined && entry.text !== undefined && askText !== entry.text) return false
      const askExpected = askExpectedSent(parsed)
      if (askExpected !== null && entry.expectedSent !== null && askExpected !== entry.expectedSent) {
        return false
      }
      return true
    })
    if (askIdx < 0) return undefined
    usedLiveAsks.add(askIdx)
    return snapshotAsks[askIdx]
  }
  // Consume snapshot asks already present as persisted tool result rows.
  for (const res of results) matchLiveAsk(res)
  const pending: ChatTool[] = activeDeclarations
    .filter((_, i) => !matched.has(i))
    .map(decl => {
      const liveAsk = matchLiveAsk(decl)
      const occurrenceId = decl.occurrenceId ?? liveAsk?.occurrence_id
      const row = decl.row ?? liveAsk?.message_id
      const turnId = decl.turnId ?? liveAsk?.turn_id
      const status = liveAsk ? liveAsk.status : ('running' as const)
      return {
        id: decl.id,
        name: 'message_bot',
        args: decl.args ?? parseArgs(liveAsk?.args),
        ...(liveAsk?.context ? { action: liveAsk.context } : {}),
        detail: liveAsk
          ? liveAsk.result != null
            ? detailOf(liveAsk.result)
            : liveAsk.section_id
              ? JSON.stringify({ section_id: liveAsk.section_id })
              : ''
          : '',
        status,
        ...(status === 'running' ? { hydrated: true } : {}),
        ...(occurrenceId && { occurrenceId }),
        ...(row && { row }),
        ...(turnId && { turnId })
      }
    })
  // Consume snapshot asks already present as persisted nested tool calls.
  for (const nested of persistedNested) {
    const askIdx = snapshotAsks.findIndex((ask, idx) => {
      if (
        usedLiveAsks.has(idx) ||
        ask.status !== nested.call.status ||
        ask.parent_tool_call_id !== nested.parentToolCallId ||
        (ask.parent_occurrence_id &&
          nested.parentOccurrenceId &&
          ask.parent_occurrence_id !== nested.parentOccurrenceId) ||
        ask.tool_id !== nested.id ||
        (ask.turn_id && nested.turnId && ask.turn_id !== nested.turnId)
      ) {
        return false
      }
      return asksCompatible(nested.call, {
        args: parseArgs(ask.args),
        name: 'message_bot',
        ...(ask.occurrence_id ? { occurrenceId: ask.occurrence_id } : {}),
        result:
          ask.result != null
            ? detailOf(ask.result)
            : ask.section_id
              ? JSON.stringify({ section_id: ask.section_id })
              : '',
        status: ask.status,
        summary: ask.context
      })
    })
    if (askIdx >= 0) usedLiveAsks.add(askIdx)
  }
  // Include live nested (e.g. codemode) asks and direct asks whose rows have not landed in
  // persisted history yet (e.g. started or settled between history read and active-ask sample).
  for (let idx = 0; idx < snapshotAsks.length; idx++) {
    if (usedLiveAsks.has(idx)) continue
    const ask = snapshotAsks[idx]!
    pending.push({
      id: ask.tool_id,
      name: 'message_bot',
      args: parseArgs(ask.args),
      ...(ask.context ? { action: ask.context } : {}),
      detail:
        ask.result != null
          ? detailOf(ask.result)
          : ask.section_id
            ? JSON.stringify({ section_id: ask.section_id })
            : '',
      status: ask.status,
      ...(ask.status === 'running' ? { hydrated: true } : {}),
      ...(ask.parent_occurrence_id ? { parentOccurrenceId: ask.parent_occurrence_id } : {}),
      ...(ask.parent_tool_call_id ? { parentToolCallId: ask.parent_tool_call_id } : {}),
      ...(ask.occurrence_id ? { occurrenceId: ask.occurrence_id } : {}),
      ...(ask.message_id ? { row: ask.message_id } : {}),
      ...(ask.turn_id ? { turnId: ask.turn_id } : {})
    })
  }
  return pending
}

/**
 * Whether a buffered live-event sequence for a background section has already
 * reached a terminal run boundary (`message.complete` or `error`), even when
 * trailing `usage` / `status.update` events arrived afterwards.
 */
export function bufferedRunEnded(events: readonly GatewayEvent[]): boolean {
  if (events.length === 0) return true
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type
    if (type === 'message.complete' || type === 'error') return true
    if (
      type === 'message.start' ||
      type === 'message.delta' ||
      type === 'message.interim' ||
      type === 'tool.start' ||
      type === 'tool.complete' ||
      type === 'approval.request' ||
      type === 'clarify.request'
    ) {
      return false
    }
  }
  return true
}

/**
 * Keep the latest run from a departing section's event buffer, preserving all
 * `message.start` fallback continuations within that run (and any trailing
 * `message.complete` if it finished mid-navigation) while dropping earlier
 * completed runs.
 */
export function latestRunEvents(events: readonly GatewayEvent[]): GatewayEvent[] {
  let endIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'message.start') {
      for (let j = i - 1; j >= 0; j--) {
        const prev = events[j]?.type
        if (prev === 'message.complete' || prev === 'error') {
          endIdx = j
          break
        }
      }
      break
    }
  }
  if (endIdx < 0) return [...events]
  let start = endIdx + 1
  while (start < events.length && events[start]?.type !== 'message.start') {
    start++
  }
  return events.slice(start)
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
/** True when a `message.complete` event ended abnormally (error, partial, or interrupted). */
export function isFailedCompletion(
  payload: Record<string, unknown>,
  priorError?: string | null
): boolean {
  return Boolean(
    (typeof payload.error === 'string' && payload.error) ||
      payload.partial === true ||
      payload.status === 'error' ||
      payload.status === 'interrupted' ||
      priorError
  )
}

let nextFreshExchange = 1

const toAskCall = (tool: ChatTool) => ({
  args: tool.args,
  name: tool.name,
  ...(tool.occurrenceId && { occurrenceId: tool.occurrenceId }),
  result: tool.detail,
  status: tool.status,
  summary: tool.action
})

const toolTarget = (tool: ChatTool) =>
  tool.name === 'message_bot' ? askTarget(toAskCall(tool)) : null

const toolAsk = (tool: ChatTool) =>
  tool.name === 'message_bot' ? (asksOf([toAskCall(tool)])[0] ?? null) : null

/**
 * Checks whether an untagged live/held `message_bot` tool matches a stored
 * history occurrence without letting an earlier `wait: false` send (`Messaged`)
 * confirm or suppress a later `wait: true` reply (`Message from`) on the same target.
 */
const sameUntaggedAsk = (live: ChatTool, stored: ChatTool): boolean => {
  if (live.name !== 'message_bot' || stored.name !== 'message_bot') return true
  return asksCompatible(toAskCall(live), toAskCall(stored))
}

/**
 * Settles any still-running tools when a turn ends: failed completions mark unfinished calls
 * `'error'` (never `'ok'`), calls that already received a result keep their status, and a
 * running ask whose identical sibling previously absorbed an ambiguous untagged error settles
 * to `'error'` instead of flipping to `'ok'`.
 */
export function settleTurnTools(
  tools: readonly ChatTool[],
  failed: boolean,
  turnId?: string,
  afterHistoryCount?: number,
  freshExchange?: number
): ChatTool[] {
  const fallback = failed ? ('error' as const) : ('ok' as const)
  const absorbedPool = !failed
    ? tools
        .filter(t => t.name === 'message_bot' && t.status === 'error' && t.absorbedError !== undefined)
        .map(tool => ({ tool, used: false }))
    : []
  return tools.map(t => {
    const resolvedTurnId = t.turnId ?? turnId
    let runningOverride: { detail: string; status: 'error' | 'unresolved' } | undefined
    if (t.status === 'running' && !failed && t.name === 'message_bot' && absorbedPool.length) {
      const sibling = absorbedPool.find(
        entry =>
          !entry.used &&
          entry.tool.id === t.id &&
          (entry.tool.parentToolCallId ?? '') === (t.parentToolCallId ?? '') &&
          entry.tool.row === t.row &&
          askSameSignature(toAskCall(entry.tool), toAskCall(t))
      )
      if (sibling) {
        sibling.used = true
        runningOverride = { detail: sibling.tool.absorbedError!, status: 'error' }
      }
    }
    if (t.status === 'running' && !runningOverride && t.ambiguousOutcomes && t.ambiguousOutcomes.failed > 0) {
      const { error, failed: failedCount, ok: okCount } = t.ambiguousOutcomes
      if (okCount === 0) {
        runningOverride = { detail: t.detail || error || 'Tool failed', status: 'error' }
      } else {
        runningOverride = {
          detail: detailOf({
            ...(error ? { error } : {}),
            failed: failedCount,
            ok: okCount,
            unresolved: true
          }),
          status: 'unresolved'
        }
      }
    }
    return {
      ...t,
      ...(t.absorbedError !== undefined ? { absorbedError: undefined } : {}),
      ...(t.ambiguousOutcomes !== undefined ? { ambiguousOutcomes: undefined } : {}),
      ...(resolvedTurnId && { turnId: resolvedTurnId }),
      ...(!resolvedTurnId &&
        t.afterHistoryCount === undefined &&
        afterHistoryCount !== undefined && { afterHistoryCount }),
      ...(!resolvedTurnId &&
        t.freshExchange === undefined &&
        freshExchange !== undefined && { freshExchange }),
      ...(runningOverride
        ? runningOverride
        : t.status === 'running'
          ? { status: fallback }
          : {})
    }
  })
}

export function reduceChat(state: ChatState, event: GatewayEvent): ChatState {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const text = typeof p.text === 'string' ? p.text : ''
  const sessionId = event.session_id ?? ''
  // The assistant fragment the event belongs to: its durable history row.
  const row = typeof p.message_id === 'string' ? p.message_id : undefined
  const turnId = typeof p.turn_id === 'string' ? p.turn_id : undefined
  switch (event.type) {
    case 'message.start': {
      // A fallback continuation emits another `message.start` before `message.complete`
      // while the run is still busy; preserve settled asks and any streamed interim parts.
      const continuation =
        state.busy &&
        (state.tools.length > 0 || state.interim.length > 0 || Boolean(state.streaming))
      const interim = continuation
        ? state.streaming
          ? [...state.interim, state.streaming]
          : state.interim
        : []
      const interimIds = continuation
        ? state.streaming
          ? [...(state.interimIds ?? []), state.streamId]
          : (state.interimIds ?? [])
        : []
      return {
        ...state,
        busy: true,
        streaming: '',
        interim,
        interimIds,
        streamId: undefined,
        turnId: turnId ?? (continuation ? state.turnId : undefined),
        startedFresh: continuation ? (state.startedFresh ?? true) : true,
        freshExchange: continuation
          ? (state.freshExchange ?? (turnId ? undefined : nextFreshExchange++))
          : turnId
            ? undefined
            : nextFreshExchange++,
        tools: continuation ? state.tools : [],
        error: null,
        turnAt: continuation ? (state.turnAt ?? state.messages.length) : state.messages.length
      }
    }
    case 'message.delta':
      return {
        ...state,
        busy: true,
        streaming: state.streaming + text,
        streamId: row ?? state.streamId,
        turnId: turnId ?? state.turnId
      }
    case 'message.interim':
      return {
        ...state,
        interim: [...state.interim, p.already_streamed ? state.streaming || text : text],
        // Each bubble keeps the history row it is, which a reaction names.
        interimIds: [...(state.interimIds ?? []), row ?? state.streamId],
        streamId: undefined,
        turnId: turnId ?? state.turnId,
        streaming: p.already_streamed ? '' : state.streaming
      }
    case 'message.complete': {
      const completedTurnId = turnId ?? state.turnId ?? state.tools.find(t => t.turnId)?.turnId
      const failed = isFailedCompletion(p, state.error)
      const freshAfter =
        !completedTurnId && state.startedFresh && state.turnAt !== undefined
          ? state.turnAt
          : undefined
      const freshExchange =
        !completedTurnId && state.startedFresh ? state.freshExchange : undefined
      const settledTools = settleTurnTools(
        state.tools,
        failed,
        completedTurnId,
        freshAfter,
        freshExchange
      )
      const parts = turnParts(
        { ...state, tools: settledTools },
        { row: row ?? state.streamId, text: text || state.streaming }
      )
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
            ...(part.row && { rowId: part.row }),
            ...(completedTurnId && { turnId: completedTurnId })
          })),
          ...state.messages.slice(at)
        ],
        busy: false,
        streaming: '',
        interim: [],
        interimIds: [],
        streamId: undefined,
        turnId: undefined,
        startedFresh: undefined,
        freshExchange: undefined,
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
        return {
          ...state,
          activity: state.checking || text,
          busy: false,
          turnAt: undefined,
          turnId: undefined,
          startedFresh: undefined,
          freshExchange: undefined
        }
      return {
        ...state,
        activity: state.checking || text,
        busy: state.busy || p.kind === 'working' || p.kind === 'waiting'
      }
    case 'thinking.delta':
      return { ...state, activity: state.checking || text }
    case 'tool.start': {
      const toolTurnId = turnId ?? state.turnId
      const freshAfter =
        !toolTurnId && state.startedFresh && state.turnAt !== undefined ? state.turnAt : undefined
      const freshExchange = !toolTurnId && state.startedFresh ? state.freshExchange : undefined
      const incomingId = String(p.tool_id ?? `tool-${state.tools.length}`)
      const incomingName = String(p.name ?? p.tool_name ?? 'tool')
      const incomingArgs = parseArgs(p.args ?? p.args_text)
      const incomingAction = typeof p.context === 'string' ? p.context : undefined
      const occurrenceId =
        typeof p.occurrence_id === 'string' && p.occurrence_id ? p.occurrence_id : undefined
      const parentToolCallId =
        typeof p.parent_tool_call_id === 'string' && p.parent_tool_call_id
          ? p.parent_tool_call_id
          : undefined
      const explicitParentOccurrenceId =
        typeof p.parent_occurrence_id === 'string' && p.parent_occurrence_id
          ? p.parent_occurrence_id
          : undefined
      const exactParents =
        parentToolCallId && explicitParentOccurrenceId
          ? state.tools.filter(
              t =>
                !t.parentToolCallId &&
                t.id === parentToolCallId &&
                t.occurrenceId === explicitParentOccurrenceId &&
                (!toolTurnId || !t.turnId || t.turnId === toolTurnId)
            )
          : []
      const runningParents =
        parentToolCallId && !explicitParentOccurrenceId
          ? state.tools.filter(
              t =>
                !t.parentToolCallId &&
                t.id === parentToolCallId &&
                t.status === 'running' &&
                (!toolTurnId || !t.turnId || t.turnId === toolTurnId)
            )
          : []
      const activeParent = explicitParentOccurrenceId
        ? exactParents.length === 1
          ? exactParents[0]
          : undefined
        : runningParents.length === 1
          ? runningParents[0]
          : undefined
      const parentOccurrenceId = explicitParentOccurrenceId ?? activeParent?.occurrenceId
      const effectiveRow = row ?? activeParent?.row
      const incomingAskCall =
        incomingName === 'message_bot'
          ? {
              args: incomingArgs,
              name: incomingName,
              ...(occurrenceId && { occurrenceId }),
              status: 'running' as const,
              summary: incomingAction
            }
          : null
      const activity =
        state.checking ||
        (typeof p.tool_name === 'string'
          ? `Using ${p.tool_name}`
          : typeof p.name === 'string'
            ? `Using ${p.name}`
            : 'Working')
      // If an older replayed `tool.start` matches a tagged, nested, or occurrence-identified call
      // that is already settled (for example hydrated from a room snapshot or codemode ask), keep
      // the settled state, consuming each untagged hydrated call at most once so a second parallel
      // start upgrades any remaining hydrated sibling.
      if (occurrenceId || effectiveRow || parentToolCallId) {
        const exactOccSettled = occurrenceId
          ? state.tools.findIndex(
              t =>
                t.status !== 'running' &&
                t.id === incomingId &&
                t.name === incomingName &&
                (t.parentToolCallId ?? '') === (parentToolCallId ?? '') &&
                (!parentOccurrenceId ||
                  !t.parentOccurrenceId ||
                  t.parentOccurrenceId === parentOccurrenceId) &&
                t.occurrenceId === occurrenceId
            )
          : -1
        let settledIdx = exactOccSettled
        if (settledIdx < 0 && (effectiveRow || parentToolCallId)) {
          const settledIndices: number[] = []
          for (let idx = 0; idx < state.tools.length; idx++) {
            const t = state.tools[idx]!
            if (
              t.status !== 'running' &&
              !t.liveStarted &&
              t.id === incomingId &&
              t.name === incomingName &&
              (t.parentToolCallId ?? '') === (parentToolCallId ?? '') &&
              (explicitParentOccurrenceId
                ? t.parentOccurrenceId === explicitParentOccurrenceId
                : !parentOccurrenceId ||
                  !t.parentOccurrenceId ||
                  t.parentOccurrenceId === parentOccurrenceId) &&
              (!occurrenceId || !t.occurrenceId || t.occurrenceId === occurrenceId) &&
              (!toolTurnId || !t.turnId || t.turnId === toolTurnId) &&
              (parentToolCallId
                ? !effectiveRow || !t.row || t.row === effectiveRow
                : Boolean(effectiveRow) && t.row === effectiveRow) &&
              (!incomingAskCall || asksCompatible(toAskCall(t), incomingAskCall))
            ) {
              settledIndices.push(idx)
            }
          }
          const canReuseSettled =
            settledIndices.length === 1 ||
            (settledIndices.length > 1 &&
              (!incomingAskCall ||
                settledIndices.every(idx => {
                  const first = state.tools[settledIndices[0]!]!
                  const current = state.tools[idx]!
                  return (
                    current.row === first.row &&
                    (current.parentToolCallId ?? '') === (first.parentToolCallId ?? '') &&
                    askSameSignature(toAskCall(current), toAskCall(first))
                  )
                })))
          if (canReuseSettled) settledIdx = settledIndices[0]!
        }
        if (settledIdx >= 0) {
          return {
            ...state,
            turnId: toolTurnId,
            tools: state.tools.map((t, idx) =>
              idx === settledIdx
                ? {
                    ...t,
                    liveStarted: true,
                    ...(occurrenceId && !t.occurrenceId && { occurrenceId }),
                    ...(parentOccurrenceId && !t.parentOccurrenceId && { parentOccurrenceId }),
                    ...(toolTurnId && !t.turnId && { turnId: toolTurnId }),
                    ...(incomingAction !== undefined && !t.action && { action: incomingAction }),
                    args: t.args ?? incomingArgs
                  }
                : t
            ),
            activity,
            busy: true
          }
        }
      }
      // If a busy snapshot already hydrated this running `message_bot` declaration,
      // upgrade it in place so a buffered untagged `tool.start` (reused `call_0`)
      // never creates an ambiguous duplicate before `tool.complete`.
      if (incomingAskCall && p.tool_id !== undefined) {
        const exactOccRunning = occurrenceId
          ? state.tools.findIndex(
              t =>
                t.status === 'running' &&
                t.name === 'message_bot' &&
                t.id === incomingId &&
                (t.parentToolCallId ?? '') === (parentToolCallId ?? '') &&
                (!parentOccurrenceId ||
                  !t.parentOccurrenceId ||
                  t.parentOccurrenceId === parentOccurrenceId) &&
                t.occurrenceId === occurrenceId &&
                (!toolTurnId || !t.turnId || t.turnId === toolTurnId)
            )
          : -1
        const hydratedIndices: number[] = exactOccRunning >= 0 ? [exactOccRunning] : []
        if (exactOccRunning < 0) {
          for (let idx = 0; idx < state.tools.length; idx++) {
            const t = state.tools[idx]!
            if (
              t.hydrated &&
              !t.liveStarted &&
              t.status === 'running' &&
              t.name === 'message_bot' &&
              t.id === incomingId &&
              (t.parentToolCallId ?? '') === (parentToolCallId ?? '') &&
              (explicitParentOccurrenceId
                ? t.parentOccurrenceId === explicitParentOccurrenceId
                : !parentOccurrenceId ||
                  !t.parentOccurrenceId ||
                  t.parentOccurrenceId === parentOccurrenceId) &&
              (!occurrenceId || !t.occurrenceId || t.occurrenceId === occurrenceId) &&
              (!effectiveRow || !t.row || t.row === effectiveRow) &&
              (!toolTurnId || !t.turnId || t.turnId === toolTurnId) &&
              asksCompatible(toAskCall(t), incomingAskCall)
            ) {
              hydratedIndices.push(idx)
            }
          }
        }
        const interchangeableHydrated =
          hydratedIndices.length === 1 ||
          (hydratedIndices.length > 1 &&
            hydratedIndices.every(idx => {
              const first = state.tools[hydratedIndices[0]!]!
              const current = state.tools[idx]!
              return (
                current.row === first.row &&
                current.parentOccurrenceId === first.parentOccurrenceId &&
                askSameSignature(toAskCall(current), toAskCall(first))
              )
            }))
        if (interchangeableHydrated) {
          const matchIdx = hydratedIndices[0]!
          return {
            ...state,
            turnId: toolTurnId,
            tools: state.tools.map((t, idx) =>
              idx === matchIdx
                ? {
                    ...t,
                    hydrated: undefined,
                    liveStarted: true,
                    after: state.interim.length,
                    ...(occurrenceId && !t.occurrenceId && { occurrenceId }),
                    ...(parentOccurrenceId && !t.parentOccurrenceId && { parentOccurrenceId }),
                    ...(effectiveRow && !t.row && { row: effectiveRow }),
                    ...(toolTurnId && !t.turnId && { turnId: toolTurnId }),
                    ...(freshAfter !== undefined && t.afterHistoryCount === undefined && {
                      afterHistoryCount: freshAfter
                    }),
                    ...(freshExchange !== undefined && t.freshExchange === undefined && {
                      freshExchange
                    }),
                    ...(incomingAction !== undefined && { action: incomingAction }),
                    args: incomingArgs ?? t.args
                  }
                : t
            ),
            activity,
            busy: true
          }
        }
      }
      const sameArgs = (a: unknown, b: unknown) => {
        if (a == null || b == null) return true
        try {
          return JSON.stringify(a) === JSON.stringify(b)
        } catch {
          return false
        }
      }
      const sameOccurrence = (t: ChatTool) => {
        if (t.id !== incomingId || t.name !== incomingName) return false
        if ((t.parentToolCallId ?? '') !== (parentToolCallId ?? '')) return false
        if (parentOccurrenceId && t.parentOccurrenceId && t.parentOccurrenceId !== parentOccurrenceId)
          return false
        if (occurrenceId && t.occurrenceId) return t.occurrenceId === occurrenceId
        if (occurrenceId || t.occurrenceId) return false
        // Parallel same-fragment `message_bot` starts without occurrence IDs stay distinct;
        // hydrated and settled matches were already reconciled above.
        if (incomingAskCall) return false
        if (incomingAction && t.action && incomingAction !== t.action) return false
        if (!sameArgs(incomingArgs, t.args)) return false
        if (effectiveRow && t.row) return t.row === effectiveRow && t.status === 'running'
        if (effectiveRow || t.row) return false
        return t.status === 'running'
      }
      return {
        ...state,
        turnId: toolTurnId,
        tools: [
          ...state.tools.filter(t => !sameOccurrence(t)),
          {
            id: incomingId,
            name: incomingName,
            after: state.interim.length,
            liveStarted: true,
            ...(occurrenceId && { occurrenceId }),
            ...(parentToolCallId && { parentToolCallId }),
            ...(parentOccurrenceId && { parentOccurrenceId }),
            ...(effectiveRow && { row: effectiveRow }),
            ...(toolTurnId && { turnId: toolTurnId }),
            ...(freshAfter !== undefined && { afterHistoryCount: freshAfter }),
            ...(freshExchange !== undefined && { freshExchange }),
            ...(incomingAction !== undefined && { action: incomingAction }),
            args: incomingArgs,
            detail: '',
            status: 'running'
          }
        ],
        activity,
        busy: true
      }
    }
    case 'tool.complete': {
      const failed = Boolean(p.is_error || (p.result as Record<string, unknown>)?.error)
      const toolTurnId = turnId ?? state.turnId
      const completeId = String(p.tool_id)
      const occurrenceId =
        typeof p.occurrence_id === 'string' && p.occurrence_id ? p.occurrence_id : undefined
      const parentToolCallId =
        typeof p.parent_tool_call_id === 'string' && p.parent_tool_call_id
          ? p.parent_tool_call_id
          : undefined
      // The card it showed says so when the work the user agreed to failed.
      const broke = agreedThenFailed({ result: p.result ?? p.result_text, status: failed ? 'error' : 'ok' })
      const completeName =
        typeof p.name === 'string' && p.name
          ? p.name
          : typeof p.tool_name === 'string' && p.tool_name
            ? p.tool_name
            : undefined
      const completeDetail = detailOf(p.result ?? p.result_text)
      const completeAskCall =
        !completeName || completeName === 'message_bot'
          ? {
              args: parseArgs(p.args ?? p.args_text),
              name: 'message_bot',
              ...(occurrenceId && { occurrenceId }),
              result: completeDetail,
              status: failed ? ('error' as const) : ('ok' as const),
              summary: typeof p.context === 'string' ? p.context : undefined
            }
          : null
      const activeParents = parentToolCallId
        ? state.tools.filter(
            t =>
              !t.parentToolCallId &&
              t.id === parentToolCallId &&
              t.status === 'running' &&
              (!toolTurnId || !t.turnId || t.turnId === toolTurnId)
          )
        : []
      const explicitParentOccurrenceId =
        typeof p.parent_occurrence_id === 'string' && p.parent_occurrence_id
          ? p.parent_occurrence_id
          : undefined
      const activeParentOccurrenceId =
        explicitParentOccurrenceId ??
        (activeParents.length === 1 ? activeParents[0]!.occurrenceId : undefined)
      const candidates: number[] = []
      for (let index = 0; index < state.tools.length; index++) {
        const t = state.tools[index]!
        if (t.id !== completeId) continue
        if (completeName && t.name !== completeName) continue
        if (
          parentToolCallId
            ? t.parentToolCallId !== parentToolCallId ||
              (activeParentOccurrenceId &&
                t.parentOccurrenceId &&
                t.parentOccurrenceId !== activeParentOccurrenceId) ||
              (explicitParentOccurrenceId &&
                t.status !== 'running' &&
                t.parentOccurrenceId !== explicitParentOccurrenceId)
            : Boolean(t.parentToolCallId) &&
              (Boolean(occurrenceId) ||
                t.name === 'message_bot' ||
                completeName === 'message_bot')
        ) {
          continue
        }
        if (occurrenceId && t.occurrenceId && t.occurrenceId !== occurrenceId) continue
        if (row && t.row && t.row !== row) continue
        if (!(occurrenceId && t.occurrenceId) && t.name === 'message_bot' && completeAskCall) {
          if (!asksCompatible(toAskCall(t), completeAskCall)) continue
        }
        candidates.push(index)
      }
      const exactParentOcc = activeParentOccurrenceId
        ? candidates.filter(
            index => state.tools[index]!.parentOccurrenceId === activeParentOccurrenceId
          )
        : []
      const scopedCandidates = exactParentOcc.length ? exactParentOcc : candidates
      const exactOcc = occurrenceId
        ? scopedCandidates.filter(index => state.tools[index]!.occurrenceId === occurrenceId)
        : []
      const exact = exactOcc.length
        ? exactOcc
        : row
          ? scopedCandidates.filter(index => state.tools[index]!.row === row)
          : []
      const baseMatches = exact.length
        ? exact
        : scopedCandidates.filter(index => !row || !state.tools[index]!.row)
      const incomingContext = typeof p.context === 'string' && p.context ? p.context : undefined
      const contextMatches =
        !completeAskCall && !occurrenceId && baseMatches.length > 1 && incomingContext
          ? baseMatches.filter(index => state.tools[index]!.action === incomingContext)
          : []
      const matches = contextMatches.length ? contextMatches : baseMatches
      const settledUncompleted = matches.filter(
        index =>
          state.tools[index]!.status !== 'running' &&
          !state.tools[index]!.liveCompleted &&
          (!explicitParentOccurrenceId ||
            state.tools[index]!.parentOccurrenceId === explicitParentOccurrenceId)
      )
      const runningMatches = matches.filter(index => state.tools[index]!.status === 'running')
      const canPickSettledReplay =
        settledUncompleted.length >= 1 &&
        (settledUncompleted.length === 1 ||
          (Boolean(completeAskCall) &&
            !occurrenceId &&
            settledUncompleted.every(idx => {
              const first = state.tools[settledUncompleted[0]!]!
              const current = state.tools[idx]!
              return (
                current.row === first.row && askSameSignature(toAskCall(current), toAskCall(first))
              )
            })))
      const canPickRunning =
        settledUncompleted.length === 0 &&
        runningMatches.length >= 1 &&
        (runningMatches.length === 1 ||
          (Boolean(completeAskCall) &&
            !occurrenceId &&
            runningMatches.every(idx => {
              const first = state.tools[runningMatches[0]!]!
              const current = state.tools[idx]!
              return (
                current.row === first.row && askSameSignature(toAskCall(current), toAskCall(first))
              )
            })))
      const matchIndex =
        exactOcc.length === 1
          ? exactOcc[0]!
          : canPickSettledReplay
            ? settledUncompleted[0]!
            : canPickRunning
              ? runningMatches[0]!
              : matches.length === 1
                ? matches[0]!
                : -1
      const absorbedWhileRunning =
        exactOcc.length !== 1 &&
        canPickSettledReplay &&
        failed &&
        runningMatches.length > 0 &&
        !occurrenceId &&
        Boolean(completeAskCall)
      const runningMatchSet =
        matchIndex < 0 && runningMatches.length > 1 ? new Set(runningMatches) : null
      const nextTools =
        matchIndex >= 0
          ? state.tools.map((t, index) =>
              index === matchIndex
                ? {
                    ...t,
                    ...(absorbedWhileRunning
                      ? { absorbedError: detailOf(p.result ?? p.result_text) }
                      : { absorbedError: undefined }),
                    ambiguousOutcomes: undefined,
                    hydrated: undefined,
                    liveCompleted: true,
                    ...(occurrenceId && !t.occurrenceId && { occurrenceId }),
                    ...(activeParentOccurrenceId &&
                      !t.parentOccurrenceId && { parentOccurrenceId: activeParentOccurrenceId }),
                    ...(row && !t.row && { row }),
                    ...(toolTurnId && !t.turnId && { turnId: toolTurnId }),
                    status: failed ? ('error' as const) : ('ok' as const),
                    detail: detailOf(p.result ?? p.result_text)
                  }
                : t
            )
          : runningMatchSet
            ? state.tools.map((t, index) => {
                if (!runningMatchSet.has(index)) return t
                const prev = t.ambiguousOutcomes ?? { failed: 0, ok: 0 }
                return {
                  ...t,
                  ambiguousOutcomes: {
                    error: prev.error ?? (failed ? completeDetail || 'Tool failed' : undefined),
                    failed: prev.failed + (failed ? 1 : 0),
                    ok: prev.ok + (failed ? 0 : 1)
                  }
                }
              })
            : matches.length === 0 && (typeof p.name === 'string' || typeof p.tool_name === 'string')
              ? [
                  ...state.tools,
                  {
                    id: completeId,
                    name: String(p.name ?? p.tool_name),
                    after: state.interim.length,
                    liveCompleted: true,
                    ...(occurrenceId && { occurrenceId }),
                    ...(parentToolCallId && { parentToolCallId }),
                    ...(activeParentOccurrenceId && {
                      parentOccurrenceId: activeParentOccurrenceId
                    }),
                    ...(row && { row }),
                    ...(toolTurnId && { turnId: toolTurnId }),
                    ...(typeof p.context === 'string' && { action: p.context }),
                    args: parseArgs(p.args ?? p.args_text),
                    detail: detailOf(p.result ?? p.result_text),
                    status: failed ? ('error' as const) : ('ok' as const)
                  }
                ]
              : state.tools
      return {
        ...state,
        turnId: toolTurnId,
        approvals: broke
          ? state.approvals.map(a =>
              a.toolId === completeId && a.decision && a.decision !== 'deny'
                ? { ...a, failed: true }
                : a
            )
          : state.approvals,
        tools: nextTools,
        activity: state.checking
      }
    }
    case 'error':
      return {
        ...state,
        error: typeof p.message === 'string' ? p.message : 'The bot could not finish.',
        busy: false,
        turnId: undefined,
        startedFresh: undefined,
        freshExchange: undefined,
        tools: settleTurnTools(
          state.tools,
          true,
          state.turnId,
          !state.turnId && state.startedFresh ? state.turnAt : undefined,
          !state.turnId && state.startedFresh ? state.freshExchange : undefined
        )
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
  const storedByTurn = state.messages.flatMap(m =>
    (m.tools ?? []).flatMap(tool => {
      const turn = tool.turnId ?? m.turnId
      return turn ? [{ tool, turn }] : []
    })
  )
  // Older daemons omit `turn_id`: only tools after the latest user message or peer question
  // (projected as an assistant row with `sender`) can belong to the in-progress turn, so reused
  // provider IDs from earlier exchanges are never dropped.
  let lastBoundaryIndex = -1
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]
    if (m?.role === 'user' || (m?.role === 'assistant' && Boolean(m.sender))) {
      lastBoundaryIndex = i
      break
    }
  }
  const trailing = state.messages.slice(lastBoundaryIndex + 1)
  const trailingRowIds = new Set(trailing.flatMap(m => (m.rowId ? [m.rowId] : [])))
  const trailingUntagged = trailing.flatMap(m =>
    (m.tools ?? []).filter(t => !(t.turnId ?? m.turnId))
  )
  let untiedFresh = false
  const matchesStoredOccurrence = (live: ChatTool, stored: ChatTool) => {
    if (stored.id !== live.id || stored.name !== live.name) return false
    if ((stored.parentToolCallId ?? '') !== (live.parentToolCallId ?? '')) return false
    if (
      live.parentOccurrenceId &&
      stored.parentOccurrenceId &&
      live.parentOccurrenceId !== stored.parentOccurrenceId
    ) {
      return false
    }
    if (live.occurrenceId && stored.occurrenceId) return stored.occurrenceId === live.occurrenceId
    if (live.parentToolCallId) {
      if (live.row && stored.row && stored.row !== live.row) return false
      return live.name === 'message_bot' ? sameUntaggedAsk(live, stored) : true
    }
    if (live.row) {
      if (stored.row !== live.row) return false
      return live.name === 'message_bot' ? sameUntaggedAsk(live, stored) : true
    }
    // On a turn-tagged daemon, a stored tool bound to a single proven fragment (`stored.row`)
    // always emitted `message_id: stored.row` on its own live events (`runtime_identity.rs`).
    // An untagged live event (`!live.row`) with `turnId` only happens when a later fragment
    // reused the same provider tool ID (`call_0`), so it cannot be that earlier proven call.
    if (live.turnId && stored.row) return false
    return sameUntaggedAsk(live, stored)
  }
  let reservedPending = state.tools.filter(t => t.hydrated)
  const matchesPendingSlot = (pending: ChatTool, tool: ChatTool) =>
    tool.id === pending.id &&
    tool.name === pending.name &&
    (tool.parentToolCallId ?? '') === (pending.parentToolCallId ?? '') &&
    (!pending.parentOccurrenceId ||
      !tool.parentOccurrenceId ||
      tool.parentOccurrenceId === pending.parentOccurrenceId) &&
    (!pending.occurrenceId || !tool.occurrenceId || tool.occurrenceId === pending.occurrenceId) &&
    (!pending.row || !tool.row || tool.row === pending.row) &&
    (!pending.turnId || !tool.turnId || tool.turnId === pending.turnId) &&
    sameUntaggedAsk(pending, tool)
  const matchesAnyStored = (tool: ChatTool) => {
    if (tool.turnId) {
      return storedByTurn.some(
        entry => entry.turn === tool.turnId && matchesStoredOccurrence(tool, entry.tool)
      )
    }
    return !untiedFresh && trailingUntagged.some(stored => matchesStoredOccurrence(tool, stored))
  }
  const withoutAlreadyShown = (tools: readonly ChatTool[]): ChatTool[] => {
    // Preserve one surviving tool per initial hydrated pending declaration (which
    // `pendingTurnTools` already proved was absent from persisted history) so partial
    // replays after an earlier persisted error never suppress the running sibling.
    const reservedIndices = new Set<number>()
    for (const pending of reservedPending) {
      let bestIdx = -1
      let bestRank = Number.POSITIVE_INFINITY
      for (let idx = 0; idx < tools.length; idx++) {
        if (reservedIndices.has(idx)) continue
        const tool = tools[idx]!
        if (!matchesPendingSlot(pending, tool)) continue
        const rank = tool.hydrated
          ? 0
          : !matchesAnyStored(tool)
            ? 1
            : tool.status === 'running'
              ? 2
              : 3
        if (rank < bestRank) {
          bestRank = rank
          bestIdx = idx
          if (rank === 0) break
        }
      }
      if (bestIdx >= 0) reservedIndices.add(bestIdx)
    }
    const usedTurn = new Set<number>()
    const usedUntagged = new Set<number>()
    const keep = new Array<boolean>(tools.length).fill(true)
    // Process non-nested parents before nested children so a surviving unpersisted running
    // parent (e.g. a second `codemode` reusing `call_0`) protects its running children from
    // being suppressed against an earlier completed parent's persisted child.
    const order = tools
      .map((tool, index) => ({ index, tool }))
      .sort(
        (a, b) =>
          Number(Boolean(a.tool.parentToolCallId)) - Number(Boolean(b.tool.parentToolCallId)) ||
          Number(a.tool.status === 'running') - Number(b.tool.status === 'running')
      )
    const activeUnshownParents: { id: string; occurrenceId?: string; row?: string }[] = []
    for (const { index, tool } of order) {
      if (tool.hydrated || reservedIndices.has(index)) {
        if (!tool.parentToolCallId && tool.status === 'running') {
          activeUnshownParents.push({
            id: tool.id,
            occurrenceId: tool.occurrenceId,
            row: tool.row
          })
        }
        continue
      }
      if (
        tool.parentToolCallId &&
        tool.status === 'running' &&
        activeUnshownParents.some(
          p =>
            p.id === tool.parentToolCallId &&
            (!tool.parentOccurrenceId || p.occurrenceId === tool.parentOccurrenceId) &&
            (!tool.row || !p.row || p.row === tool.row)
        )
      ) {
        continue
      }
      if (tool.turnId) {
        const match = storedByTurn.findIndex(
          (entry, i) =>
            !usedTurn.has(i) &&
            entry.turn === tool.turnId &&
            matchesStoredOccurrence(tool, entry.tool)
        )
        if (match >= 0) {
          usedTurn.add(match)
          keep[index] = false
        }
      } else if (!untiedFresh) {
        const match = trailingUntagged.findIndex(
          (stored, i) => !usedUntagged.has(i) && matchesStoredOccurrence(tool, stored)
        )
        if (match >= 0) {
          usedUntagged.add(match)
          keep[index] = false
        }
      }
      if (keep[index] && !tool.parentToolCallId && tool.status === 'running') {
        activeUnshownParents.push({
          id: tool.id,
          occurrenceId: tool.occurrenceId,
          row: tool.row
        })
      }
    }
    return tools.filter((_, index) => keep[index])
  }
  let reread = false
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    const p = (event.payload ?? {}) as Record<string, unknown>
    if (event.type === 'message.start') {
      if (typeof p.turn_id !== 'string') {
        let tiedToTrailing = false
        let sawMessageId = false
        let runCompleted = false
        let runText = ''
        const runAsks: { expectedSent: boolean | null; id: string; target: string | null }[] = []
        for (let j = i + 1; j < events.length; j++) {
          const upcoming = events[j]!
          if (upcoming.type === 'message.start') break
          const up = (upcoming.payload ?? {}) as Record<string, unknown>
          if (typeof up.message_id === 'string') {
            sawMessageId = true
            if (trailingRowIds.has(up.message_id)) {
              tiedToTrailing = true
              break
            }
          }
          if (upcoming.type === 'message.delta' && typeof up.text === 'string') {
            runText += up.text
          } else if (upcoming.type === 'message.interim' && up.already_streamed) {
            runText = ''
          } else if (upcoming.type === 'tool.start') {
            const name = String(up.name ?? up.tool_name ?? '')
            if (name === 'message_bot') {
              const runArgs = parseArgs(up.args ?? up.args_text)
              runAsks.push({
                expectedSent: askExpectedSent(runArgs),
                id: String(up.tool_id ?? ''),
                target: askTarget({
                  args: runArgs,
                  name,
                  status: 'running',
                  summary: typeof up.context === 'string' ? up.context : undefined
                })
              })
            }
          } else if (upcoming.type === 'message.complete') {
            runCompleted = true
            if (typeof up.text === 'string' && up.text) runText = up.text
            break
          }
        }
        // On legacy daemons without message_id, if a completed buffered run's reply and asks
        // are already present in the snapshot's trailing exchange, tie it to trailing so replay
        // does not create a duplicate held ask whose boundary sits past that saved exchange.
        if (!tiedToTrailing && !sawMessageId && trailing.length > 0 && runCompleted && runAsks.length > 0) {
          const trailingTexts = trailing.map(m => m.text.trim()).filter(Boolean)
          const trimmedRun = runText.trim()
          const textMatches =
            !trailingTexts.length || (Boolean(trimmedRun) && trailingTexts.includes(trimmedRun))
          if (textMatches) {
            const usedTrailing = new Set<number>()
            tiedToTrailing = runAsks.every(runAsk => {
              const match = trailingUntagged.findIndex((stored, idx) => {
                if (usedTrailing.has(idx) || stored.id !== runAsk.id || stored.name !== 'message_bot')
                  return false
                const storedTarget = toolTarget(stored)
                if (runAsk.target && storedTarget && storedTarget !== runAsk.target) return false
                const storedAsk = toolAsk(stored)
                if (
                  runAsk.expectedSent !== null &&
                  storedAsk?.status === 'ok' &&
                  runAsk.expectedSent !== storedAsk.sent
                )
                  return false
                return true
              })
              if (match < 0) return false
              usedTrailing.add(match)
              return true
            })
          }
        }
        untiedFresh = !tiedToTrailing
      } else {
        untiedFresh = false
      }
      const next = reduceChat(state, event)
      reservedPending = []
      state = untiedFresh ? next : { ...next, freshExchange: undefined, startedFresh: undefined }
      continue
    }
    if (event.type === 'message.complete') {
      reread = true
      untiedFresh = false
      const turnId =
        (typeof p.turn_id === 'string' ? p.turn_id : undefined) ??
        state.turnId ??
        state.tools.find(t => t.turnId)?.turnId
      const freshAfter =
        !turnId && state.startedFresh && state.turnAt !== undefined ? state.turnAt : undefined
      const freshExchange = !turnId && state.startedFresh ? state.freshExchange : undefined
      const failed = isFailedCompletion(p, state.error)
      const finishedAsks = settleTurnTools(
        withoutAlreadyShown(state.tools).filter(t => t.name === 'message_bot'),
        failed,
        turnId,
        freshAfter,
        freshExchange
      ).map(t =>
        t.turnId &&
        !t.row &&
        !t.parentToolCallId &&
        t.afterHistoryCount === undefined &&
        storedByTurn.some(
          entry =>
            entry.turn === t.turnId &&
            entry.tool.id === t.id &&
            entry.tool.name === t.name &&
            (entry.tool.parentToolCallId ?? '') === (t.parentToolCallId ?? '') &&
            Boolean(entry.tool.row)
        )
          ? { ...t, afterHistoryCount: state.messages.length }
          : t
      )
      reservedPending = []
      state = {
        ...reduceChat(state, event),
        messages: state.messages,
        ...(finishedAsks.length && {
          completingAsks: {
            ...(state.completingAsks ?? {}),
            '': mergeTurnTools(state.completingAsks?.[''] ?? [], finishedAsks)
          }
        })
      }
      continue
    }
    state =
      event.type === 'message.interim'
        ? {
            ...state,
            streaming: p.already_streamed ? '' : state.streaming
          }
        : reduceChat(state, event)
  }
  state = { ...state, tools: withoutAlreadyShown(state.tools) }
  return { state, reread }
}

/**
 * Merges stored history tools with newer completing/live tools, preserving
 * first-call order and matching entries by `id`, `turnId`, source fragment
 * `row`, and legacy fresh exchange identity so reused provider tool IDs
 * (`call_0`) across fragments or buffered exchanges never overwrite each other.
 */
export function mergeTurnTools(stored: readonly ChatTool[], extra: readonly ChatTool[]): ChatTool[] {
  const merged = [...stored]
  const used = new Set<number>()
  for (const tool of extra) {
    const at = merged.findIndex((item, index) => {
      if (used.has(index) || index >= stored.length) return false
      if (
        item.id !== tool.id ||
        item.name !== tool.name ||
        (item.parentToolCallId ?? '') !== (tool.parentToolCallId ?? '') ||
        (item.parentOccurrenceId &&
          tool.parentOccurrenceId &&
          item.parentOccurrenceId !== tool.parentOccurrenceId) ||
        item.turnId !== tool.turnId ||
        item.afterHistoryCount !== tool.afterHistoryCount ||
        item.freshExchange !== tool.freshExchange
      ) {
        return false
      }
      if (item.occurrenceId && tool.occurrenceId) {
        return item.occurrenceId === tool.occurrenceId
      }
      if (item.parentToolCallId) {
        if (item.row && tool.row && item.row !== tool.row) return false
      } else if (item.row !== tool.row) {
        return false
      }
      if (item.name === 'message_bot') {
        return sameUntaggedAsk(tool, item)
      }
      return true
    })
    if (at >= 0) {
      used.add(at)
      const prev = merged[at]!
      merged[at] =
        prev.status !== 'running' && tool.status === 'running'
          ? {
              ...prev,
              ...(tool.occurrenceId && !prev.occurrenceId && { occurrenceId: tool.occurrenceId }),
              ...(tool.parentOccurrenceId &&
                !prev.parentOccurrenceId && { parentOccurrenceId: tool.parentOccurrenceId }),
              ...(tool.row && !prev.row && { row: tool.row }),
              ...(tool.action && !prev.action && { action: tool.action }),
              args: prev.args ?? tool.args,
              detail: prev.detail || tool.detail
            }
          : {
              ...tool,
              ...(prev.occurrenceId && !tool.occurrenceId && { occurrenceId: prev.occurrenceId }),
              ...(prev.parentOccurrenceId &&
                !tool.parentOccurrenceId && { parentOccurrenceId: prev.parentOccurrenceId }),
              ...(prev.row && !tool.row && { row: prev.row }),
              ...(prev.action && !tool.action && { action: prev.action }),
              args: tool.args ?? prev.args,
              detail: tool.detail || prev.detail
            }
    } else {
      merged.push(tool)
    }
  }
  return merged
}

/**
 * Retains held `completingAsks` tools that have not yet appeared in stored
 * history (for example while a daemon write retry is still queued), clearing
 * each one only once history contains an unambiguous 1-to-1 matching occurrence.
 */
export function unconfirmedTurnTools(
  held: readonly ChatTool[],
  messages: readonly ChatMessage[]
): ChatTool[] {
  if (!held.length) return []
  const storedEntries = messages.flatMap((m, msgIndex) =>
    (m.tools ?? []).map(tool => ({
      msgIndex,
      tool,
      turn: tool.turnId ?? m.turnId
    }))
  )
  let lastBoundaryIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user' || (m?.role === 'assistant' && Boolean(m.sender))) {
      lastBoundaryIndex = i
      break
    }
  }
  const used = new Set<number>()
  const consumedUntagged: { freshExchange?: number; msgIndex: number }[] = []
  const remaining: ChatTool[] = []
  for (const t of held) {
    const start = t.turnId
      ? (t.afterHistoryCount ?? 0)
      : t.afterHistoryCount !== undefined
        ? t.afterHistoryCount
        : lastBoundaryIndex + 1
    const matchIndex = storedEntries.findIndex((entry, idx) => {
      if (used.has(idx)) return false
      if (entry.tool.id !== t.id || entry.tool.name !== t.name) return false
      if ((entry.tool.parentToolCallId ?? '') !== (t.parentToolCallId ?? '')) return false
      if (
        t.parentOccurrenceId &&
        entry.tool.parentOccurrenceId &&
        t.parentOccurrenceId !== entry.tool.parentOccurrenceId
      ) {
        return false
      }
      if (t.turnId) {
        if (entry.turn !== t.turnId || entry.msgIndex < start) return false
      } else {
        if (entry.turn || entry.msgIndex < start) return false
      }
      if (t.occurrenceId && entry.tool.occurrenceId) return entry.tool.occurrenceId === t.occurrenceId
      if (t.parentToolCallId) {
        if (t.row && entry.tool.row && entry.tool.row !== t.row) return false
        return t.name === 'message_bot' ? sameUntaggedAsk(t, entry.tool) : true
      }
      if (t.row) {
        if (entry.tool.row !== t.row) return false
        return t.name === 'message_bot' ? sameUntaggedAsk(t, entry.tool) : true
      }
      return sameUntaggedAsk(t, entry.tool)
    })
    if (matchIndex >= 0) {
      used.add(matchIndex)
      if (!t.turnId) {
        consumedUntagged.push({
          freshExchange: t.freshExchange,
          msgIndex: storedEntries[matchIndex]!.msgIndex
        })
      }
    } else {
      remaining.push(t)
    }
  }
  if (!consumedUntagged.length) return remaining
  // Advance strictly later untagged exchanges past any stored message already consumed by an
  // earlier untagged exchange so re-reading the same partial snapshot never confirms two asks
  // with one stored result.
  return remaining.map(t => {
    if (t.turnId || t.freshExchange === undefined) return t
    let minNext = t.afterHistoryCount ?? 0
    for (const consumed of consumedUntagged) {
      if (consumed.freshExchange !== undefined && consumed.freshExchange < t.freshExchange) {
        minNext = Math.max(minNext, consumed.msgIndex + 1)
      }
    }
    return minNext !== t.afterHistoryCount ? { ...t, afterHistoryCount: minNext } : t
  })
}

/**
 * Stable list key for a bot-to-bot ask row across live -> settled transitions.
 * Includes exchange identity (`turnId` when available, else turn index) and
 * target bot so reused tool IDs (`call_0`) across turns or fragments never collide.
 */
export function askItemId({
  isRoom,
  speaker,
  target,
  toolId,
  turnId,
  turnIndex
}: {
  isRoom: boolean
  speaker: string
  target: string | null
  toolId?: string
  turnId?: string
  turnIndex: number
}): string {
  const exchange = !isRoom && turnId ? `t-${turnId}` : `n-${turnIndex}`
  const who = target ?? 'teammate'
  const subject = !isRoom && toolId ? `${toolId}-${who}` : who
  return `ask-${speaker}-${exchange}-${subject}`
}

/**
 * Groups settled `message_bot` tools onto the last assistant message of each
 * turn. Rooms treat every durable `message.bot` as its own turn; peer threads
 * use each message's explicit `sender` before falling back to `chatBot`, so
 * the asking bot's questions separate consecutive exchanges; 1:1 chats keep
 * distinct `turnId` exchanges apart (even when a hidden row sat between them)
 * while merging multi-fragment assistant turns into one ask row per target.
 */
export function turnAskGroups(
  messages: readonly ChatMessage[],
  { chatBot, isRoom }: { chatBot?: string; isRoom: boolean }
): {
  botTurnTotal: Record<string, number>
  groups: Map<number, { speaker: string; tools: ChatTool[]; turnId?: string; turnIndex: number }>
  trailingUntaggedSpeaker?: string
} {
  const groups = new Map<
    number,
    { speaker: string; tools: ChatTool[]; turnId?: string; turnIndex: number }
  >()
  const botTurnTotal: Record<string, number> = {}
  let pendingSpeaker: string | undefined
  let pendingTurnId: string | undefined
  let pendingTools: ChatTool[] = []
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]!
    const speaker = m.role === 'assistant' ? (m.sender ?? chatBot) : undefined
    if (speaker) {
      if (pendingSpeaker !== speaker || pendingTurnId !== m.turnId) {
        pendingSpeaker = speaker
        pendingTurnId = m.turnId
        pendingTools = []
      }
      if (m.tools?.length) pendingTools.push(...m.tools)
    } else {
      pendingSpeaker = undefined
      pendingTurnId = undefined
      pendingTools = []
    }
    const next = messages[index + 1]
    const nextSpeaker = next?.role === 'assistant' ? (next.sender ?? chatBot) : undefined
    const sameTurn = !isRoom && nextSpeaker === speaker && m.turnId === next?.turnId
    const turnEnd = Boolean(speaker && !sameTurn)
    if (turnEnd && speaker) {
      const turnIndex = botTurnTotal[speaker] ?? 0
      botTurnTotal[speaker] = turnIndex + 1
      if (pendingTools.length) {
        groups.set(index, {
          speaker,
          tools: pendingTools,
          ...(pendingTurnId && { turnId: pendingTurnId }),
          turnIndex
        })
      }
      pendingSpeaker = undefined
      pendingTurnId = undefined
      pendingTools = []
    }
  }
  const last = messages.at(-1)
  const trailingUntaggedSpeaker =
    !isRoom && last?.role === 'assistant' && !last.turnId ? (last.sender ?? chatBot) : undefined
  return { botTurnTotal, groups, ...(trailingUntaggedSpeaker && { trailingUntaggedSpeaker }) }
}
