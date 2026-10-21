import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'
import { getBridge } from '../../lib/bridge'
import type { Bot, CheckinRun } from '../../lib/types'
import { useCheckins } from '../../stores/checkins'
import { useSettings } from '../../stores/settings'

import { errorText, Group, Heading, Row } from './shared'

const EVERY = [15, 30, 60, 120, 240]

function everyLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60

    return hours === 1 ? 'Every hour' : `Every ${hours} hours`
  }

  return `Every ${minutes} minutes`
}

function at(iso: null | string | undefined, fallback: string): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : fallback
}

const KIND: Record<CheckinRun['kind'], string> = {
  heartbeat: 'Regular check-in',
  manual: 'You asked',
  wakeup: 'Wake-up'
}

function outcome(run: CheckinRun): string {
  if (run.status === 'running') {
    return 'Running'
  }

  if (run.status === 'failed') {
    return `Failed: ${run.summary}`
  }

  return run.messaged ? 'Messaged you' : 'Nothing to tell you'
}

/** The primary bot's check-ins: when it looks on its own, and what came of it. */
export function CheckinsTab({ bot }: { bot: Bot }) {
  const settings = useSettings(state => state.settings)
  const patch = useSettings(state => state.patch)
  const status = useCheckins(state => state.status)
  const loadError = useCheckins(state => state.error)
  const refresh = useCheckins(state => state.refresh)
  const runNow = useCheckins(state => state.runNow)
  const cancel = useCheckins(state => state.cancel)
  const deleteSection = useCheckins(state => state.deleteSection)
  const [deleting, setDeleting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The next check-in moves with the schedule.
  const change = (patchSettings: Parameters<typeof patch>[0]) =>
    attempt(async () => {
      await patch(patchSettings)
      await refresh()
    })

  const attempt = async (action: () => Promise<unknown>) => {
    try {
      setError(null)
      await action()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const enabled = settings?.checkin_enabled ?? status?.enabled ?? true
  const every = settings?.checkin_every_minutes ?? status?.every_minutes ?? 60
  const [from, to] = (settings?.checkin_hours ?? status?.hours ?? '08:00-22:00').split('-')

  const everyOptions = (
    EVERY.includes(every) ? EVERY : [...EVERY, every].sort((a, b) => a - b)
  ).map(minutes => ({ label: everyLabel(minutes), value: String(minutes) }))

  // Both ends save together, so a window can turn around (08:00 to 22:00
  // into 22:00 to 08:00) through a moment when both ends match.
  const saved = `${from}-${to}`
  const [hours, setHours] = useState({ from, to })

  useEffect(() => setHours({ from, to }), [from, to])

  const saveHours = () => {
    const next = `${hours.from}-${hours.to}`

    if (/^\d\d:\d\d-\d\d:\d\d$/.test(next) && hours.from !== hours.to && next !== saved) {
      void change({ checkin_hours: next })
    }
  }

  const name = bot.display_name

  return (
    <div>
      <Heading
        description={`${name} looks at what's going on, on its own, and messages you only when something needs you.`}
      >
        Check-ins
      </Heading>
      <div className="flex flex-col gap-6">
        <Group
          footer={`Each check-in reads ${name}'s memory and what its connectors show, like your calendar or Notion, with your keys.`}
        >
          <Row
            control={
              <Switch
                aria-label="Check in on its own"
                checked={enabled}
                onCheckedChange={checked => void change({ checkin_enabled: checked })}
              />
            }
            title="Check in on its own"
          />
          <Row
            control={
              <div className="w-40">
                <Select
                  disabled={!enabled}
                  label="How often"
                  onValueChange={value => void change({ checkin_every_minutes: Number(value) })}
                  options={everyOptions}
                  value={String(every)}
                />
              </div>
            }
            title="How often"
          />
          <Row
            control={
              <div className="flex items-center gap-2">
                <Input
                  aria-label="From"
                  className="w-28"
                  disabled={!enabled}
                  onBlur={saveHours}
                  onChange={event => setHours({ ...hours, from: event.target.value })}
                  type="time"
                  value={hours.from}
                />
                <span className="text-muted">to</span>
                <Input
                  aria-label="To"
                  className="w-28"
                  disabled={!enabled}
                  onBlur={saveHours}
                  onChange={event => setHours({ ...hours, to: event.target.value })}
                  type="time"
                  value={hours.to}
                />
              </div>
            }
            description="Regular check-ins stay inside these hours, in the daemon's time zone. Wake-ups run at their own time."
            title="Hours"
          />
          <Row
            control={
              <span className="text-[length:var(--text-secondary)] text-muted">
                {status?.running
                  ? 'Running now'
                  : enabled
                    ? at(
                        status?.next_run_at,
                        status?.bot ? 'Not scheduled' : 'Choose a primary bot'
                      )
                    : 'Off'}
              </span>
            }
            title="Next check-in"
          />
          <Row
            control={
              <Button
                busy={status?.running}
                disabled={!status?.bot}
                onClick={() => void attempt(runNow)}
                size="sm"
              >
                Check in now
              </Button>
            }
            title="Run one now"
          />
          {/* Browsers notify only from HTTPS or this computer, not a LAN address. */}
          {!getBridge() && permission !== 'unsupported' && !window.isSecureContext ? (
            <Row
              description="Browsers show notifications only for HTTPS pages. Open Hexbot through Hex Connect, use the Hexbot app, or let your phone notify you."
              title="No notifications in this browser"
            />
          ) : null}
          {!getBridge() && permission === 'default' && window.isSecureContext ? (
            <Row
              control={
                <Button
                  onClick={() =>
                    void Notification.requestPermission().then(result => setPermission(result))
                  }
                  size="sm"
                >
                  Allow
                </Button>
              }
              description="Show a notification in this browser when the tab is in the background."
              title="Notify me here"
            />
          ) : null}
        </Group>

        <Group
          footer={`${name} sets these when it learns about something with a time to it, like a deadline.`}
          title="Wake-ups"
        >
          {status?.wakeups.length ? (
            status.wakeups.map(wakeup => (
              <Row
                control={
                  <Button onClick={() => void attempt(() => cancel(wakeup.id))} size="sm">
                    Cancel
                  </Button>
                }
                description={wakeup.note}
                key={wakeup.id}
                title={wakeup.local}
              />
            ))
          ) : (
            <Row title="None waiting" />
          )}
        </Group>

        <Group
          action={
            status?.section_id ? (
              <Link
                className="text-[length:var(--text-secondary)] text-accent"
                params={{ bot: bot.name, section: status.section_id }}
                to="/b/$bot/s/$section"
              >
                Open Check-ins
              </Link>
            ) : null
          }
          title="Recent"
        >
          {status?.recent.length ? (
            status.recent.map(run => (
              <Row
                control={
                  <span className="text-[length:var(--text-secondary)] text-muted">
                    {at(run.started_at, '')}
                  </span>
                }
                description={outcome(run)}
                key={run.id}
                title={KIND[run.kind]}
              />
            ))
          ) : (
            <Row title="No check-ins yet" />
          )}
        </Group>
        {status?.section_id ? (
          <Group>
            <Row
              control={
                deleting ? (
                  <div className="flex gap-2">
                    <Button
                      busy={removing}
                      disabled={removing}
                      onClick={() => {
                        setRemoving(true)
                        void attempt(deleteSection).finally(() => {
                          setRemoving(false)
                          setDeleting(false)
                        })
                      }}
                      size="sm"
                      variant="danger"
                    >
                      Delete
                    </Button>
                    <Button onClick={() => setDeleting(false)} size="sm" variant="ghost">
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button onClick={() => setDeleting(true)} size="sm" variant="danger">
                    Delete
                  </Button>
                )
              }
              description="Deletes what check-ins told you. The next check-in message starts it again."
              title="Delete Check-ins"
            />
          </Group>
        ) : null}
        {error || loadError ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {error ?? loadError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
