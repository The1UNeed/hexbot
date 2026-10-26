import { createFileRoute, redirect } from '@tanstack/react-router'

import { hasLocalRuntime } from '../lib/bridge'
import { connectionActions } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const last = uiActions().lastSection

    if (last && connectionActions().target) {
      throw redirect({ to: '/b/$bot/s/$section', params: last })
    }

    // Full can set up a local daemon. Client and an unpaired browser can only connect.
    throw redirect({
      to: hasLocalRuntime() || connectionActions().target ? '/onboarding' : '/connect'
    })
  }
})
