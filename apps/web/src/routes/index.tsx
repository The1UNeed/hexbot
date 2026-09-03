import { createFileRoute, redirect } from '@tanstack/react-router'

import { connectionActions } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const last = uiActions().lastSection

    if (last) {throw redirect({ to: '/b/$bot/s/$section', params: last })}
    throw redirect({ to: connectionActions().target ? '/onboarding' : '/connect' })
  }
})
