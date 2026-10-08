import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { AppShell } from '../app/app-shell'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/s/$section')({ component: BotSection })

function BotSection() {
  const { bot, section } = Route.useParams()
  const daemon = useConnection(state => state.daemon?.install_id ?? undefined)
  const gone = useBots(state => state.loaded && !state.byName[bot])

  // `/` comes back here, unless the bot was deleted (here or on another device).
  useEffect(() => {
    if (!gone) {
      uiActions().setLastSection({ bot, daemon, section })
    } else if (uiActions().lastSection?.bot === bot) {
      uiActions().setLastSection(null)
    }
  }, [bot, daemon, gone, section])

  return <AppShell />
}
