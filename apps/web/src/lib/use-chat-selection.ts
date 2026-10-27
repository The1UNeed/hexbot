import { useRouter } from '@tanstack/react-router'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { useConnection } from '../stores/connection'
import { sectionsActions } from '../stores/sections'

import type { DaemonInfo } from './types'

/** How many bot chat lookups clicks have started. */
let started = 0
/** Whether the latest of them found a chat its caller opens. */
let latest: Promise<boolean> = Promise.resolve(false)

export const selectionsStarted = () => started

/** Once no click waits for a bot's chat: whether one started after `since` found a chat to open. */
export async function openedElsewhere(since: number) {
  let found = false

  for (let waited: unknown; waited !== latest; ) {
    waited = latest
    found = await latest
  }

  return started !== since && found
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
      started++
      let found = false
      let settle!: (found: boolean) => void
      latest = new Promise(resolve => (settle = resolve))

      try {
        const chat = await sectionsActions().chat(bot, current)

        // A chat found stays chosen until the caller's navigation cancels it.
        if (current() && chat) {
          found = true

          return chat
        }
      } catch (error) {
        if (current()) {
          setAsking(null)
          throw error
        }
      } finally {
        settle(found)
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
