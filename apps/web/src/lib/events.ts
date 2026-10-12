/**
 * Routes gateway notifications to store actions. The mapping table in
 * docs/client-architecture.md is the spec:
 *
 *   message.start          begin assistant message (streaming)
 *   message.delta          append text
 *   message.interim        append commentary when `already_streamed` is false
 *   message.complete       finalize, attach usage, `hexbot.sections.touch`
 *   reasoning.delta        append to the message's reasoning trace
 *   thinking.delta         replace the daemon's status line (a wait notice)
 *   tool.start/complete    add or resolve a tool call in the current message
 *   approval.request       push an approval card (session scoped) and notify
 *   clarify.request/expire push a question card the bot is waiting on; expire freezes it
 *   status.update          header status line
 *   session.info           section model and provider chips
 *   session.usage          usage badge
 *   error                  inline error row
 *   hexbot.bots.incident   Stopped card in the section's transcript, notification
 *
 * Session-less `hexbot.*.changed` events refresh the cold stores.
 */

import type { GatewayEvent } from '@hermes/shared'

import { useBots } from '../stores/bots'
import { useConnectors } from '../stores/connectors'
import { useMe } from '../stores/me'
import { useRooms } from '../stores/rooms'
import { botStatus, useSections } from '../stores/sections'
import { useSettings } from '../stores/settings'
import type {
  ApprovalRequestPayload,
  ToolCompletePayload,
  ToolStartPayload
} from '../stores/transcripts'
import { transcriptNotify, useTranscripts } from '../stores/transcripts'
import { useUi } from '../stores/ui'

import type { HexbotRpcClient } from './rpc'
import type {
  ClarifyRequestPayload,
  ContextUsage,
  RoomEvent,
  RoomTurn,
  SessionInfo,
  Usage
} from './types'

export interface EventRouterDeps {
  refreshBots?: () => void
  refreshConnectors?: () => void
  refreshNetwork?: () => void
  refreshSections?: () => void
  refreshRooms?: () => void
}

const defaultDeps: Required<EventRouterDeps> = {
  refreshBots: () => {
    void useBots.getState().refresh()
  },
  refreshConnectors: () => {
    void useConnectors.getState().refreshAll()
  },
  refreshNetwork: () => {
    void useSettings.getState().refreshNetwork()
  },
  refreshSections: () => {
    void useSections.getState().refresh()
  },
  refreshRooms: () => void useRooms.getState().refresh()
}

function payloadOf(event: GatewayEvent): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>
}

function text(payload: Record<string, unknown>): string {
  return typeof payload.text === 'string' ? payload.text : ''
}

/** Fields the daemon adds to a bot for status; read loosely so older records still work. */
type BotSignals = Partial<{ notify: boolean; status: string }>

/** Per-bot "Notify me" switch; a bot without the field is treated as on. */
export function botNotifies(bot?: string | null): boolean {
  const record = bot ? (useBots.getState().byName[bot] as BotSignals | undefined) : undefined

  return record?.notify !== false
}

function botOfSection(sectionId?: string | null): string | undefined {
  return sectionId ? useSections.getState().byId[sectionId]?.bot : undefined
}

/** Whose card this is: its section's bot, else the bot the daemon names (private threads are unlisted). */
function cardBot(payload: Record<string, unknown>, sectionId?: string | null): string | undefined {
  return botOfSection(sectionId) ?? (typeof payload.bot === 'string' ? payload.bot : undefined)
}

/** A settled card may be the first replayed event from an unopened conversation. */
function bindSettlementOwner(sessionId: string, payload: Record<string, unknown>): void {
  const transcripts = useTranscripts.getState()
  const transcript = transcripts.bySession[sessionId]

  if (!transcript || typeof payload.section_id !== 'string' || !payload.section_id) {
    return
  }

  const bot = transcript.bot ?? cardBot(payload, payload.section_id)

  if (!bot) {
    return
  }

  const detail = useBots.getState().byName[bot]?.status_detail

  const sectionId =
    transcript.sectionId ??
    (detail?.session_id === sessionId && detail.room_id
      ? `room:${detail.room_id}`
      : payload.section_id)

  if (sectionId !== transcript.sectionId || bot !== transcript.bot) {
    transcripts.setSectionId(sessionId, sectionId, bot)
  }

  void useSections.getState().verifySessionOwner(sessionId)
}

/** Retry starts carry only a session id; use exact known ownership before recording proof. */
function bindRetryOwner(sessionId: string): boolean {
  const transcripts = useTranscripts.getState()
  const transcript = transcripts.bySession[sessionId]
  const sections = useSections.getState()

  const owners = Object.entries(sections.liveSessionId).flatMap(([id, live]) => {
    const section = sections.byId[id]

    return live === sessionId && section ? [{ sectionId: id, bot: section.bot }] : []
  })

  const rooms = useRooms.getState()

  for (const [roomId, turns] of Object.entries(rooms.liveTurnsByRoom)) {
    for (const [bot, turn] of Object.entries(turns)) {
      if (
        turn.live_session_id === sessionId &&
        turn.bot === bot &&
        turn.room_id === roomId &&
        turn.status === 'running'
      ) {
        owners.push({ sectionId: `room:${roomId}`, bot })
      }
    }
  }

  for (const bot of Object.values(useBots.getState().byName)) {
    const detail = bot.status_detail

    if (
      detail?.session_id === sessionId &&
      detail.section_id &&
      !detail.room_id &&
      detail.action?.kind === 'retry' &&
      botStatus(bot) === 'stopped' &&
      !owners.some(owner => owner.bot === bot.name && owner.sectionId.startsWith('room:'))
    ) {
      owners.push({ sectionId: detail.section_id, bot: bot.name })
    }
  }

  const owner = owners[0]

  if (!owner) {
    return !transcript?.sectionId?.startsWith('room:')
  }

  if (
    owners.some(item => item.sectionId !== owner.sectionId || item.bot !== owner.bot) ||
    (transcript?.sectionId && transcript.sectionId !== owner.sectionId) ||
    (transcript?.bot && transcript.bot !== owner.bot)
  ) {
    return false
  }

  transcripts.setSectionId(sessionId, owner.sectionId, owner.bot)

  return true
}

/** The open transcript for an incident: the section's live session, else the id as sent. */
function incidentSession(payload: Record<string, unknown>): null | string {
  const sections = useSections.getState()
  const transcripts = useTranscripts.getState().bySession
  const sectionId = typeof payload.section_id === 'string' ? payload.section_id : null
  const live = sectionId ? sections.liveSessionId[sectionId] : undefined

  if (live && transcripts[live]) {
    return live
  }

  const sent = typeof payload.session_id === 'string' ? payload.session_id : null

  return sent && transcripts[sent] ? sent : null
}

/** Dispatch one gateway event. Unknown types are ignored on purpose. */
export function routeEvent(event: GatewayEvent, deps: EventRouterDeps = {}): void {
  const effects = { ...defaultDeps, ...deps }
  const payload = payloadOf(event)
  const sessionId = event.session_id ?? ''
  const transcripts = useTranscripts.getState()
  const rooms = useRooms.getState()

  switch (event.type) {
    case 'warning':
      if (typeof payload.section_id === 'string' && typeof payload.message === 'string') {
        transcripts.setWarning(
          typeof payload.room_id === 'string'
            ? `room:${payload.room_id}:${payload.section_id}`
            : payload.section_id,
          payload.message
        )
      }

      return

    case 'hexbot.bots.changed':
      effects.refreshBots()

      return

    case 'hexbot.users.changed':
      void useMe.getState().refresh()

      return

    case 'hexbot.memory.user.changed':
      return

    case 'hexbot.connectors.changed':
      effects.refreshConnectors()

      return
    case 'hexbot.bots.incident': {
      const incident = (payload.incident ?? {}) as Record<string, unknown>
      const bot = typeof payload.bot === 'string' ? payload.bot : ''
      const message = typeof incident.text === 'string' ? incident.text : 'The bot stopped.'

      if (incident.resolved_at) {
        return
      }

      const target = incidentSession(payload)

      if (target) {
        transcripts.incidentEvent(target, message, {
          connector: typeof incident.connector === 'string' ? incident.connector : null,
          ...(typeof incident.id === 'string' ? { incidentId: incident.id } : {})
        })
      }

      if (botNotifies(bot)) {
        const name = useBots.getState().byName[bot]?.display_name ?? bot
        const sectionId = typeof payload.section_id === 'string' ? payload.section_id : undefined
        transcriptNotify({ body: message, sectionId, title: `${name} stopped` })
      }

      return
    }

    case 'hexbot.rooms.changed':
      if (typeof payload.id === 'string' && payload.deleted === true) {
        rooms.drop(payload.id)
      } else if (typeof payload.id === 'string') {
        void rooms.refreshOne(payload.id)
      } else {
        effects.refreshRooms()
      }

      return

    case 'hexbot.rooms.event':
      if (typeof payload.room_id === 'string' && payload.event) {
        rooms.handleEvent(payload.room_id, payload.event as RoomEvent)
      }

      return

    case 'hexbot.rooms.turn':
      if (typeof payload.room_id === 'string' && typeof payload.bot === 'string') {
        rooms.handleTurn(payload as unknown as RoomTurn)
      }

      return

    case 'hexbot.network.changed':
      effects.refreshNetwork()

      return

    case 'hexbot.sections.changed':
      if (typeof payload.id === 'string' && payload.deleted !== true) {
        for (const transcript of Object.values(transcripts.bySession)) {
          const section = useSections.getState().byId[payload.id]

          if (transcript.sectionId === payload.id && (!section || section.peer_bot)) {
            void useSections.getState().verifySessionOwner(transcript.sessionId, true)
          }
        }
      }

      if (typeof payload.id === 'string' && payload.deleted === true) {
        useSections.getState().drop(payload.id)

        // An unopened private session can be known only through the bot's cached cause.
        for (const bot of Object.values(useBots.getState().byName)) {
          const detail = bot.status_detail

          if (detail?.section_id === payload.id && !detail.room_id && detail.session_id) {
            transcripts.drop(detail.session_id)
          }
        }
      }

      effects.refreshSections()
      effects.refreshBots()
      // Every ask touches its thread; an open thread panel reads it again (new live session,
      // first ask while the panel waited).
      useUi.getState().touchThread(typeof payload.id === 'string' ? payload.id : undefined)

      return

    // Hexbot named the session from its first prompt; the list adopts it.
    case 'session.title':
      effects.refreshSections()

      return

    default:
      break
  }

  if (!sessionId) {
    return
  }

  // A card from a thread no list names still carries its section, which a notification needs.
  if (
    (event.type === 'approval.request' || event.type === 'clarify.request') &&
    typeof payload.section_id === 'string' &&
    (!transcripts.bySession[sessionId]?.sectionId || typeof payload.bot === 'string')
  ) {
    transcripts.setSectionId(
      sessionId,
      transcripts.bySession[sessionId]?.sectionId ?? payload.section_id,
      botOfSection(transcripts.bySession[sessionId]?.sectionId ?? payload.section_id) ??
        transcripts.bySession[sessionId]?.bot ??
        cardBot(payload, payload.section_id)
    )
  }

  switch (event.type) {
    case 'approval.request':
      transcripts.approvalRequest(sessionId, payload as ApprovalRequestPayload, {
        notify: botNotifies(cardBot(payload, transcripts.bySession[sessionId]?.sectionId))
      })
      void useSections.getState().verifySessionOwner(sessionId)

      return

    case 'clarify.request':
      transcripts.clarifyRequest(sessionId, payload as ClarifyRequestPayload, {
        notify: botNotifies(cardBot(payload, transcripts.bySession[sessionId]?.sectionId))
      })
      void useSections.getState().verifySessionOwner(sessionId)

      return

    case 'approval.resolved':
      if (
        typeof payload.request_id === 'string' &&
        payload.request_id &&
        (payload.choice === 'once' || payload.choice === 'session' || payload.choice === 'deny')
      ) {
        transcripts.approvalResolved(sessionId, {
          request_id: payload.request_id,
          choice: payload.choice
        })

        if (
          Object.hasOwn(
            useTranscripts.getState().bySession[sessionId]?.approvalDecisions ?? {},
            payload.request_id
          )
        ) {
          bindSettlementOwner(sessionId, payload)
        }
      }

      return

    case 'clarify.resolved':
      if (
        typeof payload.request_id === 'string' &&
        payload.request_id &&
        (payload.status === 'answered' || payload.status === 'waiting') &&
        payload.answers &&
        typeof payload.answers === 'object' &&
        !Array.isArray(payload.answers) &&
        Object.values(payload.answers).every(answer => typeof answer === 'string')
      ) {
        transcripts.clarifyResolved(sessionId, {
          request_id: payload.request_id,
          answers: payload.answers as Record<string, string>,
          status: payload.status
        })

        if (
          Object.hasOwn(
            useTranscripts.getState().bySession[sessionId]?.clarifyAnswers ?? {},
            payload.request_id
          )
        ) {
          bindSettlementOwner(sessionId, payload)
        }
      }

      return

    case 'clarify.expire':
      if (typeof payload.request_id === 'string') {
        transcripts.clarifyExpire(sessionId, payload.request_id)
      }

      return

    case 'error':
      transcripts.errorEvent(
        sessionId,
        typeof payload.message === 'string' ? payload.message : 'Unknown error'
      )

      return

    case 'message.complete':
      transcripts.messageComplete(sessionId, {
        error: typeof payload.error === 'string' ? payload.error : undefined,
        partial: payload.partial === true,
        status: typeof payload.status === 'string' ? payload.status : undefined,
        text: text(payload),
        usage: (payload.usage as undefined | Usage) ?? undefined
      })

      return

    case 'message.delta':
      transcripts.messageDelta(sessionId, text(payload))

      return

    case 'message.interim':
      transcripts.messageInterim(sessionId, text(payload), payload.already_streamed === true)

      return

    case 'message.start':
      transcripts.messageStart(
        sessionId,
        payload.retry_resolved === true && bindRetryOwner(sessionId)
      )

      return

    case 'session.info':
      transcripts.sessionInfo(sessionId, payload as SessionInfo)

      return

    case 'session.usage':
      transcripts.sessionUsage(sessionId, ((payload.usage as Usage) ?? payload) as Usage)

      if (payload.context && typeof payload.context === 'object') {
        transcripts.sessionContext(sessionId, payload.context as ContextUsage)
      }

      return

    case 'status.update':
      transcripts.statusUpdate(sessionId, {
        kind: typeof payload.kind === 'string' ? payload.kind : 'status',
        text: text(payload)
      })

      return

    case 'reasoning.delta':
      transcripts.reasoningDelta(sessionId, text(payload))

      return

    case 'thinking.delta':
      transcripts.thinkingDelta(sessionId, text(payload))

      return

    case 'tool.complete':
      transcripts.toolComplete(sessionId, payload as ToolCompletePayload)

      return

    case 'tool.start':
      transcripts.toolStart(sessionId, payload as ToolStartPayload)

      return

    default:
      break
  }
}

/** Subscribe the router to a connected client; returns the unsubscribe. */
export function attachEventRouting(
  client: HexbotRpcClient,
  deps: EventRouterDeps = {}
): () => void {
  return client.onEvent(event => {
    routeEvent(event, deps)
  })
}
