/**
 * Update everything (docs/channels.md, "Updating everything at once"): the
 * rows the run updates, the dialog that confirms it, the Settings group, and
 * the "Restart in 10s · Later" notice on an app the run reached. T3 Code's
 * UpdateEverythingDialog and its capsule.
 */

import { Check, CircleAlert, CircleDashed, Clock, Minus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { Spinner } from '../components/ui/spinner'
import { getBridge } from '../lib/bridge'
import { cn } from '../lib/cn'
import { describeCapsule, type PlanRow, type RunRow } from '../lib/update-everything'
import { useUpdateRun } from '../stores/update-run'
import { useUpdates } from '../stores/updates'

import { Group, Row } from './bot-settings/shared'

function detail(row: PlanRow | RunRow): string {
  if ('status' in row && row.status !== 'waiting' && row.message) {
    return row.message
  }

  if (row.skip) {
    return row.from ? `${row.from} · ${row.skip}` : row.skip
  }

  const to = row.to === 'newest' || !row.to ? 'the newest build' : row.to
  const track = row.track ? ` on ${row.track === 'nightly' ? 'Nightly' : 'Stable'}` : ''

  return `${row.from} → ${to}${track}`
}

function StatusIcon({ row }: { row: PlanRow | RunRow }) {
  const status = 'status' in row ? row.status : row.skip ? 'skipped' : 'waiting'

  if (status === 'preparing' || status === 'updating') {
    return <Spinner size="sm" />
  }

  const Icon =
    status === 'done' || status === 'ready'
      ? Check
      : status === 'failed'
        ? CircleAlert
        : status === 'later'
          ? Clock
          : status === 'skipped'
            ? Minus
            : CircleDashed

  return (
    <Icon
      aria-hidden
      className={cn(status === 'failed' ? 'text-danger' : 'text-muted')}
      size={16}
    />
  )
}

/** One line per machine: the daemon, this app, each other app. */
export function UpdateRows({ rows }: { rows: (PlanRow | RunRow)[] }) {
  return (
    <>
      {rows.map(row => (
        <Row
          control={<StatusIcon row={row} />}
          description={detail(row)}
          key={row.key}
          title={row.label}
        />
      ))}
    </>
  )
}

export function UpdateEverythingDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const plan = useUpdateRun(state => state.plan)
  const start = useUpdateRun(state => state.start)

  return (
    <Dialog
      description={plan?.blocked ?? plan?.summary}
      onOpenChange={value => !value && onClose()}
      open={open}
      title="Update everything"
    >
      <div className="space-y-4 px-6 pt-3 pb-5">
        <Group footer="The daemon restarts first and goes back to its version if the new one can't start. Every other app shows Restart in 10s · Later. This app restarts last.">
          <UpdateRows rows={plan?.rows ?? []} />
        </Group>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!plan?.actionable}
            onClick={() => {
              onClose()
              void start()
            }}
            variant="primary"
          >
            Update
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Settings, Updates: every machine, its version and state, and the one button. */
export function UpdateEverythingGroup() {
  const plan = useUpdateRun(state => state.plan)
  const run = useUpdateRun(state => state.run)
  const countdown = useUpdateRun(state => state.countdown)
  const dismiss = useUpdateRun(state => state.dismiss)
  const refresh = useUpdateRun(state => state.refresh)
  const [open, setOpen] = useState(false)
  const running = !!run && !run.result

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <Group
        action={
          run?.result ? (
            <Button onClick={dismiss} size="sm">
              Dismiss
            </Button>
          ) : (
            <Button
              busy={running}
              disabled={running || !plan?.actionable}
              onClick={() => setOpen(true)}
              size="sm"
              variant="primary"
            >
              Update everything
            </Button>
          )
        }
        description={
          run?.result?.message ??
          describeCapsule(run, countdown) ??
          plan?.blocked ??
          plan?.summary
        }
        title="Everything"
      >
        <UpdateRows rows={run?.rows ?? plan?.rows ?? []} />
      </Group>
      <UpdateEverythingDialog onClose={() => setOpen(false)} open={open} />
    </>
  )
}

/**
 * On an app another client's run reached: the update is downloaded and
 * installs when the countdown ends, unless the user says Later. The main
 * process keeps the deadline, so this only shows it.
 */
export function RestartCountdown() {
  const remote = useUpdates(state => state.remote)
  const [now, setNow] = useState(() => Date.now())
  const counting = remote?.state === 'countdown' && remote.installsAt !== null

  useEffect(() => {
    if (!counting) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 250)

    return () => clearInterval(timer)
  }, [counting])

  if (!counting || !remote) {
    return null
  }

  const seconds = Math.max(0, Math.ceil(((remote.installsAt ?? now) - now) / 1000))

  return (
    <div
      className="hex-glass-strong fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-panel px-4 py-3 text-[length:var(--text-secondary)]"
      data-testid="restart-countdown"
      role="status"
    >
      <span>
        Hexbot {remote.version} is ready. Restart in {seconds}s
      </span>
      <Button onClick={() => void getBridge()?.updater.cancel?.(remote.requestId, true)} size="sm">
        Later
      </Button>
    </div>
  )
}
