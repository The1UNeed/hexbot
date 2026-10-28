import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Switch } from '../../components/ui/switch'
import { Textarea } from '../../components/ui/textarea'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import type { Bot, HeartbeatRun } from '../../lib/types'
import { useHeartbeat } from '../../stores/heartbeat'
import { useSettings } from '../../stores/settings'

import { cardClass, errorText, Group, Heading, Row } from './shared'

function at(iso: null | string | undefined, fallback: string): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : fallback
}

/**
 * The lines the heartbeat will check, as the daemon counts them: comments,
 * headings and empty list items left out.
 */
export function countChecks(text: string): number {
  return text
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !/^[-*+](\s*\[[ x]\])?$/.test(line)).length
}

function outcome(run: HeartbeatRun): string {
  if (run.status === 'running') {
    return 'Running'
  }

  if (run.status === 'failed') {
    return `Failed: ${run.summary}`
  }

  const said = run.messaged ? 'Posted in your chat' : 'Nothing to tell you'

  return run.summary ? `${said}. ${run.summary}` : said
}

/** A bot's heartbeat: its checklist, when it runs, and what came of it. */
export function HeartbeatTab({ bot }: { bot: Bot }) {
  const enabled = useSettings(state => state.settings?.heartbeat_enabled ?? true)
  const patch = useSettings(state => state.patch)
  const status = useHeartbeat(state => state.byBot[bot.name])
  const loadError = useHeartbeat(state => state.errors[bot.name])
  const refresh = useHeartbeat(state => state.refresh)
  const save = useHeartbeat(state => state.save)
  const runNow = useHeartbeat(state => state.runNow)
  const deleteEarlier = useHeartbeat(state => state.deleteEarlier)
  const [text, setText] = useState<null | string>(null)
  const [deleting, setDeleting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )

  useEffect(() => {
    void refresh(bot.name)
  }, [bot.name, refresh])

  // The bot may change its checklist from its chat while this is open.
  const saved = status?.text ?? null
  useEffect(() => setText(saved), [saved])

  const attempt = async (action: () => Promise<unknown>) => {
    try {
      setError(null)
      await action()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const name = bot.display_name
  const checks = countChecks(text ?? '')
  const cap = status?.cap ?? 4000

  return (
    <div>
      <Heading
        description={`Every ${status?.every_minutes ?? 30} minutes, day and night, ${name} works through this checklist on its own and writes to you in its chat only when something needs you.`}
      >
        Heartbeat
      </Heading>
      <div className="flex flex-col gap-6">
        <div>
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-[length:var(--text-meta)] font-medium text-muted">HEARTBEAT.md</p>
            <span className="text-[length:var(--text-meta)] text-muted">
              {checks === 0
                ? 'Nothing to check yet'
                : `${checks} ${checks === 1 ? 'check' : 'checks'}`}
            </span>
          </div>
          <div className={cn(cardClass, 'flex overflow-hidden')}>
            <Textarea
              aria-label="Heartbeat checklist"
              className="min-h-[16rem] flex-1 rounded-none bg-transparent px-4 py-3 font-mono text-[length:var(--text-secondary)] hover:bg-transparent focus-visible:bg-transparent"
              disabled={text === null}
              maxLength={cap}
              onBlur={() => {
                if (text !== null && text !== saved) {
                  void attempt(() => save(bot.name, text))
                }
              }}
              onChange={event => setText(event.target.value)}
              placeholder="- Has Sam replied to my email about the lease?"
              value={text ?? ''}
            />
          </div>
          <p className="mt-2 px-1 text-[length:var(--text-meta)] text-muted">
            One check per line, saved when you leave the field. {name} adds and removes lines too
            when you ask it in its chat to keep an eye on something.
          </p>
        </div>

        <Group footer="The heartbeat reads memory, connectors and the web. It changes nothing in your tools.">
          <Row
            control={
              <Switch
                aria-label="Run heartbeats"
                checked={enabled}
                onCheckedChange={checked =>
                  void attempt(async () => {
                    await patch({ heartbeat_enabled: checked })
                    await refresh(bot.name)
                  })
                }
              />
            }
            description="For every bot on this daemon."
            title="Run heartbeats"
          />
          <Row
            control={
              <span className="text-[length:var(--text-secondary)] text-muted">
                {status?.running
                  ? 'Running now'
                  : !enabled
                    ? 'Off'
                    : status?.empty
                      ? 'Add a check to start'
                      : at(status?.next_run_at, 'Not scheduled')}
              </span>
            }
            title="Next heartbeat"
          />
          <Row
            control={
              <Button
                busy={status?.running}
                disabled={!status || status.empty || text !== saved}
                onClick={() => void attempt(() => runNow(bot.name))}
                size="sm"
              >
                Run now
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

        <Group title="Recent">
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
                title={run.kind === 'manual' ? 'You asked' : 'Heartbeat'}
              />
            ))
          ) : (
            <Row title="No heartbeats yet" />
          )}
        </Group>

        {status?.earlier_checkins ? (
          <Group
            action={
              <Link
                className="text-[length:var(--text-secondary)] text-accent"
                params={{ bot: bot.name, section: status.earlier_checkins }}
                to="/b/$bot/s/$section"
              >
                Open
              </Link>
            }
            title="Earlier check-ins"
          >
            <Row
              control={
                deleting ? (
                  <div className="flex gap-2">
                    <Button
                      busy={removing}
                      disabled={removing}
                      onClick={() => {
                        setRemoving(true)
                        void attempt(() => deleteEarlier(bot.name)).finally(() => {
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
              description="What check-ins told you before the heartbeat replaced them."
              title="Delete earlier check-ins"
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
