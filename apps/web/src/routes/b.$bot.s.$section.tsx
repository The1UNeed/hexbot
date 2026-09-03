import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { AppShell } from '../app/app-shell'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/s/$section')({ component: BotSection })

function BotSection() {
  const { bot, section } = Route.useParams()
  useEffect(() => uiActions().setLastSection({ bot, section }), [bot, section])

  return <AppShell />
}
