/**
 * What each bot feels right now, by bot name, for every face of it on
 * screen: its chat header, its live face, its latest room message and its
 * roster row. Fed by the conversation open on screen through the rules in
 * lib/emotions.ts. Not persisted.
 */

import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'

import {
  BORED_AFTER_MS,
  DROWSY_AFTER_MS,
  EMOTION_SECONDS,
  feeling,
  feelingAbout,
  feelingAfter,
  type Moment,
  momentOf
} from '../lib/emotions'
import type { FaceEmotion } from '../lib/face'
import type { Message, RoomEvent, RoomTurn } from '../lib/types'

export interface EmotionsState {
  /** Clears whatever `bot` feels. */
  calm: (bot: string) => void
  /** Shows `emotion` on `bot`'s faces until it passes or another replaces it. */
  feel: (bot: string, emotion: FaceEmotion) => void
  feelings: Record<string, FaceEmotion>
}

const passing = new Map<string, ReturnType<typeof setTimeout>>()

export const useEmotions = create<EmotionsState>()(set => ({
  feelings: {},

  calm(bot) {
    clearTimeout(passing.get(bot))
    passing.delete(bot)
    set(state => {
      if (!(bot in state.feelings)) {
        return state
      }

      const feelings = { ...state.feelings }
      delete feelings[bot]

      return { feelings }
    })
  },

  feel(bot, emotion) {
    clearTimeout(passing.get(bot))
    passing.delete(bot)
    const seconds = EMOTION_SECONDS[emotion]

    if (Number.isFinite(seconds)) {
      passing.set(
        bot,
        setTimeout(() => {
          if (useEmotions.getState().feelings[bot] === emotion) {
            useEmotions.getState().calm(bot)
          }
        }, seconds * 1000)
      )
    }

    set(state => ({ feelings: { ...state.feelings, [bot]: emotion } }))
  }
}))

/** What `bot` feels right now, if anything. */
export function useEmotion(bot?: null | string): FaceEmotion | undefined {
  return useEmotions(state => (bot ? state.feelings[bot] : undefined))
}

/** Bored, then drowsy, while `active` and nothing changes; any change wakes the bot. */
function useIdleFeelings(bot: null | string | undefined, active: boolean, change: unknown) {
  useEffect(() => {
    if (!bot || !active) {
      return
    }

    const { feel } = useEmotions.getState()
    const bored = setTimeout(() => feel(bot, 'bored'), BORED_AFTER_MS)
    const drowsy = setTimeout(() => feel(bot, 'drowsy'), DROWSY_AFTER_MS)

    return () => {
      clearTimeout(bored)
      clearTimeout(drowsy)
      const { calm, feelings } = useEmotions.getState()

      if (feelings[bot] === 'bored' || feelings[bot] === 'drowsy') {
        calm(bot)
      }
    }
  }, [active, bot, change])
}

/**
 * Feeds `bot`'s feelings from its open conversation. Opening a conversation,
 * or switching to another, sets the baseline without a feeling, as restored
 * history is not news. While nothing happens the bot gets bored, then
 * drowsy; anything happening wakes it.
 */
export function useConversationFeelings(
  bot: null | string | undefined,
  conversation: null | string | undefined,
  messages: readonly Message[],
  ready = true
): void {
  const moment = useMemo(() => momentOf(messages), [messages])
  const last = useRef({ conversation, moment, ready })

  useEffect(() => {
    const before = last.current
    last.current = { conversation, moment, ready }

    if (!bot || !ready || !before.ready || !conversation || before.conversation !== conversation) {
      return
    }

    const emotion = feeling(before.moment, moment)

    if (emotion) {
      useEmotions.getState().feel(bot, emotion)
    }
  }, [bot, conversation, moment, ready])

  useIdleFeelings(bot, Boolean(conversation && ready && !moment.reply?.streaming), moment)
}

/**
 * Feeds the feelings of every bot in an open room. A bot takes your latest
 * message as its turn starts, reacts to its own failed steps while it works,
 * and feels about its reply when it lands; a failed turn is sad.
 */
export function useRoomFeelings(
  room: string,
  events: readonly RoomEvent[],
  turns: Record<string, RoomTurn>,
  transcripts: Record<string, { messages: Message[] } | undefined>
): void {
  const live = useMemo(() => {
    const moments: Record<string, Moment> = {}

    for (const turn of Object.values(turns)) {
      const messages = turn.live_session_id
        ? transcripts[turn.live_session_id]?.messages
        : undefined

      moments[turn.bot] = momentOf(messages ?? [])
    }

    return moments
  }, [transcripts, turns])

  const latest = events.at(-1)
  const last = useRef({ latest: latest?.seq ?? -1, live, room })

  useEffect(() => {
    const before = last.current
    last.current = { latest: latest?.seq ?? -1, live, room }

    if (before.room !== room) {
      return
    }

    const { feel } = useEmotions.getState()
    const said = events.findLast(event => event.kind === 'message.user')?.payload.text ?? ''

    for (const [bot, moment] of Object.entries(live)) {
      const earlier = before.live[bot]

      if (!earlier) {
        feel(bot, feelingAbout(said))

        continue
      }

      const emotion = feeling(earlier, moment)

      if (emotion) {
        feel(bot, emotion)
      }
    }

    // What landed since: a bot's reply, or a turn that failed.
    for (const event of events) {
      if (event.seq <= before.latest || event.actor_kind !== 'bot' || !event.actor_id) {
        continue
      }

      const bot = event.actor_id
      const reply = before.live[bot]?.reply

      if (event.kind === 'turn.failed') {
        feel(bot, 'sad')
      } else if (event.kind === 'message.bot') {
        const emotion = feelingAfter({
          errors: reply?.errors ?? 0,
          failed: false,
          id: String(event.seq),
          status: 'complete',
          steps: reply?.steps ?? 0,
          streaming: false,
          text: event.payload.text ?? '',
          workedMs: reply?.workedMs ?? 0
        })

        if (emotion) {
          feel(bot, emotion)
        }
      }
    }
  }, [events, latest?.seq, live, room])
}
