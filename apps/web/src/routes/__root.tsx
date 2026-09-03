import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'

import { getSupervisor } from '../lib/connection'
import { useConnection } from '../stores/connection'
import { applyTheme, useUi } from '../stores/ui'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout() {
  const target = useConnection(state => state.target)
  const status = useConnection(state => state.status)
  const attempt = useConnection(state => state.attempt)
  const daemon = useConnection(state => state.daemon)
  const theme = useUi(state => state.theme)

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    if (target) {
      void getSupervisor().start(target)
    }

    return () => getSupervisor().stop()
  }, [target])

  return (
    <>
      <div className="sr-only" data-testid="root-connection-status" role="status">
        {daemon?.daemon_name ?? status}
        {attempt > 0 ? `, attempt ${attempt}` : ''}
      </div>
      <Outlet />
    </>
  )
}
