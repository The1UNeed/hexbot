/**
 * The face a bot wears wherever it stands for the bot as a whole: its roster
 * row and its profile (the side panel and Bot settings). One rule, so both
 * show the same feeling and the same work at the same moment.
 */
import { useParams } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'

import type { DotStatus } from '../components/ui/status-dot'
import { type FaceEmotion, type FaceMood, moodForStatus } from '../lib/face'
import type { Bot, BotStatus, Section } from '../lib/types'
import { useEmotion } from '../stores/emotions'
import {
  botStatusWithLive,
  type LiveSections,
  liveSectionsOf,
  useSections
} from '../stores/sections'
import { useTranscripts } from '../stores/transcripts'
import { useUi } from '../stores/ui'

import { type LiveMood, liveMoodsOf } from './conversation/steps'

export interface BotRowState {
  /** The live store's sections, then the bot's recent ones it does not have yet. */
  available: Section[]
  /** The status, or done for a finished turn you have not seen while the chat is not on screen. */
  dot: DotStatus
  mood: FaceMood
  status: BotStatus
  /** Chats where a turn finished that you have not seen on any device. */
  unread: Section[]
}

/**
 * Whether `bot`'s chat is on screen or opening: the bot whose chat is
 * `opening` while one opens, else the route's.
 */
export function chatShown(
  bot: string,
  opening: null | string,
  params: { bot?: string; section?: string }
): boolean {
  return opening ? opening === bot : Boolean(params.section) && params.bot === bot
}

/**
 * A bot's state for its row and its profile. `active` is whether its chat is
 * the one on screen or opening (`chatShown`); `emotion` what it feels right now.
 */
export function botRowState(
  bot: Bot,
  sections: Section[],
  live: LiveSections,
  moods: Record<string, LiveMood>,
  active: boolean,
  emotion: FaceEmotion | undefined
): BotRowState {
  // Prefer the live sections store; the bot row's recent list can lag behind.
  const available = [
    ...sections,
    ...bot.sections_recent.filter(recent => !sections.some(section => section.id === recent.id))
  ]

  const status = botStatusWithLive(bot, available, live)

  // Check-ins and archived sections do not count: opening the bot never clears them.
  const unread = available.filter(
    section => section.done_at && !section.archived_at && !section.purpose
  )

  const dot = status === 'idle' && !active && unread.length ? 'done' : status

  const mood =
    emotion ??
    moodForStatus(
      dot,
      moods[bot.status_detail?.section_id ?? ''] ??
        available.map(section => moods[section.id]).find(Boolean)
    )

  return { available, dot, mood, status, unread }
}

/** The face `bot` wears in its roster row right now, for its profile to wear too. */
export function useBotMood(bot: Bot): FaceMood {
  const params = useParams({ strict: false }) as { bot?: string; section?: string }
  // The roster's own `asking`, which it shares as `openingBot`.
  const opening = useUi(state => state.openingBot)
  const openThread = useUi(state => state.thread)
  const active = !openThread && chatShown(bot.name, opening, params)
  const emotion = useEmotion(bot.name)

  const sections = useSections(
    useShallow(state => Object.values(state.byId).filter(section => section.bot === bot.name))
  )

  // Records of words compared by value: a streamed token re-renders this face
  // only when a status or a work face changes.
  const live = useTranscripts(useShallow(state => liveSectionsOf(state.bySession)))
  const moods = useTranscripts(useShallow(state => liveMoodsOf(state.bySession)))

  return botRowState(bot, sections, live, moods, active, emotion).mood
}
