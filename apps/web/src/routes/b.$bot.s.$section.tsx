import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { AppShell } from '../app/app-shell'
import { useConnection } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/s/$section')({ component: BotSection })

function BotSection() {
  const { bot, section } = Route.useParams()
  const daemon = useConnection(state => state.daemon?.install_id ?? undefined)
  useEffect(() => uiActions().setLastSection({ bot, daemon, section }), [bot, daemon, section])

  return <AppShell />
}
