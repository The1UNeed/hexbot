/**
 * Per live session transcript state: ordered messages, the streaming buffer,
 * tool calls, approvals and usage. This is the only hot store; everything
 * else in `src/stores` is small.
 *
 * Side effects the daemon contract requires (`hexbot.sections.touch` after a
 * turn, `approval.received` when an approval card appears, native
 * notifications) go through the injectable `TranscriptEffects` so tests can
 * observe them without a socket.
 */

import { create } from 'zustand'

import {
  approvalReceived,
  approvalRespond,
  clarifyAnswered,
  clarifyQuestions,
  clarifyRespond,
  nextMessageId,
  sectionsTouch
} from '../lib/api'
import { getBridge } from '../lib/bridge'
import { toMillis } from '../lib/time'
import type {
  ApprovalChoice,
  ApprovalRequest,
  Attachment,
  ClarifyRequest,
  ClarifyRequestPayload,
  ContextUsage,
  Message,
  SessionInfo,
  StatusLine,
  ToolCall,
  Usage
} from '../lib/types'

/** Why an error row exists, when the daemon knows more than the text. */
export interface ErrorDetail {
  /** Connector catalog id, when the failure came from one (drives "Fix <name>"). */
  connector: null | string
  connectorName?: string
  incidentId?: string
}

/** An incident within this long of an error row is the same failure, not a new card. */
const INCIDENT_MERGE_MS = 15_000

/** A transcript message; error rows may carry a detail the daemon reported. */
export type TranscriptMessage = Message & { errorDetail?: ErrorDetail }

export interface AnswerAttempt {
  epoch: number
  revision: number
  /** Partial question batches have not resumed the bot. */
  answered?: boolean
}

export interface Transcript {
  /** Unique across drop/reopen, even when the daemon reuses the live id. */
  epoch: number
  /** Advances on authoritative state, including while an answer RPC is in flight. */
  authorityRevision: number
  /** A successful local answer, valid until a newer authoritative update or reconnect. */
  answeredWaiting?: { kind: 'approval' | 'clarify'; requestId: string }
  /** Exact requests confirmed pending; an unrelated Working event does not settle them. */
  waitingRequests?: { kind: 'approval' | 'clarify'; requestId: string; revision: number }[]
  /** A new turn successfully resolved this session's section-scoped retry incident. */
  retryResolved?: boolean
  /** A fresh daemon transition, never inferred from retained status text. */
  liveStatus?: 'idle' | 'needs_you' | 'working'
  approvals: ApprovalRequest[]
  /** Canonical settlements also cover an answer arriving before its card replay. */
  approvalDecisions?: Record<string, ApprovalChoice>
  /** Questions the bot asked through the clarify tool, oldest first. */
  clarifies: ClarifyRequest[]
  clarifyAnswers?: Record<string, Record<string, string>>
  /** Exact settlement survives same-session snapshots, including expiry before card replay. */
  settledClarifyIds?: string[]
  /** The context meter; null until the daemon has reported it. */
  context: null | ContextUsage
  /** Inline error rows are also pushed as messages; this is the header copy. */
  error: null | string
  info: null | SessionInfo
  messages: TranscriptMessage[]
  /** The section this live session belongs to, when known. */
  sectionId?: string
  /** Ownership survives aggregate status moving to another conversation. */
  bot?: string
  sessionId: string
  status: null | StatusLine
  /** Id of the assistant message currently receiving deltas. */
  streamingMessageId: null | string
  /**
   * Text of the bubbles a question or approval card closed during this
   * turn. `message.complete` carries the whole turn, so this much is cut
   * from its front before it lands in the bubble that followed the card.
   */
  turnPrefix?: string
  usage: null | Usage
}

export interface TranscriptEffects {
  ackApproval(sessionId: string, requestId: string): void
  notify(input: { body: string; sectionId?: string; title: string }): void
  touchSection(sectionId: string): void
}

export interface MessageCompletePayload {
  error?: string
  partial?: boolean
  status?: string
  text?: string
  usage?: Usage
}

export interface ToolStartPayload {
  parent_tool_call_id?: string
  args?: unknown
  args_text?: string
  context?: string
  name?: string
  tool_id?: string
}

export interface ToolCompletePayload {
  parent_tool_call_id?: string
  args?: unknown
  duration_s?: number
  name?: string
  result?: unknown
  result_text?: string
  summary?: string
  tool_id?: string
}

export interface ApprovalRequestPayload {
  choices?: ApprovalChoice[]
  command?: string
  reason?: string
  request_id?: string
  tool?: string
}

export interface ApprovalResolvedPayload {
  choice: ApprovalChoice
  request_id: string
}

export interface ClarifyResolvedPayload {
  answers: Record<string, string>
  request_id: string
  status: 'answered' | 'waiting'
}

export interface TranscriptsState {
  clearAnsweredWaiting: (
    sectionIds?: readonly string[],
    sessionIds?: readonly string[],
    throughRevision?: number,
    options?: { preserveWaiting?: boolean; idle?: boolean }
  ) => void
  answerClarify: (
    sessionId: string,
    requestId: string,
    questionId: string,
    answer: string,
    attempt?: AnswerAttempt
  ) => void
  approvalRequest: (
    sessionId: string,
    payload: ApprovalRequestPayload,
    options?: { notify?: boolean }
  ) => void
  approvalResolved: (
    sessionId: string,
    payload: ApprovalResolvedPayload,
    attempt?: AnswerAttempt
  ) => void
  clarifyResolved: (
    sessionId: string,
    payload: ClarifyResolvedPayload,
    attempt?: AnswerAttempt
  ) => void
  clarifyExpire: (
    sessionId: string,
    requestId: string,
    options?: { preserveEvidence?: boolean }
  ) => void
  clarifyRequest: (
    sessionId: string,
    payload: ClarifyRequestPayload & { answers?: Record<string, string> },
    options?: { notify?: boolean; confirmPending?: boolean }
  ) => void
  appendUserMessage: (sessionId: string, text: string, attachments?: Attachment[]) => Message
  warnings: Record<string, string>
  setWarning: (sectionId: string, message: string | null) => void
  bySession: Record<string, Transcript>
  drop: (sessionId: string) => void
  dropAll: () => void
  errorEvent: (sessionId: string, message: string, detail?: ErrorDetail) => void
  /**
   * A Stopped card from a daemon incident. Unlike `errorEvent` it leaves the
   * streaming message alone: the incident fires mid-turn (a tool refused) and
   * the reply keeps streaming after it.
   */
  incidentEvent: (sessionId: string, message: string, detail: ErrorDetail) => void
  messageComplete: (sessionId: string, payload?: MessageCompletePayload) => void
  messageDelta: (sessionId: string, text: string) => void
  messageInterim: (sessionId: string, text: string, alreadyStreamed?: boolean) => void
  messageStart: (sessionId: string, retryResolved?: boolean) => void
  open: (
    sessionId: string,
    sectionId: string,
    messages: Message[],
    throughRevision?: number,
    bot?: string,
    options?: { preserveWaiting?: boolean }
  ) => void
  reasoningDelta: (sessionId: string, text: string) => void
  resolveApproval: (
    sessionId: string,
    requestId: string,
    choice: ApprovalChoice,
    attempt?: AnswerAttempt
  ) => void
  respondApproval: (sessionId: string, requestId: string, choice: ApprovalChoice) => Promise<void>
  respondClarify: (
    sessionId: string,
    requestId: string,
    answer: string,
    questionId?: string
  ) => Promise<void>
  sessionContext: (sessionId: string, context: ContextUsage) => void
  sessionInfo: (sessionId: string, info: SessionInfo) => void
  sessionUsage: (sessionId: string, usage: Usage) => void
  setSectionId: (sessionId: string, sectionId: string, bot?: string) => void
  statusUpdate: (sessionId: string, status: StatusLine) => void
  thinkingDelta: (sessionId: string, text: string) => void
  toolComplete: (sessionId: string, payload: ToolCompletePayload) => void
  toolStart: (sessionId: string, payload: ToolStartPayload) => void
}

const defaultEffects: TranscriptEffects = {
  ackApproval(sessionId, requestId) {
    void approvalReceived(sessionId, requestId).catch(() => undefined)
  },
  notify(input) {
    getBridge()?.notify(input)
  },
  touchSection(sectionId) {
    void sectionsTouch(sectionId).catch(() => undefined)
  }
}

let effects: TranscriptEffects = defaultEffects

/** Send a native notification through the same effect the store uses. */
export function transcriptNotify(input: { body: string; sectionId?: string; title: string }): void {
  effects.notify(input)
}

/** Override one or more effects (tests, or the Electron notification path). */
export function setTranscriptEffects(next: Partial<TranscriptEffects>): void {
  effects = { ...effects, ...next }
}

export function resetTranscriptEffects(): void {
  effects = defaultEffects
}

let authorityRevision = 0
// A settlement can precede a cold card snapshot, but cannot reopen a dropped session.
const droppedSessions = new Set<string>()

/** A roster RPC can only supersede transcript evidence that existed when it started. */
export function transcriptRevision(): number {
  return authorityRevision
}

function advanceAuthority(transcript: Transcript): Transcript {
  return {
    ...transcript,
    answeredWaiting: undefined,
    liveStatus: undefined,
    authorityRevision: ++authorityRevision
  }
}

function retireAuthority(
  transcript: Transcript,
  options: { preserveWaiting?: boolean; idle?: boolean } = {}
): Transcript {
  return {
    ...advanceAuthority(transcript),
    waitingRequests: options.preserveWaiting ? transcript.waitingRequests : [],
    liveStatus: options.idle ? 'idle' : undefined,
    retryResolved: undefined
  }
}

/** A successful exact answer can settle its own replay, but never a newer sibling card. */
function confirmedReplay(transcript: Transcript, kind: 'approval' | 'clarify', requestId: string) {
  return (
    transcript.liveStatus !== 'idle' &&
    Boolean(transcript.waitingRequests?.length) &&
    transcript.waitingRequests?.every(
      item =>
        item.kind === kind &&
        item.requestId === requestId &&
        item.revision === transcript.authorityRevision
    )
  )
}

export function emptyTranscript(sessionId: string, sectionId?: string): Transcript {
  const epoch = ++authorityRevision

  return {
    epoch,
    authorityRevision: epoch,
    approvals: [],
    clarifies: [],
    waitingRequests: [],
    context: null,
    error: null,
    info: null,
    messages: [],
    sectionId,
    sessionId,
    status: null,
    streamingMessageId: null,
    usage: null
  }
}

function newAssistantMessage(): Message {
  return {
    attachments: [],
    createdAt: Date.now(),
    id: nextMessageId('a'),
    role: 'assistant',
    streaming: true,
    text: '',
    toolCalls: []
  }
}

function replaceMessage(
  transcript: Transcript,
  id: string,
  patch: (message: Message) => Message
): Transcript {
  return {
    ...transcript,
    messages: transcript.messages.map(message => (message.id === id ? patch(message) : message))
  }
}

/**
 * Hexbot's spinner copy, "(◔_◔) pondering...": a face without letters and one
 * verb. Wait notices ("⏳ waiting on the provider — 30s ...") are kept.
 */
const SPINNER_LINE = /^[^a-z]*[a-z]+\.\.\.$/i

/** A question the bot still waits on: not every answer is in and it has not expired. */
export const clarifyWaiting = (clarify: ClarifyRequest) =>
  !clarify.expired && !clarifyAnswered(clarify)

const sameAnswers = (left: Record<string, string>, right: Record<string, string>) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every(key => left[key] === right[key])

/**
 * Ends the message the bot is writing: its words become a finished part, and
 * whatever it writes next starts a new bubble.
 */
function closePart(message: Message): Message {
  return message.text.trim()
    ? { ...message, parts: [...(message.parts ?? []), message.text], text: '' }
    : message
}

/**
 * A card that blocks the turn (a question, an approval) ends the bubble in
 * progress so the bot's next words start a new one under the card. The
 * closed bubble's text is remembered for `messageComplete`.
 */
function closeForCard(transcript: Transcript): Transcript {
  const currentId = transcript.streamingMessageId
  const current = currentId ? transcript.messages.find(item => item.id === currentId) : undefined

  if (!current) {
    return transcript
  }

  return {
    ...replaceMessage(transcript, current.id, message => settle({ ...message, streaming: false })),
    streamingMessageId: null,
    turnPrefix: (transcript.turnPrefix ?? '') + [...(current.parts ?? []), current.text].join('')
  }
}

/**
 * A closed message's last words go in `text`, the parts before them stay
 * parts. `message.complete` carries the bot's last message, which is already
 * a part when the turn stopped right after a tool.
 */
function settle(message: Message, finalText?: string): Message {
  const text = finalText || message.text
  const last = message.parts?.at(-1)

  return last !== undefined && (!text.trim() || text.trim() === last.trim())
    ? { ...message, parts: message.parts?.slice(0, -1), text: last }
    : { ...message, text }
}

/**
 * The assistant message deltas and tool calls attach to. Hexbot can emit a
 * delta or a tool call without a preceding `message.start` (a resumed turn),
 * so one is opened on demand.
 */
function withCurrentAssistant(
  transcript: Transcript,
  patch: (message: Message) => Message
): Transcript {
  const currentId = transcript.streamingMessageId

  const current = currentId
    ? transcript.messages.find(message => message.id === currentId)
    : undefined

  if (current) {
    return replaceMessage(transcript, current.id, patch)
  }

  const created = patch(newAssistantMessage())

  return {
    ...transcript,
    messages: [...transcript.messages, created],
    streamingMessageId: created.id
  }
}

export const useTranscripts = create<TranscriptsState>((set, get) => {
  const update = (sessionId: string, patch: (transcript: Transcript) => Transcript): void => {
    set(state => {
      const current = state.bySession[sessionId] ?? emptyTranscript(sessionId)

      return { bySession: { ...state.bySession, [sessionId]: patch(current) } }
    })
  }

  return {
    warnings: {},
    setWarning(sectionId, message) {
      set(state => {
        const warnings = { ...state.warnings }

        if (message) {
          warnings[sectionId] = message
        } else {
          delete warnings[sectionId]
        }

        return { warnings }
      })
    },
    bySession: {},

    clearAnsweredWaiting(sectionIds, sessionIds, throughRevision = Infinity, options = {}) {
      const matches = (transcript: Transcript) =>
        transcript.authorityRevision <= throughRevision &&
        ((!sectionIds && !sessionIds) ||
          (transcript.sectionId && sectionIds?.includes(transcript.sectionId)) ||
          sessionIds?.includes(transcript.sessionId))

      set(state => {
        if (!Object.values(state.bySession).some(matches)) {
          return state
        }

        return {
          bySession: Object.fromEntries(
            Object.entries(state.bySession).map(([id, transcript]) => [
              id,
              matches(transcript) ? retireAuthority(transcript, options) : transcript
            ])
          )
        }
      })
    },

    open(sessionId, sectionId, messages, throughRevision = Infinity, bot, options = {}) {
      droppedSessions.delete(sessionId)
      set(state => {
        const existing = state.bySession[sessionId]
        const newer = existing && existing.authorityRevision > throughRevision

        // A running-room snapshot identifies the session, but says nothing
        // about which human requests are still pending within that turn.
        const preserveWaiting =
          options.preserveWaiting &&
          existing?.sectionId === sectionId &&
          (!existing.bot || !bot || existing.bot === bot)

        // A live transcript that is ahead of the stored history (a message
        // just sent, a reply streaming) wins over the snapshot.
        if (
          existing &&
          (existing.streamingMessageId || existing.messages.length > messages.length)
        ) {
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...(newer ? existing : retireAuthority(existing, { preserveWaiting })),
                sectionId,
                bot: bot ?? existing.bot
              }
            }
          }
        }

        // Cards that arrived while the snapshot was loading (a replayed
        // question, an approval) outlive the swap. Settled questions are in
        // the snapshot's messages, where they were asked.
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              ...emptyTranscript(sessionId, sectionId),
              ...(existing ? { epoch: existing.epoch } : {}),
              bot: bot ?? existing?.bot,
              ...(preserveWaiting ? { waitingRequests: existing.waitingRequests } : {}),
              ...(newer
                ? {
                    authorityRevision: existing.authorityRevision,
                    answeredWaiting: existing.answeredWaiting,
                    liveStatus: existing.liveStatus,
                    waitingRequests: existing.waitingRequests,
                    retryResolved: existing.retryResolved
                  }
                : {}),
              approvals: existing?.approvals ?? [],
              approvalDecisions: existing?.approvalDecisions,
              clarifyAnswers: existing?.clarifyAnswers,
              settledClarifyIds: existing?.settledClarifyIds,
              clarifies: (existing?.clarifies ?? []).filter(
                item =>
                  clarifyWaiting(item) ||
                  (newer &&
                    existing.answeredWaiting?.kind === 'clarify' &&
                    existing.answeredWaiting.requestId === item.requestId)
              ),
              context: existing?.context ?? null,
              messages,
              status: existing?.status ?? null
            }
          }
        }
      })
    },

    setSectionId(sessionId, sectionId, bot) {
      update(sessionId, transcript => ({ ...transcript, sectionId, bot: bot ?? transcript.bot }))
    },

    drop(sessionId) {
      droppedSessions.add(sessionId)
      set(state => {
        const next = { ...state.bySession }
        delete next[sessionId]

        return { bySession: next }
      })
    },

    dropAll() {
      for (const sessionId of Object.keys(get().bySession)) {
        droppedSessions.add(sessionId)
      }

      set({ bySession: {}, warnings: {} })
    },

    appendUserMessage(sessionId, text, attachments = []) {
      const message: Message = {
        attachments,
        createdAt: Date.now(),
        id: nextMessageId('u'),
        role: 'user',
        streaming: false,
        text,
        toolCalls: []
      }

      update(sessionId, transcript => ({
        ...transcript,
        error: null,
        messages: [...transcript.messages, message]
      }))

      return message
    },

    messageStart(sessionId, retryResolved = false) {
      const message = newAssistantMessage()

      update(sessionId, transcript => ({
        ...advanceAuthority(transcript),
        waitingRequests: [],
        retryResolved: retryResolved || transcript.retryResolved,
        error: null,
        messages: [...transcript.messages, message],
        streamingMessageId: message.id,
        turnPrefix: undefined
      }))
    },

    messageDelta(sessionId, text) {
      if (!text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          activity: undefined,
          streaming: true,
          text: message.text + text
        }))
      )
    },

    messageInterim(sessionId, text, alreadyStreamed = false) {
      // Commentary the bot finished alongside tool calls: a message of its
      // own. When Hexbot already streamed it as deltas, it is closed as is.
      if (!alreadyStreamed && !text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message =>
          closePart({
            ...message,
            streaming: true,
            text: alreadyStreamed ? message.text : message.text + text
          })
        )
      )
    },

    reasoningDelta(sessionId, text) {
      if (!text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          streaming: true,
          thinking: (message.thinking ?? '') + text,
          workUntil: Date.now()
        }))
      )
    },

    thinkingDelta(sessionId, text) {
      // Hexbot's status line, not reasoning: it fires before and between API
      // calls, so it only annotates a message that is already streaming.
      const activity = SPINNER_LINE.test(text.trim()) ? '' : text.trim()

      update(sessionId, transcript => {
        const id = transcript.streamingMessageId

        return id
          ? replaceMessage(transcript, id, message => ({
              ...message,
              activity: activity || undefined
            }))
          : transcript
      })
    },

    toolStart(sessionId, payload) {
      const call: ToolCall = {
        args: payload.args ?? payload.args_text ?? null,
        durationS: null,
        name: String(payload.name ?? 'tool'),
        result: null,
        startedAt: Date.now(),
        status: 'running',
        ...(payload.parent_tool_call_id && { parentToolCallId: payload.parent_tool_call_id }),
        summary: payload.context,
        toolId: String(payload.tool_id ?? nextMessageId('t'))
      }

      update(sessionId, transcript => {
        const parent =
          payload.parent_tool_call_id &&
          transcript.messages.find(message =>
            message.toolCalls.some(tool => tool.toolId === payload.parent_tool_call_id)
          )

        const append = (message: TranscriptMessage) => ({
          ...closePart(message),
          toolCalls: [...message.toolCalls, call]
        })

        return parent
          ? replaceMessage(transcript, parent.id, append)
          : withCurrentAssistant(transcript, append)
      })
    },

    toolComplete(sessionId, payload) {
      const toolId = payload.tool_id === undefined ? null : String(payload.tool_id)
      const result = payload.result ?? payload.result_text ?? null

      const failed =
        typeof result === 'object' &&
        result !== null &&
        'error' in (result as Record<string, unknown>)

      update(sessionId, transcript => {
        const index = toolId
          ? transcript.messages.findLastIndex(message =>
              message.toolCalls.some(call => call.toolId === toolId)
            )
          : -1

        if (index >= 0) {
          const target = transcript.messages[index]

          if (!target) {
            return transcript
          }

          return replaceMessage(transcript, target.id, message => ({
            ...message,
            toolCalls: message.toolCalls.map(call =>
              call.toolId === toolId
                ? {
                    ...call,
                    args: payload.args ?? call.args,
                    durationS: payload.duration_s ?? call.durationS,
                    result,
                    status: failed ? 'error' : 'ok',
                    summary: payload.summary ?? call.summary
                  }
                : call
            ),
            workUntil: Date.now()
          }))
        }

        // A completion without a matching start (reconnect mid-tool): render
        // it as a finished call rather than dropping it.
        return withCurrentAssistant(transcript, message => ({
          ...message,
          toolCalls: [
            ...message.toolCalls,
            {
              args: payload.args ?? null,
              durationS: payload.duration_s ?? null,
              name: String(payload.name ?? 'tool'),
              result,
              startedAt: Date.now(),
              status: failed ? 'error' : 'ok',
              summary: payload.summary,
              toolId: toolId ?? nextMessageId('t')
            }
          ],
          workUntil: Date.now()
        }))
      })
    },

    messageComplete(sessionId, payload = {}) {
      let sectionId: string | undefined

      update(sessionId, transcript => {
        sectionId = transcript.sectionId
        transcript = {
          ...advanceAuthority(transcript),
          waitingRequests: [],
          retryResolved:
            payload.error || payload.status === 'error' ? undefined : transcript.retryResolved,
          liveStatus: payload.error || payload.status === 'error' ? undefined : 'idle'
        }
        const prefix = transcript.turnPrefix ?? ''

        const finalText =
          payload.text && prefix && payload.text.startsWith(prefix)
            ? payload.text.slice(prefix.length).trimStart()
            : payload.text

        if (!transcript.streamingMessageId && prefix && !finalText && !payload.error) {
          // The turn ended right after the card: the closed bubble already holds it all.
          return { ...transcript, turnPrefix: undefined, usage: payload.usage ?? transcript.usage }
        }

        const finalize = (message: Message): Message => ({
          ...settle(message, finalText),
          activity: undefined,
          error: payload.error ?? message.error,
          status: payload.status,
          streaming: false,
          toolCalls: message.toolCalls.map(call =>
            call.status === 'running' ? { ...call, status: 'ok' } : call
          ),
          usage: payload.usage ?? message.usage ?? null,
          workUntil: message.toolCalls.some(call => call.status === 'running')
            ? Date.now()
            : message.workUntil
        })

        const next = withCurrentAssistant(transcript, finalize)

        return {
          ...next,
          turnPrefix: undefined,
          error: payload.error ?? null,
          status: null,
          streamingMessageId: null,
          usage: payload.usage ?? next.usage
        }
      })

      if (sectionId) {
        effects.touchSection(sectionId)
      }
    },

    approvalRequest(sessionId, payload, options = {}) {
      droppedSessions.delete(sessionId)
      const requestId = String(payload.request_id ?? nextMessageId('ap'))

      const approval: ApprovalRequest = {
        choices: payload.choices ?? ['once', 'deny'],
        command: payload.command,
        reason: payload.reason,
        receivedAt: Date.now(),
        requestId,
        sessionId,
        toolName: payload.tool
      }

      approval.decision = get().bySession[sessionId]?.approvalDecisions?.[requestId]

      let added = false

      update(sessionId, transcript => {
        const existing = transcript.approvals.find(item => item.requestId === requestId)

        if (existing) {
          return existing.decision
            ? transcript
            : {
                ...advanceAuthority(transcript),
                liveStatus: transcript.liveStatus,
                waitingRequests: [
                  ...(transcript.waitingRequests ?? []).filter(
                    item => item.kind !== 'approval' || item.requestId !== requestId
                  ),
                  { kind: 'approval', requestId, revision: authorityRevision }
                ]
              }
        }

        added = true

        return {
          ...(approval.decision ? transcript : advanceAuthority(closeForCard(transcript))),
          liveStatus: transcript.liveStatus,
          waitingRequests: approval.decision
            ? transcript.waitingRequests
            : [
                ...(transcript.waitingRequests ?? []),
                { kind: 'approval', requestId, revision: authorityRevision }
              ],
          approvals: [...transcript.approvals, approval]
        }
      })

      const transcript = get().bySession[sessionId]

      effects.ackApproval(sessionId, requestId)

      if (!added || approval.decision || options.notify === false) {
        return
      }

      effects.notify({
        body: payload.command ?? payload.reason ?? 'A bot is asking for permission.',
        sectionId: transcript?.sectionId,
        title: 'Approval needed'
      })
    },

    clarifyRequest(sessionId, payload, options = {}) {
      droppedSessions.delete(sessionId)
      const requestId = String(payload.request_id ?? nextMessageId('cl'))

      const questions = clarifyQuestions(payload)

      let added = false

      update(sessionId, transcript => {
        if (transcript.settledClarifyIds?.includes(requestId)) {
          return transcript
        }

        const existing = transcript.clarifies.find(item => item.requestId === requestId)

        if (existing) {
          if (!options.confirmPending) {
            return !clarifyWaiting(existing)
              ? transcript
              : {
                  ...advanceAuthority(transcript),
                  liveStatus: transcript.liveStatus,
                  waitingRequests: [
                    ...(transcript.waitingRequests ?? []).filter(
                      item => item.kind !== 'clarify' || item.requestId !== requestId
                    ),
                    { kind: 'clarify', requestId, revision: authorityRevision }
                  ]
                }
          }

          const current = {
            ...existing,
            answers: {
              ...payload.answers,
              ...existing.answers,
              ...transcript.clarifyAnswers?.[requestId]
            }
          }

          const waiting = clarifyWaiting(current)

          return {
            ...(waiting ? advanceAuthority(transcript) : transcript),
            waitingRequests: waiting
              ? [
                  ...(transcript.waitingRequests ?? []).filter(
                    item => item.kind !== 'clarify' || item.requestId !== requestId
                  ),
                  { kind: 'clarify', requestId, revision: authorityRevision }
                ]
              : transcript.waitingRequests?.filter(
                  item => item.kind !== 'clarify' || item.requestId !== requestId
                ),
            liveStatus: transcript.liveStatus,
            answeredWaiting: waiting ? undefined : transcript.answeredWaiting,
            settledClarifyIds: waiting
              ? transcript.settledClarifyIds
              : [...new Set([...(transcript.settledClarifyIds ?? []), requestId])],
            clarifies: transcript.clarifies.map(item => (item === existing ? current : item))
          }
        }

        added = true

        const clarify: ClarifyRequest = {
          answers: { ...payload.answers, ...transcript.clarifyAnswers?.[requestId] },
          questions,
          receivedAt: Date.now(),
          requestId,
          sessionId
        }

        const waiting = clarifyWaiting(clarify)

        return {
          ...(waiting ? advanceAuthority(closeForCard(transcript)) : transcript),
          waitingRequests: waiting
            ? [
                ...(transcript.waitingRequests ?? []),
                { kind: 'clarify', requestId, revision: authorityRevision }
              ]
            : transcript.waitingRequests?.filter(
                item => item.kind !== 'clarify' || item.requestId !== requestId
              ),
          liveStatus: transcript.liveStatus,
          answeredWaiting: waiting ? undefined : transcript.answeredWaiting,
          settledClarifyIds: waiting
            ? transcript.settledClarifyIds
            : [...new Set([...(transcript.settledClarifyIds ?? []), requestId])],
          clarifies: [...transcript.clarifies, clarify]
        }
      })

      if (!added || options.notify === false) {
        return
      }

      effects.notify({
        body: questions[0]?.question ?? 'A bot has a question for you.',
        sectionId: get().bySession[sessionId]?.sectionId,
        title: 'Needs you'
      })
    },

    approvalResolved(sessionId, payload, attempt) {
      if (droppedSessions.has(sessionId)) {
        return
      }

      update(sessionId, transcript => {
        if (attempt && attempt.epoch !== transcript.epoch) {
          return transcript
        }

        const requestId = payload.request_id
        const choice = transcript.approvalDecisions?.[requestId] ?? payload.choice
        const card = transcript.approvals.find(item => item.requestId === requestId)

        const confirmed = transcript.waitingRequests?.some(
          item => item.kind === 'approval' && item.requestId === requestId
        )

        const answered =
          card &&
          !card.decision &&
          confirmed &&
          (!attempt ||
            attempt.revision === transcript.authorityRevision ||
            confirmedReplay(transcript, 'approval', requestId))

        if (
          transcript.approvalDecisions?.[requestId] === choice &&
          (!card || card.decision === choice)
        ) {
          return transcript
        }

        return {
          ...transcript,
          authorityRevision: answered ? ++authorityRevision : transcript.authorityRevision,
          approvalDecisions: { ...transcript.approvalDecisions, [requestId]: choice },
          liveStatus:
            answered && transcript.liveStatus !== 'working' ? undefined : transcript.liveStatus,
          answeredWaiting: answered ? { kind: 'approval', requestId } : transcript.answeredWaiting,
          waitingRequests: transcript.waitingRequests?.filter(
            item => item.kind !== 'approval' || item.requestId !== requestId
          ),
          approvals: transcript.approvals.map(item =>
            item === card ? { ...item, decision: choice } : item
          )
        }
      })
    },

    clarifyResolved(sessionId, payload, attempt) {
      if (droppedSessions.has(sessionId)) {
        return
      }

      update(sessionId, transcript => {
        if (attempt && attempt.epoch !== transcript.epoch) {
          return transcript
        }

        const requestId = payload.request_id
        const saved = transcript.clarifyAnswers?.[requestId] ?? {}
        const answers = { ...payload.answers, ...saved }
        const card = transcript.clarifies.find(item => item.requestId === requestId)
        const updated = card && { ...card, answers: { ...card.answers, ...answers } }
        const settled = payload.status === 'answered' && (!updated || clarifyAnswered(updated))

        const confirmed = transcript.waitingRequests?.some(
          item => item.kind === 'clarify' && item.requestId === requestId
        )

        const changed =
          !sameAnswers(saved, answers) ||
          (settled && !transcript.settledClarifyIds?.includes(requestId))

        const answered =
          settled &&
          card &&
          clarifyWaiting(card) &&
          confirmed &&
          (!attempt ||
            attempt.revision === transcript.authorityRevision ||
            confirmedReplay(transcript, 'clarify', requestId))

        if (!changed) {
          return transcript
        }

        const revision = confirmed ? ++authorityRevision : transcript.authorityRevision

        return {
          ...transcript,
          authorityRevision: revision,
          clarifyAnswers: { ...transcript.clarifyAnswers, [requestId]: answers },
          liveStatus:
            answered && transcript.liveStatus !== 'working' ? undefined : transcript.liveStatus,
          answeredWaiting: answered ? { kind: 'clarify', requestId } : transcript.answeredWaiting,
          settledClarifyIds: settled
            ? [...new Set([...(transcript.settledClarifyIds ?? []), requestId])]
            : transcript.settledClarifyIds,
          waitingRequests: settled
            ? transcript.waitingRequests?.filter(
                item => item.kind !== 'clarify' || item.requestId !== requestId
              )
            : transcript.waitingRequests?.map(item =>
                item.kind === 'clarify' && item.requestId === requestId
                  ? { ...item, revision }
                  : item
              ),
          clarifies: transcript.clarifies.map(item => (item === card ? updated! : item))
        }
      })
    },

    async respondApproval(sessionId, requestId, choice) {
      const before = get().bySession[sessionId]
      const attempt = before && { epoch: before.epoch, revision: before.authorityRevision }
      const result = await approvalRespond(sessionId, requestId, choice)

      if (result.resolved && attempt && get().bySession[sessionId]) {
        if (result.choice) {
          get().approvalResolved(
            sessionId,
            { request_id: requestId, choice: result.choice },
            attempt
          )
        } else {
          get().resolveApproval(sessionId, requestId, choice, attempt)
        }
      }
    },

    async respondClarify(sessionId, requestId, answer, questionId) {
      const before = get().bySession[sessionId]
      const attempt = before && { epoch: before.epoch, revision: before.authorityRevision }
      const result = await clarifyRespond(sessionId, requestId, answer, questionId)

      if (attempt && get().bySession[sessionId]) {
        if (result.answers && (result.status === 'answered' || result.status === 'waiting')) {
          get().clarifyResolved(
            sessionId,
            { request_id: requestId, answers: result.answers, status: result.status },
            attempt
          )
        } else {
          get().answerClarify(sessionId, requestId, questionId ?? requestId, answer, {
            ...attempt,
            answered: result.status === 'answered'
          })
        }
      }
    },

    answerClarify(sessionId, requestId, questionId, answer, attempt) {
      update(sessionId, transcript => {
        if (attempt && attempt.epoch !== transcript.epoch) {
          return transcript
        }

        const canonical = transcript.clarifyAnswers?.[requestId]

        const clarifies = transcript.clarifies.map(item =>
          item.requestId === requestId
            ? {
                ...item,
                answers: {
                  ...item.answers,
                  [questionId]:
                    canonical && Object.hasOwn(canonical, questionId)
                      ? canonical[questionId]!
                      : answer
                }
              }
            : item
        )

        const wasWaiting = transcript.clarifies.some(
          item => item.requestId === requestId && clarifyWaiting(item)
        )

        const current =
          !attempt ||
          (attempt.revision === transcript.authorityRevision && attempt.answered !== false)

        const settled =
          attempt?.answered !== false &&
          wasWaiting &&
          clarifies.some(
            item => item.requestId === requestId && !item.expired && clarifyAnswered(item)
          )

        const answered = settled && (current || confirmedReplay(transcript, 'clarify', requestId))

        return {
          ...transcript,
          authorityRevision: answered ? ++authorityRevision : transcript.authorityRevision,
          liveStatus:
            answered && transcript.liveStatus !== 'working' ? undefined : transcript.liveStatus,
          answeredWaiting: answered ? { kind: 'clarify', requestId } : transcript.answeredWaiting,
          settledClarifyIds: settled
            ? [...new Set([...(transcript.settledClarifyIds ?? []), requestId])]
            : transcript.settledClarifyIds,
          waitingRequests: settled
            ? transcript.waitingRequests?.filter(
                item => item.kind !== 'clarify' || item.requestId !== requestId
              )
            : transcript.waitingRequests,
          clarifies
        }
      })
    },

    clarifyExpire(sessionId, requestId, options = {}) {
      update(sessionId, transcript => ({
        ...advanceAuthority(transcript),
        ...(options.preserveEvidence
          ? { liveStatus: transcript.liveStatus, answeredWaiting: transcript.answeredWaiting }
          : {}),
        settledClarifyIds: [...new Set([...(transcript.settledClarifyIds ?? []), requestId])],
        waitingRequests: transcript.waitingRequests?.filter(
          item => item.kind !== 'clarify' || item.requestId !== requestId
        ),
        clarifies: transcript.clarifies.map(item =>
          item.requestId === requestId ? { ...item, expired: true } : item
        )
      }))
    },

    resolveApproval(sessionId, requestId, choice, attempt) {
      update(sessionId, transcript => {
        if (attempt && attempt.epoch !== transcript.epoch) {
          return transcript
        }

        const current = !attempt || attempt.revision === transcript.authorityRevision

        const waiting = transcript.approvals.some(
          approval => approval.requestId === requestId && !approval.decision
        )

        const answered = waiting && (current || confirmedReplay(transcript, 'approval', requestId))

        return {
          ...transcript,
          authorityRevision: answered ? ++authorityRevision : transcript.authorityRevision,
          liveStatus:
            answered && transcript.liveStatus !== 'working' ? undefined : transcript.liveStatus,
          answeredWaiting: answered ? { kind: 'approval', requestId } : transcript.answeredWaiting,
          waitingRequests: transcript.waitingRequests?.filter(
            item => item.kind !== 'approval' || item.requestId !== requestId
          ),
          approvals: transcript.approvals.map(approval =>
            approval.requestId === requestId && !approval.decision
              ? { ...approval, decision: choice }
              : approval
          )
        }
      })
    },

    statusUpdate(sessionId, status) {
      // Status text is informational; provider retry keeps an already confirmed Working state.
      update(sessionId, transcript =>
        status.kind === 'status'
          ? { ...transcript, status }
          : {
              ...advanceAuthority(transcript),
              waitingRequests: status.kind === 'idle' ? [] : transcript.waitingRequests,
              liveStatus:
                status.kind === 'working' || status.kind === 'idle'
                  ? status.kind
                  : status.kind === 'waiting' && transcript.liveStatus === 'working'
                    ? 'working'
                    : undefined,
              status
            }
      )
    },

    sessionInfo(sessionId, info) {
      update(sessionId, transcript => ({ ...transcript, info }))
    },

    sessionUsage(sessionId, usage) {
      update(sessionId, transcript => ({ ...transcript, usage }))
    },

    sessionContext(sessionId, context) {
      update(sessionId, transcript => {
        // The daemon measures each report in its own task; one that finished
        // late must not overwrite a newer one.
        const held = transcript.context?.seq

        if (held != null && context.seq != null && context.seq < held) {
          return transcript
        }

        return { ...transcript, context }
      })
    },

    errorEvent(sessionId, message, detail) {
      update(sessionId, transcript => {
        const existing = detail?.incidentId
          ? transcript.messages.findIndex(
              item => item.errorDetail?.incidentId === detail.incidentId
            )
          : -1

        const messages = transcript.messages.map(item =>
          item.id === transcript.streamingMessageId ? { ...item, streaming: false } : item
        )

        if (existing >= 0) {
          messages[existing] = { ...messages[existing]!, error: message, errorDetail: detail }
        } else {
          messages.push({
            attachments: [],
            createdAt: Date.now(),
            error: message,
            ...(detail ? { errorDetail: detail } : {}),
            id: nextMessageId('e'),
            role: 'system' as const,
            streaming: false,
            text: '',
            toolCalls: []
          })
        }

        return {
          ...retireAuthority(transcript),
          error: message,
          messages,
          streamingMessageId: null
        }
      })
    },

    incidentEvent(sessionId, message, detail) {
      update(sessionId, transcript => {
        transcript = {
          ...transcript,
          retryResolved: undefined,
          authorityRevision: ++authorityRevision
        }

        const existing = detail.incidentId
          ? transcript.messages.findIndex(
              item => item.errorDetail?.incidentId === detail.incidentId
            )
          : -1

        const messages = [...transcript.messages]

        if (existing >= 0) {
          messages[existing] = { ...messages[existing]!, error: message, errorDetail: detail }

          return { ...transcript, messages }
        }

        // The gateway's own `error` event usually lands first for the same
        // failure; the incident then adds its detail to that card instead of
        // drawing a second one.
        const recent = messages.findLastIndex(
          item =>
            Boolean(item.error) &&
            !item.errorDetail?.incidentId &&
            Date.now() - toMillis(item.createdAt) < INCIDENT_MERGE_MS
        )

        if (recent >= 0) {
          messages[recent] = { ...messages[recent]!, error: message, errorDetail: detail }

          return { ...transcript, error: message, messages }
        }

        const card: TranscriptMessage = {
          attachments: [],
          createdAt: Date.now(),
          error: message,
          errorDetail: detail,
          id: nextMessageId('e'),
          role: 'system',
          streaming: false,
          text: '',
          toolCalls: []
        }

        const streamingAt = transcript.streamingMessageId
          ? messages.findIndex(item => item.id === transcript.streamingMessageId)
          : -1

        if (streamingAt >= 0) {
          messages.splice(streamingAt, 0, card)
        } else {
          messages.push(card)
        }

        return { ...transcript, messages }
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectTranscript(sessionId: null | string) {
  return (state: TranscriptsState): Transcript | undefined =>
    sessionId ? state.bySession[sessionId] : undefined
}

export function useTranscript(sessionId: null | string): Transcript | undefined {
  return useTranscripts(selectTranscript(sessionId))
}

export function transcriptActions(): TranscriptsState {
  return useTranscripts.getState()
}
