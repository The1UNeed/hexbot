/**
 * The roster's update pill (T3 Code's sidebar update pill and capsule).
 * Hidden until there is something to do. With a daemon that has Update
 * everything it says "Update" for the daemon and every app at once, then
 * shows the run in place: progress, "Restart in 5s · Later", the result.
 * An older daemon keeps the app's own update and "Update daemon".
 */

import { useNavigate } from '@tanstack/react-router'
import { CircleArrowUp, Download, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Spinner } from '../components/ui/spinner'
import { getBridge, updateAction, type UpdateState } from '../lib/bridge'
import { cn } from '../lib/cn'
import { describeCapsule } from '../lib/update-everything'
import { daemonBehind } from '../lib/version-skew'
import { useConnection } from '../stores/connection'
import { useUpdateRun } from '../stores/update-run'
import { type DaemonUpdate, useUpdates } from '../stores/updates'

import { ConfirmUpdate, installTarget } from './confirm-update'
import { UpdateEverythingDialog } from './update-everything'

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

    if (app.status === 'installing') {
      return {
        action: null,
        busy: true,
        label: 'Installing update',
        title: `Installing Hexbot ${app.downloadedVersion ?? ''}`.trim()
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
        label: app.errorContext === 'download' ? 'Retry update' : 'Update',
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

const pillClass =
  'hex-no-drag inline-flex h-8 items-center gap-2 rounded-panel border border-border px-3 text-[length:var(--text-secondary)] font-medium whitespace-nowrap text-foreground transition-colors hover:bg-surface-2 disabled:opacity-60'

export function UpdatePill({ className }: { className?: string }) {
  const navigate = useNavigate()
  const app = useUpdates(state => state.app)
  const daemonUpdate = useUpdates(state => state.daemon)
  const daemon = useConnection(state => state.daemon)
  const everything = useUpdateRun()
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [planning, setPlanning] = useState(false)
  const bridge = getBridge()
  const settings = () => void navigate({ to: '/settings/$tab', params: { tab: 'updates' } })

  // Update everything: one pill for the daemon and every app.
  if (everything.supported) {
    const { countdown, plan, run } = everything
    const capsule = describeCapsule(run, countdown)

    if (capsule || run?.result || plan?.actionable) {
      const counting = run?.phase === 'counting-down'
      const busy = !!capsule && !counting
      const label = capsule ?? (run?.result ? run.result.message : 'Update')

      return (
        <>
          <button
            className={cn(pillClass, className)}
            data-testid="update-pill"
            onClick={() => {
              if (counting) {
                everything.later()
              } else if (run) {
                settings()
              } else {
                setPlanning(true)
              }
            }}
            title={
              counting
                ? 'Restart this app now to finish, or Later to keep this version'
                : (run?.result?.message ?? plan?.summary ?? undefined)
            }
            type="button"
          >
            {busy ? <Spinner size="sm" /> : <CircleArrowUp aria-hidden size={14} />}
            <span className="truncate">{label}</span>
          </button>
          <UpdateEverythingDialog onClose={() => setPlanning(false)} open={planning} />
        </>
      )
    }
  }

  const pill = describePill(
    app,
    daemonUpdate,
    bridge?.version ?? null,
    everything.supported ? null : (daemon?.version ?? null)
  )

  if (!pill) {
    return null
  }

  const run = (call: () => Promise<unknown>) => {
    setPending(true)
    void call()
      .catch(() => undefined)
      .finally(() => setPending(false))
  }

  const act = () => {
    if (pill.action === 'settings') {
      settings()

      return
    }

    if (!pill.action || !bridge || pending) {
      return
    }

    if (pill.action === 'install') {
      setConfirming(true)

      return
    }

    run(() => bridge.updater.download())
  }

  const Icon =
    pill.action === 'install' ? RefreshCw : pill.action === 'download' ? Download : CircleArrowUp

  return (
    <>
      <button
        className={cn(pillClass, className)}
        data-testid="update-pill"
        disabled={pill.busy || pending}
        onClick={act}
        title={pill.title}
        type="button"
      >
        {pill.busy || pending ? <Spinner size="sm" /> : <Icon aria-hidden size={14} />}
        <span className="truncate">{pill.label}</span>
      </button>
      <ConfirmUpdate
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          if (bridge) {
            run(() => bridge.updater.install())
          }
        }}
        version={confirming ? installTarget(app) : null}
      />
    </>
  )
}
