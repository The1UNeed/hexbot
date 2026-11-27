import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import { ChatChooser } from '../app/chat-chooser'
import { ConnectionLost, useConnectionLost } from '../app/connection-lost'
import { UpdateInstalling, useUpdateInstalling } from '../app/update-installing'
import { cancelConfirm, ConfirmHost } from '../components/ui/confirm'
import { providersCheckRecovery, sectionsList, userMemoryGet } from '../lib/api'
import { getBridge, hasLocalRuntime } from '../lib/bridge'
import { getSupervisor, setLocalDaemonPort } from '../lib/connection'
import { OPEN_SECTION_EVENT } from '../lib/notify'
import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { sectionBot, useSections } from '../stores/sections'
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
  const epoch = useConnection(state => state.epoch)
  const location = useRouterState({ select: state => state.location })
  // The next location can change before Outlet switches to its new match.
  const pathname = useRouterState({ select: state => state.matches.at(-1)?.pathname })
  const pathnameRef = useRef(pathname)
  pathnameRef.current = pathname
  const theme = useUi(state => state.theme)
  const lost = useConnectionLost()
  const installing = useUpdateInstalling()

  const needsConnection = !target && pathname !== '/connect' && pathname !== '/onboarding'

  // A question belongs to the page and daemon that opened it.
  useEffect(() => cancelConfirm, [location, target, epoch])
  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    if (status === 'unauthorized') {
      void navigate({ to: '/connect', replace: true })
    } else if (needsConnection) {
      void navigate({ to: hasLocalRuntime() ? '/onboarding' : '/connect', replace: true })
    }
  }, [navigate, needsConnection, status])
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
  const botsLoaded = useBots(state => state.loaded)
  const lastRecoveryCheck = useRef(0)

  useEffect(() => {
    if (status !== 'connected') {
      lastRecoveryCheck.current = 0

      return
    }

    const check = () => {
      if (document.visibilityState === 'hidden') {
        return
      }

      const now = Date.now()

      if (now - lastRecoveryCheck.current < 2000) {
        return
      }

      const hasStopped = Object.values(useBots.getState().byName).some(
        bot => bot.status === 'stopped'
      )

      if (hasStopped) {
        lastRecoveryCheck.current = now
        void providersCheckRecovery().catch(() => undefined)
      }
    }

    if (botsLoaded) {
      check()
    }

    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)

    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [botsLoaded, status])
  useAboutYouGate()
  useEffect(() => bindAppUpdates(), [])
  useEffect(() => {
    // A notification click names the section it is about. Clicked as the app
    // starts, it waits for the sections list to name the bot.
    const openSection = (section: string) => {
      const inMainShell = () =>
        /^\/(?:b\/[^/]+\/s\/[^/]+|r\/[^/]+)$/.test(pathnameRef.current ?? '')

      const peerOf = (sectionId: string) => {
        const match = Object.values(useBots.getState().byName).find(
          item => item.status_detail?.peer_bot && item.status_detail.section_id === sectionId
        )

        return match?.status_detail?.peer_bot
          ? { bot: match.name, peer: match.status_detail.peer_bot }
          : undefined
      }

      const open = (bot: string, peer?: null | string) => {
        if (peer && inMainShell()) {
          useUi.getState().openThread({ bot, peer, sectionId: section })

          return
        }

        // Clicking a notification for the covered chat must dismiss any open peer thread overlay.
        useUi.getState().closeThread()
        void navigate({ params: { bot, section }, to: '/b/$bot/s/$section' })
      }

      const knownPeer = peerOf(section)

      if (knownPeer) {
        open(knownPeer.bot, knownPeer.peer)

        return
      }

      const bot = sectionBot(section)

      if (bot) {
        open(bot)

        return
      }

      let waiting = true

      const found = (bot: string | undefined, peer?: null | string) => {
        if (bot && waiting) {
          stop()
          open(bot, peer)
        }
      }

      // A thread is in no list, and a bot waiting in two reports only one: ask the
      // daemon, and again once a connection that was not up yet comes back.
      const lookup = () =>
        void sectionsList({ include_archived: true, include_threads: true })
          .then(result => {
            const row = result.sections?.find(item => item.id === section)
            found(row?.bot, row?.peer_bot)
          })
          .catch(() => undefined)

      const check = () => {
        const peer = peerOf(section)

        if (peer) {
          found(peer.bot, peer.peer)
        } else {
          found(sectionBot(section))
        }
      }

      const offSections = useSections.subscribe(check)
      const offBots = useBots.subscribe(check)

      const offConnection = useConnection.subscribe((state, previous) => {
        if (state.status === 'connected' && previous.status !== 'connected') {
          lookup()
        }
      })

      const stop = () => {
        waiting = false
        offSections()
        offBots()
        offConnection()
      }

      lookup()
      window.setTimeout(stop, 60_000)
    }

    // A browser tab's own notifications (lib/notify.ts) land here.
    const fromPage = (event: Event) => {
      const section = (event as CustomEvent<string>).detail

      if (typeof section === 'string') {
        openSection(section)
      }
    }

    window.addEventListener(OPEN_SECTION_EVENT, fromPage)
    // The app menu's "Settings…" and "Check for Updates…" items land here;
    // pairing links are handled by the connect route.
    const bridge = getBridge()

    const stopBridge = bridge?.onNavigate?.(url => {
      const tab = /^\/settings\/([a-z]+)$/.exec(url)?.[1]

      if (tab) {
        void navigate({ to: '/settings/$tab', params: { tab } })
      } else {
        openSection(url)
      }
    })

    return () => {
      window.removeEventListener(OPEN_SECTION_EVENT, fromPage)
      stopBridge?.()
    }
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
        {needsConnection ? null : <Outlet />}
        <ChatChooser />
        <ConfirmHost blocked={lost || installing} />
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
