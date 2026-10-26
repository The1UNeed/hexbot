import { useEffect, useMemo, useRef, useState } from 'react'

import {
  BORED_AFTER_MS,
  DROWSY_AFTER_MS,
  EMOTION_SECONDS,
  feeling,
  interrupted,
  type Moment
} from '../../../web/src/lib/emotions'
import type { FaceEmotion } from '../ui/face-geometry'
import type { ChatState } from './types'

/**
 * A bot chat as the web app's emotion rules read it: what you said last, and
 * the turn it started, running or finished. Mobile does not time turns, so
 * pride comes from the number of steps alone.
 */
export function chatMoment(chat: ChatState): Moment {
  const users = chat.messages.filter(message => message.role === 'user')
  const id = `turn-${users.length}`
  const said = users.at(-1)

  if (chat.busy) {
    return {
      reply: {
        errors: chat.tools.filter(tool => tool.status === 'error').length,
        failed: false,
        id,
        steps: chat.tools.length,
        streaming: true,
        text: '',
        workedMs: 0
      },
      said: said && { text: said.text }
    }
  }

  const since = chat.messages.slice(said ? chat.messages.lastIndexOf(said) + 1 : 0)
  const replies = since.filter(message => message.role === 'assistant')
  const tools = replies.flatMap(message => message.tools ?? [])

  return {
    reply: {
      errors: tools.filter(tool => tool.status === 'error').length,
      failed: Boolean(chat.error) && !interrupted(chat.error),
      id,
      status: interrupted(chat.error) ? 'interrupted' : chat.error ? 'error' : 'complete',
      steps: tools.length,
      streaming: false,
      text: replies.map(message => message.text).join('\n'),
      workedMs: 0
    },
    said: said && { text: said.text }
  }
}

/**
 * What the bot feels in the open chat, for its face in the header and the
 * waiting row: a moment's reaction to what just happened, bored and then
 * drowsy while nothing does. Opening or switching chats starts calm, and
 * the history that loads while `ready` is false is not news.
 */
export function useFeeling(
  conversation: null | string,
  chat: ChatState,
  ready = true
): FaceEmotion | undefined {
  const moment = useMemo(() => chatMoment(chat), [chat])
  const [emotion, setEmotion] = useState<FaceEmotion>()
  const last = useRef({ conversation, moment, ready })

  useEffect(() => {
    const before = last.current
    last.current = { conversation, moment, ready }

    if (!conversation || before.conversation !== conversation) {
      setEmotion(undefined)

      return
    }

    if (!ready || !before.ready) {
      return
    }

    const next = feeling(before.moment, moment)

    if (next) {
      setEmotion(next)
    }
  }, [conversation, moment])

  useEffect(() => {
    const seconds = emotion ? EMOTION_SECONDS[emotion] : 0

    if (!Number.isFinite(seconds) || !seconds) {
      return
    }

    const passing = setTimeout(() => setEmotion(undefined), seconds * 1000)

    return () => clearTimeout(passing)
  }, [emotion])

  const busy = chat.busy

  useEffect(() => {
    if (!conversation || !ready || busy) {
      return
    }

    const bored = setTimeout(() => setEmotion('bored'), BORED_AFTER_MS)
    const drowsy = setTimeout(() => setEmotion('drowsy'), DROWSY_AFTER_MS)

    return () => {
      clearTimeout(bored)
      clearTimeout(drowsy)
      // Anything happening wakes the bot.
      setEmotion(current => (current === 'bored' || current === 'drowsy' ? undefined : current))
    }
  }, [busy, conversation, moment, ready])

  return emotion
}
