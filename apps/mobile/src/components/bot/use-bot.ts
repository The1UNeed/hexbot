/**
 * The bot a settings page edits, from the route's `name`, with one `save`
 * that patches it and keeps the last error for the page to show inline.
 */

import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'

import type { Bot, BotUpdatePatch } from '../../lib/types'
import { useBots } from '../../stores/bots'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function useBotRoute(): { bot: Bot | undefined; loaded: boolean; name: string } {
  const params = useLocalSearchParams<{ name: string }>()
  const name = String(params.name ?? '')
  const bot = useBots(state => state.byName[name])
  const loaded = useBots(state => state.loaded)

  useEffect(() => {
    if (name && !useBots.getState().byName[name]) {
      void useBots.getState().refreshOne(name)
    }
  }, [name])

  return { bot, loaded, name }
}

export function useBotSave(name: string) {
  const [error, setError] = useState<null | string>(null)

  /** Patch the bot; throws so a field can keep its draft, and records the error. */
  const save = useCallback(
    async (patch: BotUpdatePatch) => {
      setError(null)

      try {
        return await useBots.getState().update(name, patch)
      } catch (caught) {
        setError(errorText(caught))
        throw caught
      }
    },
    [name]
  )

  /** Fire and forget: the error lands in `error`. */
  const quietly = useCallback((patch: BotUpdatePatch) => void save(patch).catch(() => undefined), [save])

  return { error, quietly, save, setError }
}
