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
  clarifyAnswered,
  clarifyQuestions,
  newInputId,
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

import { hydrateHistory } from './transcript-history'

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

export interface Transcript {
  /** Identity supplied on the current event, separate from UI bubble identity. */
  identity?: { turnId?: string; messageId?: string }
  /** The current run, independent of a late event from an earlier run. */
  activeTurnId?: string
  /** Completed source fragments in the last authoritative snapshot. */
  durableFragments?: string[]
  approvals: ApprovalRequest[]
  /**
   * "Checking this step" while Auto mode reviews a step. It belongs to the
   * turn, not one message: a card can end the bubble that showed it while
   * another review still runs, so each new bubble takes it over.
   */
  checking?: string
  /** Questions the bot asked through the clarify tool, oldest first. */
  clarifies: ClarifyRequest[]
  /** The context meter; null until the daemon has reported it. */
  context: null | ContextUsage
  /** Inline error rows are also pushed as messages; this is the header copy. */
  error: null | string
  info: null | SessionInfo
  messages: TranscriptMessage[]
  /** The section this live session belongs to, when known. */
  sectionId?: string
  sessionId: string
  status: null | StatusLine
  /** Id of the assistant message currently receiving deltas. */
  streamingMessageId: null | string
  /** Remains active when a card closes the current bubble. */
  turnActive?: boolean
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
  message_id?: string
  turn_id?: string
  choices?: ApprovalChoice[]
  command?: string
  reason?: string
  request_id?: string
  tool?: string
}

export interface TranscriptsState {
  eventIdentity: (sessionId: string, identity: { turnId?: string; messageId?: string }) => void
  setInputId: (sessionId: string, messageId: string, inputId: string) => void
  answerClarify: (sessionId: string, requestId: string, questionId: string, answer: string) => void
  approvalRequest: (
    sessionId: string,
    payload: ApprovalRequestPayload,
    options?: { notify?: boolean }
  ) => void
  clarifyExpire: (sessionId: string, requestId: string) => void
  clarifyRequest: (
    sessionId: string,
    payload: ClarifyRequestPayload & { answers?: Record<string, string> },
    options?: { notify?: boolean }
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
  messageStart: (sessionId: string) => void
  open: (
    sessionId: string,
    sectionId: string,
    messages: Message[],
    hydration?: { reports: string[] }
  ) => void
  reasoningDelta: (sessionId: string, text: string) => void
  resolveApproval: (sessionId: string, requestId: string, choice: ApprovalChoice) => void
  sessionContext: (sessionId: string, context: ContextUsage) => void
  sessionInfo: (sessionId: string, info: SessionInfo) => void
  sessionUsage: (sessionId: string, usage: Usage) => void
  setSectionId: (sessionId: string, sectionId: string) => void
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

export function emptyTranscript(sessionId: string, sectionId?: string): Transcript {
  return {
    approvals: [],
    clarifies: [],
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

function newAssistantMessage(checking?: string): Message {
  return {
    attachments: [],
    ...(checking && { checking }),
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

/**
 * Ends the message the bot is writing: its words become a finished part, and
 * whatever it writes next starts a new bubble.
 */
function closePart(message: Message): Message {
  return message.text.trim()
    ? {
        ...message,
        parts: [...(message.parts ?? []), message.text],
        partIds: [...(message.partIds ?? []), message.textId],
        text: '',
        textId: undefined
      }
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

  const lastId = message.partIds?.at(-1)

  return last !== undefined &&
    (!message.textId || message.textId === lastId) &&
    (!text.trim() || text.trim() === last.trim())
    ? {
        ...message,
        parts: message.parts?.slice(0, -1),
        partIds: message.partIds?.slice(0, -1),
        textId: lastId,
        text: last
      }
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
    return replaceMessage(transcript, current.id, message =>
      patch(identifyMessage(message, transcript.identity))
    )
  }

  const created = patch(
    identifyMessage(newAssistantMessage(transcript.checking), transcript.identity)
  )

  return {
    ...transcript,
    messages: [...transcript.messages, created],
    streamingMessageId: created.id,
    turnActive: true,
    activeTurnId: transcript.identity?.turnId ?? transcript.activeTurnId
  }
}

function identifyMessage(message: Message, identity: Transcript['identity']): Message {
  const id = identity?.messageId

  return {
    ...message,
    ...(identity?.turnId && { turnId: identity.turnId }),
    ...(id && { fragmentIds: [...new Set([...(message.fragmentIds ?? []), id])] })
  }
}

function textIdentity(message: Message, id: string | undefined): Message {
  const next =
    message.text && message.textId !== id && (message.textId || id) ? closePart(message) : message

  return { ...next, textId: id }
}

export const useTranscripts = create<TranscriptsState>((set, get) => {
  const update = (sessionId: string, patch: (transcript: Transcript) => Transcript): void => {
    set(state => {
      const current = state.bySession[sessionId] ?? emptyTranscript(sessionId)

      return { bySession: { ...state.bySession, [sessionId]: patch(current) } }
    })
  }

  return {
    eventIdentity(sessionId, identity) {
      const previous = get().bySession[sessionId]?.identity

      if (previous?.turnId === identity.turnId && previous?.messageId === identity.messageId) {
        return
      }

      update(sessionId, transcript => ({ ...transcript, identity }))
    },
    setInputId(sessionId, messageId, inputId) {
      update(sessionId, transcript =>
        replaceMessage(transcript, messageId, message => ({ ...message, inputId }))
      )
    },
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

    open(sessionId, sectionId, messages, hydration) {
      set(state => {
        const existing = state.bySession[sessionId]

        if (existing && hydration) {
          const restored = hydrateHistory(existing, messages)

          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...existing,
                ...restored,
                sectionId,
                clarifies: existing.clarifies.filter(clarifyWaiting)
              }
            }
          }
        }

        // A live transcript that is ahead of the stored history (a message
        // just sent, a reply streaming) wins over the snapshot.
        if (
          existing &&
          (existing.streamingMessageId || existing.messages.length > messages.length)
        ) {
          return { bySession: { ...state.bySession, [sessionId]: { ...existing, sectionId } } }
        }

        // Cards that arrived while the snapshot was loading (a replayed
        // question, an approval) outlive the swap. Settled questions are in
        // the snapshot's messages, where they were asked.
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: {
              ...emptyTranscript(sessionId, sectionId),
              approvals: existing?.approvals ?? [],
              clarifies: (existing?.clarifies ?? []).filter(clarifyWaiting),
              context: existing?.context ?? null,
              messages,
              status: existing?.status ?? null
            }
          }
        }
      })
    },

    setSectionId(sessionId, sectionId) {
      update(sessionId, transcript => ({ ...transcript, sectionId }))
    },

    drop(sessionId) {
      set(state => {
        const next = { ...state.bySession }
        delete next[sessionId]

        return { bySession: next }
      })
    },

    dropAll() {
      set({ bySession: {}, warnings: {} })
    },

    appendUserMessage(sessionId, text, attachments = []) {
      const message: Message = {
        attachments,
        createdAt: Date.now(),
        id: nextMessageId('u'),
        inputId: newInputId(),
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

    messageStart(sessionId) {
      update(sessionId, transcript => {
        const message = identifyMessage(
          newAssistantMessage(transcript.checking),
          transcript.identity
        )

        return {
          ...transcript,
          error: null,
          messages: [
            ...transcript.messages.map(previous =>
              previous.id === transcript.streamingMessageId
                ? settle({ ...previous, streaming: false })
                : previous
            ),
            message
          ],
          streamingMessageId: message.id,
          turnActive: true,
          activeTurnId: transcript.identity?.turnId,
          turnPrefix: undefined
        }
      })
    },

    messageDelta(sessionId, text) {
      if (!text) {
        return
      }

      update(sessionId, transcript => {
        if (
          transcript.identity?.messageId &&
          transcript.durableFragments?.includes(transcript.identity.messageId)
        ) {
          return transcript
        }

        return withCurrentAssistant(transcript, message => {
          const next = textIdentity(message, transcript.identity?.messageId)

          return { ...next, activity: undefined, streaming: true, text: next.text + text }
        })
      })
    },

    messageInterim(sessionId, text, alreadyStreamed = false) {
      // Commentary the bot finished alongside tool calls: a message of its
      // own. When Hexbot already streamed it as deltas, it is closed as is.
      if (!alreadyStreamed && !text) {
        return
      }

      update(sessionId, transcript => {
        if (
          transcript.identity?.messageId &&
          transcript.durableFragments?.includes(transcript.identity.messageId)
        ) {
          return transcript
        }

        return withCurrentAssistant(transcript, message => {
          const next = textIdentity(message, transcript.identity?.messageId)

          return closePart({
            ...next,
            streaming: true,
            text: alreadyStreamed ? next.text : next.text + text
          })
        })
      })
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
          thinkingId: transcript.identity?.messageId ?? message.thinkingId,
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
        messageId: get().bySession[sessionId]?.identity?.messageId,
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
        const prefix = transcript.turnPrefix ?? ''

        const finalText =
          payload.text && prefix && payload.text.startsWith(prefix)
            ? payload.text.slice(prefix.length).trimStart()
            : payload.text

        if (!transcript.streamingMessageId && prefix && !finalText && !payload.error) {
          // The turn ended right after the card: the closed bubble already holds it all.
          return {
            ...transcript,
            turnActive: false,
            turnPrefix: undefined,
            usage: payload.usage ?? transcript.usage
          }
        }

        const finalize = (message: Message): Message => ({
          ...settle(
            finalText ? textIdentity(message, transcript.identity?.messageId) : message,
            finalText
          ),
          activity: undefined,
          checking: undefined,
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

        // The turn is over, so no review is left; the daemon's clear may be lost.
        return {
          ...next,
          checking: undefined,
          turnPrefix: undefined,
          error: payload.error ?? null,
          status: null,
          streamingMessageId: null,
          turnActive: false,
          usage: payload.usage ?? next.usage
        }
      })

      if (sectionId) {
        effects.touchSection(sectionId)
      }
    },

    approvalRequest(sessionId, payload, options = {}) {
      const requestId = String(payload.request_id ?? nextMessageId('ap'))

      const approval: ApprovalRequest = {
        messageId: payload.message_id,
        turnId: payload.turn_id,
        choices: payload.choices ?? ['once', 'deny'],
        command: payload.command,
        reason: payload.reason,
        receivedAt: Date.now(),
        requestId,
        sessionId,
        toolName: payload.tool
      }

      let added = false

      update(sessionId, transcript => {
        if (transcript.approvals.some(item => item.requestId === requestId)) {
          return transcript
        }

        added = true

        return { ...closeForCard(transcript), approvals: [...transcript.approvals, approval] }
      })

      const transcript = get().bySession[sessionId]

      effects.ackApproval(sessionId, requestId)

      if (!added || options.notify === false) {
        return
      }

      effects.notify({
        body: payload.command ?? payload.reason ?? 'A bot is asking for permission.',
        sectionId: transcript?.sectionId,
        title: 'Approval needed'
      })
    },

    clarifyRequest(sessionId, payload, options = {}) {
      const requestId = String(payload.request_id ?? nextMessageId('cl'))

      const questions = clarifyQuestions(payload)

      let added = false

      update(sessionId, transcript => {
        if (transcript.clarifies.some(item => item.requestId === requestId)) {
          return transcript
        }

        added = true

        const clarify: ClarifyRequest = {
          messageId: payload.message_id,
          turnId: payload.turn_id,
          answers: payload.answers ?? {},
          questions,
          receivedAt: Date.now(),
          requestId,
          sessionId
        }

        return { ...closeForCard(transcript), clarifies: [...transcript.clarifies, clarify] }
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

    answerClarify(sessionId, requestId, questionId, answer) {
      update(sessionId, transcript => ({
        ...transcript,
        clarifies: transcript.clarifies.map(item =>
          item.requestId === requestId
            ? { ...item, answers: { ...item.answers, [questionId]: answer } }
            : item
        )
      }))
    },

    clarifyExpire(sessionId, requestId) {
      update(sessionId, transcript => ({
        ...transcript,
        clarifies: transcript.clarifies.map(item =>
          item.requestId === requestId ? { ...item, expired: true } : item
        )
      }))
    },

    resolveApproval(sessionId, requestId, choice) {
      update(sessionId, transcript => ({
        ...transcript,
        approvals: transcript.approvals.map(approval =>
          approval.requestId === requestId ? { ...approval, decision: choice } : approval
        )
      }))
    },

    statusUpdate(sessionId, status) {
      update(sessionId, transcript => {
        if (status.kind !== 'checking') {
          return { ...transcript, status }
        }

        // Only the daemon's own clear, an empty `checking` line, ends the
        // label; it goes once the last overlapping review ends. Until then
        // the bubble streaming now shows it, and so does every later one.
        const checking = status.text || undefined
        const id = transcript.streamingMessageId

        const next: Transcript = checking
          ? {
              ...(id
                ? replaceMessage(transcript, id, message => ({ ...message, checking }))
                : transcript),
              checking
            }
          : {
              ...transcript,
              checking: undefined,
              messages: transcript.messages.map(message =>
                message.checking ? { ...message, checking: undefined } : message
              )
            }

        return checking || transcript.status?.kind === 'checking' ? { ...next, status } : next
      })
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
          ...transcript,
          error: message,
          messages,
          streamingMessageId: null,
          turnActive: false,
          turnPrefix: undefined
        }
      })
    },

    incidentEvent(sessionId, message, detail) {
      update(sessionId, transcript => {
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
