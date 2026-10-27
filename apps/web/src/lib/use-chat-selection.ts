import { useRouter } from '@tanstack/react-router'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { useConnection } from '../stores/connection'
import { sectionsActions } from '../stores/sections'

import type { DaemonInfo } from './types'

/** The latest bot chat lookup a click started, settled or not. */
let latest: Promise<unknown> = Promise.resolve()

/** Settles once no click is waiting for a bot's chat. */
export async function selectionsSettled() {
  for (let waited: unknown; waited !== latest; ) {
    waited = latest
    await latest
  }
}

/** A lookup belongs to this view until another selection, navigation, or daemon wins. */
export function useChatSelection() {
  const router = useRouter()
  const generation = useRef(0)
  const selection = useRef<null | (() => boolean)>(null)
  // The bot whose chat is being asked for, until it opens or the lookup is cancelled.
  const [asking, setAsking] = useState<null | string>(null)

  const hydration = useRef<null | {
    current: () => boolean
    accept: (daemon: DaemonInfo) => void
  }>(null)

  const cancel = useCallback(() => {
    generation.current++
    selection.current = null
    hydration.current = null
    setAsking(null)
    const choice = sectionsActions().choosing

    if (choice && !choice.current()) {
      choice.pick(null)
    }
  }, [])

  useLayoutEffect(() => {
    const offHistory = router.history.subscribe(cancel)
    const offNavigate = router.subscribe('onBeforeNavigate', cancel)

    const offConnection = useConnection.subscribe(next => {
      const pending = hydration.current

      if (pending && next.daemon) {
        hydration.current = null

        if (pending.current()) {
          pending.accept(next.daemon)
        }
      }

      if (selection.current && !selection.current()) {
        cancel()
      }
    })

    return () => {
      offHistory()
      offNavigate()
      offConnection()
      cancel()
    }
  }, [router, cancel])

  const startSelection = useCallback(
    (options?: { hydrate?: boolean }) => {
      const selected = ++generation.current
      const location = router.history.location
      const { target, epoch } = useConnection.getState()
      let { daemon } = useConnection.getState()

      // Read history directly: React may still be batching the route transition.
      const currentVisit = () =>
        generation.current === selected &&
        router.history.location === location &&
        target === useConnection.getState().target &&
        epoch === useConnection.getState().epoch

      // Onboarding can start before the connection's first info reply. Bind its
      // identity at that first publication, only while the original visit owns
      // the decision. Every later capability/install change still cancels it.
      hydration.current =
        options?.hydrate && !daemon
          ? {
              current: currentVisit,
              accept: info => {
                daemon = info
              }
            }
          : null

      const current = () =>
        currentVisit() &&
        daemon?.one_chat === useConnection.getState().daemon?.one_chat &&
        daemon?.install_id === useConnection.getState().daemon?.install_id

      selection.current = current

      return current
    },
    [router]
  )

  const selectChat = useCallback(
    async (bot: string) => {
      const current = startSelection()
      setAsking(bot)

      try {
        const lookup = sectionsActions().chat(bot, current)
        latest = lookup.catch(() => null)
        const chat = await lookup

        // A chat found stays chosen until the caller's navigation cancels it.
        if (current() && chat) {
          return chat
        }
      } catch (error) {
        if (current()) {
          setAsking(null)
          throw error
        }
      }

      if (current()) {
        setAsking(null)
      }

      return null
    },
    [startSelection]
  )

  return { asking, cancel, selectChat, startSelection }
}
