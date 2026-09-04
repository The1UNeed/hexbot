import { createFileRoute, redirect } from '@tanstack/react-router'

import { isElectron } from '../lib/bridge'
import { connectionActions } from '../stores/connection'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const last = uiActions().lastSection

    if (last) {
      throw redirect({ to: '/b/$bot/s/$section', params: last })
    }

    // The desktop app always starts in onboarding, which offers "run here"
    // in the full package and goes to the connect screen in the client-only
    // package. A browser with nothing saved can only connect.
    throw redirect({ to: isElectron() || connectionActions().target ? '/onboarding' : '/connect' })
  }
})
