import { useRouter } from '@tanstack/react-router'
import { useCallback, useLayoutEffect, useRef } from 'react'

import { useConnection } from '../stores/connection'
import { sectionsActions } from '../stores/sections'

/** A lookup belongs to this view until another selection, navigation, or daemon wins. */
export function useChatSelection() {
  const router = useRouter()
  const generation = useRef(0)

  const cancel = useCallback(() => {
    generation.current++
    const choice = sectionsActions().choosing

    if (choice && !choice.current()) {
      choice.pick(null)
    }
  }, [])

  useLayoutEffect(() => {
    const offHistory = router.history.subscribe(cancel)
    const offNavigate = router.subscribe('onBeforeNavigate', cancel)

    return () => {
      offHistory()
      offNavigate()
      cancel()
    }
  }, [router, cancel])

  const selectChat = useCallback(
    async (bot: string) => {
      const selected = ++generation.current
      const location = router.history.location
      const { target, epoch, daemon } = useConnection.getState()

      // Read history directly: React may still be batching the route transition.
      const current = () =>
        generation.current === selected &&
        router.history.location === location &&
        target === useConnection.getState().target &&
        epoch === useConnection.getState().epoch &&
        daemon?.one_chat === useConnection.getState().daemon?.one_chat &&
        daemon?.install_id === useConnection.getState().daemon?.install_id

      try {
        const chat = await sectionsActions().chat(bot, current)

        return current() ? chat : null
      } catch (error) {
        if (current()) {
          throw error
        }

        return null
      }
    },
    [router]
  )

  return { cancel, selectChat }
}
