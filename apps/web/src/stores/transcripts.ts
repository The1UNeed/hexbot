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

import { approvalReceived, nextMessageId, sectionsTouch } from '../lib/api'
import { getBridge } from '../lib/bridge'
import type {
  ApprovalChoice,
  ApprovalRequest,
  Attachment,
  Message,
  SessionInfo,
  StatusLine,
  ToolCall,
  Usage
} from '../lib/types'

export interface Transcript {
  approvals: ApprovalRequest[]
  /** Inline error rows are also pushed as messages; this is the header copy. */
  error: null | string
  info: null | SessionInfo
  messages: Message[]
  /** The section this live session belongs to, when known. */
  sectionId?: string
  sessionId: string
  status: null | StatusLine
  /** Id of the assistant message currently receiving deltas. */
  streamingMessageId: null | string
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
  args?: unknown
  args_text?: string
  context?: string
  name?: string
  tool_id?: string
}

export interface ToolCompletePayload {
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
  smart_denied?: boolean
  tool?: string
}

export interface TranscriptsState {
  approvalRequest: (sessionId: string, payload: ApprovalRequestPayload) => void
  appendUserMessage: (sessionId: string, text: string, attachments?: Attachment[]) => Message
  bySession: Record<string, Transcript>
  drop: (sessionId: string) => void
  dropAll: () => void
  errorEvent: (sessionId: string, message: string) => void
  messageComplete: (sessionId: string, payload?: MessageCompletePayload) => void
  messageDelta: (sessionId: string, text: string) => void
  messageInterim: (sessionId: string, text: string, alreadyStreamed?: boolean) => void
  messageStart: (sessionId: string) => void
  open: (sessionId: string, sectionId: string, messages: Message[]) => void
  resolveApproval: (sessionId: string, requestId: string, choice: ApprovalChoice) => void
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
 * The assistant message deltas and tool calls attach to. Hermes can emit a
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
    bySession: {},

    open(sessionId, sectionId, messages) {
      set(state => {
        const existing = state.bySession[sessionId]

        // A live transcript that is ahead of the stored history (a message
        // just sent, a reply streaming) wins over the snapshot.
        if (
          existing &&
          (existing.streamingMessageId || existing.messages.length > messages.length)
        ) {
          return { bySession: { ...state.bySession, [sessionId]: { ...existing, sectionId } } }
        }

        return {
          bySession: {
            ...state.bySession,
            [sessionId]: { ...emptyTranscript(sessionId, sectionId), messages }
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
      set({ bySession: {} })
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

    messageStart(sessionId) {
      const message = newAssistantMessage()

      update(sessionId, transcript => ({
        ...transcript,
        error: null,
        messages: [...transcript.messages, message],
        streamingMessageId: message.id
      }))
    },

    messageDelta(sessionId, text) {
      if (!text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          streaming: true,
          text: message.text + text
        }))
      )
    },

    messageInterim(sessionId, text, alreadyStreamed = false) {
      // Commentary emitted alongside tool calls. When Hermes already streamed
      // it as deltas, appending again would duplicate the text.
      if (alreadyStreamed || !text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          streaming: true,
          text: message.text + text
        }))
      )
    },

    thinkingDelta(sessionId, text) {
      if (!text) {
        return
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          streaming: true,
          thinking: (message.thinking ?? '') + text
        }))
      )
    },

    toolStart(sessionId, payload) {
      const call: ToolCall = {
        args: payload.args ?? payload.args_text ?? null,
        durationS: null,
        name: String(payload.name ?? 'tool'),
        result: null,
        startedAt: Date.now(),
        status: 'running',
        summary: payload.context,
        toolId: String(payload.tool_id ?? nextMessageId('t'))
      }

      update(sessionId, transcript =>
        withCurrentAssistant(transcript, message => ({
          ...message,
          toolCalls: [...message.toolCalls, call]
        }))
      )
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
            )
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
          ]
        }))
      })
    },

    messageComplete(sessionId, payload = {}) {
      let sectionId: string | undefined

      update(sessionId, transcript => {
        sectionId = transcript.sectionId

        const finalize = (message: Message): Message => ({
          ...message,
          error: payload.error ?? message.error,
          status: payload.status,
          streaming: false,
          text: payload.text ? payload.text : message.text,
          toolCalls: message.toolCalls.map(call =>
            call.status === 'running' ? { ...call, status: 'ok' } : call
          ),
          usage: payload.usage ?? message.usage ?? null
        })

        const next = withCurrentAssistant(transcript, finalize)

        return {
          ...next,
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

    approvalRequest(sessionId, payload) {
      const requestId = String(payload.request_id ?? nextMessageId('ap'))

      const approval: ApprovalRequest = {
        choices: payload.choices ?? ['once', 'session', 'always', 'deny'],
        command: payload.command,
        reason: payload.reason,
        receivedAt: Date.now(),
        requestId,
        sessionId,
        smartDenied: payload.smart_denied,
        toolName: payload.tool
      }

      update(sessionId, transcript => {
        if (transcript.approvals.some(item => item.requestId === requestId)) {
          return transcript
        }

        return { ...transcript, approvals: [...transcript.approvals, approval] }
      })

      const transcript = get().bySession[sessionId]

      effects.ackApproval(sessionId, requestId)
      effects.notify({
        body: payload.command ?? payload.reason ?? 'A bot is asking for permission.',
        sectionId: transcript?.sectionId,
        title: 'Approval needed'
      })
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
      update(sessionId, transcript => ({ ...transcript, status }))
    },

    sessionInfo(sessionId, info) {
      update(sessionId, transcript => ({ ...transcript, info }))
    },

    sessionUsage(sessionId, usage) {
      update(sessionId, transcript => ({ ...transcript, usage }))
    },

    errorEvent(sessionId, message) {
      update(sessionId, transcript => ({
        ...transcript,
        error: message,
        messages: [
          ...transcript.messages.map(item =>
            item.id === transcript.streamingMessageId ? { ...item, streaming: false } : item
          ),
          {
            attachments: [],
            createdAt: Date.now(),
            error: message,
            id: nextMessageId('e'),
            role: 'system' as const,
            streaming: false,
            text: '',
            toolCalls: []
          }
        ],
        streamingMessageId: null
      }))
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

export function useIsStreaming(sessionId: null | string): boolean {
  return useTranscripts(state =>
    Boolean(sessionId && state.bySession[sessionId]?.streamingMessageId)
  )
}

export function transcriptActions(): TranscriptsState {
  return useTranscripts.getState()
}
