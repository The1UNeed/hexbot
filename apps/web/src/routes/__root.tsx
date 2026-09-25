import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import { ConnectionLost, useConnectionLost } from '../app/connection-lost'
import { UpdateInstalling, useUpdateInstalling } from '../app/update-installing'
import { userMemoryGet } from '../lib/api'
import { getBridge, hasLocalRuntime } from '../lib/bridge'
import { getSupervisor, setLocalDaemonPort } from '../lib/connection'
import { useConnection } from '../stores/connection'
import { applyTheme, useUi } from '../stores/ui'
import { bindAppUpdates } from '../stores/updates'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout() {
  const navigate = useNavigate()
  const target = useConnection(state => state.target)
  const status = useConnection(state => state.status)
  const attempt = useConnection(state => state.attempt)
  const daemon = useConnection(state => state.daemon)
  const theme = useUi(state => state.theme)
  const lost = useConnectionLost()
  const installing = useUpdateInstalling()

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    if (status === 'unauthorized') {
      void navigate({ to: '/connect' })
    }
  }, [navigate, status])
  useEffect(() => {
    if (target) {
      // The full package owns its daemon: make sure it is running before
      // connecting, so a relaunch does not land on "could not be reached".
      const startLocal =
        target.kind === 'local' && !target.origin && hasLocalRuntime()
          ? getBridge()!
              .daemon.start()
              .then(status => setLocalDaemonPort(status.port))
              .catch(() => undefined)
          : Promise.resolve()

      void startLocal.then(() => getSupervisor().start(target))
    }
  }, [target])
  useEffect(() => () => getSupervisor().stop(), [])
  useAboutYouGate()
  useEffect(() => bindAppUpdates(), [])
  useEffect(() => {
    // The app menu's "Settings…" and "Check for Updates…" items land here;
    // pairing links are handled by the connect route.
    const bridge = getBridge()

    if (!bridge?.onNavigate) {
      return
    }

    return bridge.onNavigate(url => {
      const tab = /^\/settings\/([a-z]+)$/.exec(url)?.[1]

      if (tab) {
        void navigate({ to: '/settings/$tab', params: { tab } })
      }
    })
  }, [navigate])

  return (
    <>
      <div
        className="sr-only"
        data-connection-state={status}
        data-testid="root-connection-status"
        role="status"
      >
        {daemon?.daemon_name ?? status}
        {attempt > 0 ? `, attempt ${attempt}` : ''}
      </div>
      <div className="contents" inert={lost || installing}>
        <Outlet />
      </div>
      {lost && !installing ? <ConnectionLost /> : null}
      {installing ? <UpdateInstalling /> : null}
    </>
  )
}

/**
 * On startup, a user whose About you was never written is sent to the init
 * page in onboarding, which asks once and then opens their first section.
 * Checked once per connection, and never from onboarding or pairing, which
 * handle it themselves.
 */
function useAboutYouGate(): void {
  const navigate = useNavigate()
  const status = useConnection(state => state.status)
  const pathname = useRouterState({ select: state => state.location.pathname })
  const checked = useRef(false)

  useEffect(() => {
    if (status !== 'connected') {
      checked.current = false

      return
    }

    if (checked.current || pathname.startsWith('/onboarding') || pathname.startsWith('/connect')) {
      return
    }

    checked.current = true
    void userMemoryGet()
      .then(memory => {
        if (memory.updated_at === null) {
          void navigate({ to: '/onboarding' })
        }
      })
      .catch(() => undefined)
  }, [navigate, pathname, status])
}
