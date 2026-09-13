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
import { useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'
import { useSettings } from '../stores/settings'
import type {
  ApprovalRequestPayload,
  ToolCompletePayload,
  ToolStartPayload
} from '../stores/transcripts'
import { transcriptNotify, useTranscripts } from '../stores/transcripts'

import type { HexbotRpcClient } from './rpc'
import type { RoomEvent, RoomTurn, SessionInfo, Usage } from './types'

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
    case 'hexbot.bots.changed':
      effects.refreshBots()

      return

    case 'hexbot.memory.core.changed':
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
      if (typeof payload.id === 'string') {
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
      effects.refreshSections()
      effects.refreshBots()

      return

    default:
      break
  }

  if (!sessionId) {
    return
  }

  switch (event.type) {
    case 'approval.request':
      transcripts.approvalRequest(sessionId, payload as ApprovalRequestPayload, {
        notify: botNotifies(botOfSection(transcripts.bySession[sessionId]?.sectionId))
      })

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
      transcripts.messageStart(sessionId)

      return

    case 'session.info':
      transcripts.sessionInfo(sessionId, payload as SessionInfo)

      return

    case 'session.usage':
      transcripts.sessionUsage(sessionId, ((payload.usage as Usage) ?? payload) as Usage)

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
