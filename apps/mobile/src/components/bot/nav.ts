/**
 * Leaving the bot sheet. It is a modal with its own stack, so going to a
 * section means closing the whole modal first and then opening the section
 * in the root stack: in place of the chat under the sheet, or on top of home.
 */

import { type Href, router, useNavigation } from 'expo-router'
import { useMemo } from 'react'

import { openSection } from '../../lib/navigation'

interface RootStack {
  getState: () => undefined | { routes: { name: string }[] }
  goBack: () => void
}

export function useBotSheet() {
  const navigation = useNavigation()

  return useMemo(() => {
    /** Close the sheet from any of its pages; returns the route under it. */
    const close = (): string | undefined => {
      const root = navigation.getParent() as RootStack | undefined

      if (!root) {
        return undefined
      }

      const routes = root.getState()?.routes ?? []
      const under = routes[routes.length - 2]?.name

      root.goBack()

      return under
    }

    /** Close the sheet and open one of the bot's sections. */
    const openAfterClose = (sectionId: string) => {
      const under = close()

      openSection(sectionId, under === 'chat/[section]' ? 'replace' : 'push')
    }

    return { close, openAfterClose }
  }, [navigation])
}

/** Push one of the bot's settings pages inside the sheet. */
export function openPage(bot: string, page: string, params: Record<string, string> = {}): void {
  router.push({ params: { name: bot, ...params }, pathname: `/bot/[name]/${page}` } as unknown as Href)
}
