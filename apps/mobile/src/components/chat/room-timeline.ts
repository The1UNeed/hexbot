/**
 * A room as a flat list of rows, oldest first: time separators, member
 * notes, bubbles (a bot's first bubble of a run carries its face and name),
 * failed turns, and at the foot one row per bot whose turn is running with
 * the cards it is waiting on.
 */

import { toMillis } from '../../lib/time'
import type { ApprovalRequest, ClarifyRequest, RoomEvent, RoomTurn } from '../../lib/types'
import type { Transcript } from '../../stores/transcripts'

import type { Side } from './bubble'
import { JOINED, NEW_SPEAKER } from './timeline'

export type RoomRow =
  | { approval: ApprovalRequest; bot: string; gap: number; key: string; kind: 'approval' }
  | { bot: string; clarify: ClarifyRequest; gap: number; key: string; kind: 'clarify' }
  | { error: string; gap: number; key: string; kind: 'failed'; who: string }
  | { gap: number; key: string; kind: 'limit'; text: string }
  | { gap: number; key: string; kind: 'note'; text: string }
  | { gap: number; key: string; kind: 'separator'; time: number }
  | {
      /** Bot name for the face; null for a person. */
      bot: null | string
      fresh: boolean
      gap: number
      key: string
      kind: 'bubble'
      /** First bubble of a run from this speaker: the face and name show. */
      lead: boolean
      side: Side
      text: string
      who: string
    }
  | { bot: string; gap: number; key: string; kind: 'turn'; transcript?: Transcript; turn: RoomTurn; who: string }

const QUIET_MS = 20 * 60_000

export function buildRoomRows(input: {
  currentId?: null | string
  events: RoomEvent[]
  /** Display name for a member id (bot or person). */
  nameOf: (id: string, kind: 'bot' | 'human' | null) => string
  openedAt: number
  transcripts: Record<string, Transcript>
  turns: Record<string, RoomTurn>
}): RoomRow[] {
  const { currentId, events, nameOf, openedAt, transcripts, turns } = input
  const rows: RoomRow[] = []
  /** Who spoke last, for the 4 pt / 12 pt rhythm and the face on a run's first bubble. */
  let speaker: null | string = null
  let previousAt = 0

  for (const event of events) {
    const at = toMillis(event.created_at)

    if (!previousAt || new Date(previousAt).toDateString() !== new Date(at).toDateString() || at - previousAt > QUIET_MS) {
      rows.push({ gap: 0, key: `sep:${event.seq}`, kind: 'separator', time: event.created_at })
      speaker = null
    }

    previousAt = at

    const text = typeof event.payload.text === 'string' ? event.payload.text : ''
    const memberId = [event.payload.bot, event.payload.user, event.actor_id].find((id): id is string => typeof id === 'string')
    const memberKind = event.payload.bot ? 'bot' : event.payload.user ? 'human' : event.actor_kind === 'system' ? null : event.actor_kind
    const who = memberId ? nameOf(memberId, memberKind) : 'Someone'

    switch (event.kind) {
      case 'turn.started':
      case 'waiting.human':
        continue
      case 'member.added':
      case 'member.left':
      case 'note':
        rows.push({
          gap: 6,
          key: `note:${event.seq}`,
          kind: 'note',
          text: event.kind === 'member.added' ? `${who} joined the room` : event.kind === 'member.left' ? `${who} left the room` : text
        })
        speaker = null
        continue
      case 'turn.failed':
        rows.push({
          error: typeof event.payload.error === 'string' ? event.payload.error : '',
          gap: NEW_SPEAKER,
          key: `failed:${event.seq}`,
          kind: 'failed',
          who
        })
        speaker = null
        continue
      case 'limit.tripped':
        rows.push({ gap: NEW_SPEAKER, key: `limit:${event.seq}`, kind: 'limit', text: text || 'A room limit was reached.' })
        speaker = null
        continue
      default:
        break
    }

    if (event.kind !== 'message.bot' && event.kind !== 'message.user') {
      continue
    }

    const mine = event.kind === 'message.user' && (!currentId || event.actor_id === currentId)
    const id = mine ? 'me' : (event.actor_id ?? who)
    const lead = speaker !== id

    rows.push({
      bot: event.kind === 'message.bot' ? (event.actor_id ?? null) : null,
      fresh: at > openedAt,
      gap: lead ? NEW_SPEAKER : JOINED,
      key: `msg:${event.seq}`,
      kind: 'bubble',
      lead: lead && !mine,
      side: mine ? 'user' : 'bot',
      text,
      who
    })
    speaker = id
  }

  for (const turn of Object.values(turns)) {
    const transcript = turn.live_session_id ? transcripts[turn.live_session_id] : undefined
    const who = nameOf(turn.bot, 'bot')

    rows.push({ bot: turn.bot, gap: NEW_SPEAKER, key: `turn:${turn.bot}`, kind: 'turn', transcript, turn, who })

    // Only the owner receives the cards; answered or expired ones leave with the turn.
    for (const clarify of transcript?.clarifies ?? []) {
      if (!clarify.expired && Object.keys(clarify.answers).length < clarify.questions.length) {
        rows.push({ bot: turn.bot, clarify, gap: JOINED, key: `clarify:${clarify.requestId}`, kind: 'clarify' })
      }
    }

    for (const approval of transcript?.approvals ?? []) {
      if (!approval.decision) {
        rows.push({ approval, bot: turn.bot, gap: JOINED, key: `approval:${approval.requestId}`, kind: 'approval' })
      }
    }
  }

  return rows
}
