/**
 * The roster's update pill (T3 Code's sidebar update pill). Hidden until
 * there is something to do: download an app update, restart into one, or
 * update a daemon that is behind this app. Progress shows in place.
 */

import { useNavigate } from '@tanstack/react-router'
import { CircleArrowUp, Download, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Spinner } from '../components/ui/spinner'
import { getBridge, updateAction, type UpdateState } from '../lib/bridge'
import { cn } from '../lib/cn'
import { daemonBehind } from '../lib/version-skew'
import { useConnection } from '../stores/connection'
import { type DaemonUpdate, useUpdates } from '../stores/updates'

export interface PillContent {
  action: 'download' | 'install' | 'settings' | null
  busy: boolean
  label: string
  title: string
}

/** What the pill shows, or null when everything is current. App updates come first. */
export function describePill(
  app: null | UpdateState,
  daemonUpdate: DaemonUpdate | null,
  appVersion: null | string,
  daemonVersion: null | string
): PillContent | null {
  if (app) {
    const action = updateAction(app)

    if (app.status === 'downloading') {
      return {
        action: null,
        busy: true,
        label: `Downloading ${app.percent ?? 0}%`,
        title: `Downloading Hexbot ${app.availableVersion ?? ''}`.trim()
      }
    }

    if (action === 'install') {
      return {
        action: 'install',
        busy: false,
        label: 'Restart to update',
        title: `Hexbot ${app.downloadedVersion} is downloaded. Restart to install it.`
      }
    }

    if (action === 'download') {
      return {
        action: 'download',
        busy: false,
        label: app.errorContext === 'download' ? 'Retry download' : 'Download update',
        title:
          app.errorContext === 'download'
            ? `Download failed: ${app.message ?? 'unknown error'}`
            : `Hexbot ${app.availableVersion} is available.`
      }
    }
  }

  if (daemonUpdate) {
    if (daemonUpdate.status === 'failed') {
      return {
        action: 'settings',
        busy: false,
        label: 'Daemon update failed',
        title: daemonUpdate.message ?? 'The daemon could not update.'
      }
    }

    return {
      action: 'settings',
      busy: true,
      label: 'Updating daemon',
      title: `Updating the daemon to ${daemonUpdate.target}.`
    }
  }

  if (daemonBehind(appVersion, daemonVersion)) {
    return {
      action: 'settings',
      busy: false,
      label: 'Update daemon',
      title: `The daemon runs ${daemonVersion}; this app is ${appVersion}.`
    }
  }

  return null
}

export function UpdatePill({ className }: { className?: string }) {
  const navigate = useNavigate()
  const app = useUpdates(state => state.app)
  const daemonUpdate = useUpdates(state => state.daemon)
  const daemon = useConnection(state => state.daemon)
  const [pending, setPending] = useState(false)
  const bridge = getBridge()
  const pill = describePill(app, daemonUpdate, bridge?.version ?? null, daemon?.version ?? null)

  if (!pill) {
    return null
  }

  const act = () => {
    if (pill.action === 'settings') {
      void navigate({ to: '/settings/$tab', params: { tab: 'updates' } })

      return
    }

    if (!pill.action || !bridge || pending) {
      return
    }

    setPending(true)
    const run = pill.action === 'download' ? bridge.updater.download() : bridge.updater.install()

    void run.catch(() => undefined).finally(() => setPending(false))
  }

  const Icon =
    pill.action === 'install' ? RefreshCw : pill.action === 'download' ? Download : CircleArrowUp

  return (
    <button
      className={cn(
        'hex-no-drag inline-flex h-8 items-center gap-2 rounded-panel border border-border px-3 text-[length:var(--text-secondary)] font-medium whitespace-nowrap text-foreground transition-colors hover:bg-surface-2 disabled:opacity-60',
        className
      )}
      data-testid="update-pill"
      disabled={pill.busy || pending}
      onClick={act}
      title={pill.title}
      type="button"
    >
      {pill.busy || pending ? <Spinner size="sm" /> : <Icon aria-hidden size={14} />}
      <span className="truncate">{pill.label}</span>
    </button>
  )
}
