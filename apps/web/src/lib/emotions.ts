/**
 * How a bot feels about what just happened in its conversation. The rules
 * read only the messages the client already has: what you said, how the
 * bot's steps went, and how its reply ended. Nothing is asked of the model, so
 * emotions cost no tokens and leave prompts and their cache alone. Mobile
 * uses the same rules.
 *
 * Each emotion shows for a moment over what the bot is doing, then passes.
 * Drowsy is the exception: it stays until something happens.
 */

import type { FaceEmotion } from './face-geometry'
import type { Message } from './types'

/** How long each emotion shows, in seconds. */
export const EMOTION_SECONDS: Record<FaceEmotion, number> = {
  bored: 6,
  celebrating: 2.8,
  confused: 1.8,
  curious: 1.4,
  drowsy: Number.POSITIVE_INFINITY,
  frustrated: 2.4,
  proud: 3,
  sad: 3.5,
  shy: 2.2,
  surprised: 1.3
}

/** A quiet open conversation: bored after this long, then drowsy. */
export const BORED_AFTER_MS = 3 * 60_000
export const DROWSY_AFTER_MS = 8 * 60_000

/** A reply this long, or with this many steps, is work to be proud of. */
const PROUD_AFTER_MS = 60_000
const PROUD_STEPS = 8

/** This many failed steps in one reply is frustrating, not just confusing. */
const FRUSTRATED_ERRORS = 3

/** The parts of a conversation the rules compare from one moment to the next. */
export interface Moment {
  /** The bot's latest reply. */
  reply?: {
    errors: number
    failed: boolean
    id: string
    /** How the reply ended, as the daemon says: `complete`, `error`, or a stop. */
    status?: string
    steps: number
    streaming: boolean
    text: string
    workedMs: number
  }
  /** The latest thing you said. */
  said?: { text: string }
}

/**
 * `active` is whether the turn still runs. A question or approval card closes
 * the bubble on screen while the turn goes on, so the bubble alone would end
 * the reply early and start it again after the card; the reply's steps, time
 * and failures count every bubble of the turn.
 */
export function momentOf(
  messages: readonly (Message & { request?: true })[],
  active?: boolean
): Moment {
  const last = messages.findLastIndex(message => message.role === 'assistant')

  // The turn is everything since you last spoke before the latest reply, so a
  // message you send while it runs waits for the next turn. With nothing
  // from you, as in Check-ins, it is only the latest reply.
  const said = (last < 0 ? messages : messages.slice(0, last)).findLast(
    message => message.role === 'user'
  )

  const turn = messages.slice(said ? messages.indexOf(said) + 1 : Math.max(0, last))
  const bubbles = turn.filter(message => message.role === 'assistant')
  const reply = bubbles.at(-1)
  const calls = bubbles.flatMap(bubble => bubble.toolCalls)
  const first = bubbles[0]

  // An error event leaves its Stopped card after the reply, not on it. A
  // failed send (`request`) leaves a card too, but the reply runs on.
  const stopped =
    reply &&
    turn
      .slice(turn.indexOf(reply) + 1)
      .some(item => item.error && !item.request && !interrupted(item.error))

  // You pressed Stop: the daemon reports it as an error, but nothing failed.
  const cut = interrupted(reply?.error)

  return {
    reply: reply && {
      errors: calls.filter(call => call.status === 'error').length,
      failed: !cut && (Boolean(reply.error) || reply.status === 'error' || Boolean(stopped)),
      id: reply.id,
      status: cut ? 'interrupted' : reply.status,
      steps: calls.length,
      streaming: active ?? reply.streaming,
      text: [...(reply.parts ?? []), reply.text].join('\n'),
      workedMs: Math.max(0, (reply.workUntil ?? reply.createdAt) - (first?.createdAt ?? 0))
    },
    said: said && { text: said.text }
  }
}

const PRAISE =
  /\b(thanks|thank you|thx|ty|great job|good job|nice work|well done|awesome|amazing|brilliant|perfect|love (it|this)|you rock)\b|👍|🙏|❤|👏/iu

const ALARM = /\b(urgent|asap|emergency|broken|crash(ed|ing)?|outage|help)\b|!{2,}/i

const APOLOGY =
  /^\W*(sorry|i'?m sorry|i apologi[sz]e|apologies|unfortunately|i (couldn'?t|can'?t|wasn'?t able|was unable))/i

const CELEBRATION =
  /[🎉🥳]|\b(all (\d+ )?tests pass(ed)?|tests are (all )?passing|shipped|merged|deployed|it works)\b/iu

const STOPPED = /interrupt|stop|cancel|abort/i

/** The daemon's error for a turn you stopped. */
export function interrupted(error?: null | string): boolean {
  return Boolean(error && /^The turn was interrupted/.test(error))
}

/** Mostly capitals: someone is shouting. */
function shouting(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, '')

  return letters.length >= 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7
}

/** How the bot takes something you just said. */
export function feelingAbout(text: string): FaceEmotion {
  if (PRAISE.test(text)) {
    return 'shy'
  }

  if (ALARM.test(text) || shouting(text)) {
    return 'surprised'
  }

  return 'curious'
}

/** How the bot feels as its reply ends, or null when it simply finished. */
export function feelingAfter(reply: NonNullable<Moment['reply']>): FaceEmotion | null {
  if (reply.failed) {
    return 'sad'
  }

  // Stopped by you: no feelings about it.
  if (reply.status && STOPPED.test(reply.status)) {
    return null
  }

  const text = reply.text.trim()

  if (APOLOGY.test(text)) {
    return 'sad'
  }

  if (CELEBRATION.test(text)) {
    return 'celebrating'
  }

  if (reply.workedMs >= PROUD_AFTER_MS || reply.steps >= PROUD_STEPS) {
    return 'proud'
  }

  if (text.endsWith('?')) {
    return 'curious'
  }

  return null
}

/** What, if anything, the bot feels about the change from `before` to `after`. */
export function feeling(before: Moment, after: Moment): FaceEmotion | null {
  const reply = after.reply

  if (!reply) {
    return null
  }

  // A turn starts: the bot takes in what you said. Reloaded history never
  // streams, so it is not taken for news.
  if (reply.streaming && !before.reply?.streaming) {
    return after.said ? feelingAbout(after.said.text) : null
  }

  // Still the same turn, which counts its failed steps across bubbles.
  const failedBefore = before.reply?.errors ?? 0

  if (reply.streaming && reply.errors > failedBefore) {
    return reply.errors >= FRUSTRATED_ERRORS && failedBefore < FRUSTRATED_ERRORS
      ? 'frustrated'
      : 'confused'
  }

  // The reply ended. The chat may have swapped the live message for its saved
  // copy, with a new id, as it ended.
  if (!reply.streaming && before.reply?.streaming) {
    return feelingAfter(reply)
  }

  return null
}
