import { Ellipsis, Monitor, SquareTerminal } from 'lucide-react'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Dialog } from '../../components/ui/dialog'
import { Menu } from '../../components/ui/menu'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { targetOrigin } from '../../lib/connection'
import { toMillis } from '../../lib/time'
import type { Bot, ComputerCursor, ComputerStatus, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useConnection } from '../../stores/connection'
import type { TranscriptMessage } from '../../stores/transcripts'
import type { SaveBot } from '../bot-settings/shared'
import { activityLabel, computerLabel } from '../conversation/steps'
import { StepRow } from '../conversation/work-status'

const clock = (call: ToolCall) =>
  call.startedAt > 0
    ? new Date(toMillis(call.startedAt)).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      })
    : undefined

const BUSY: Partial<Record<ComputerStatus['state'], string>> = {
  resetting: 'Resetting',
  restarting: 'Restarting',
  starting: 'Starting',
  stopping: 'Turning off'
}

/** A bot's cursor stays this long after its last action, then fades. */
const CURSOR_STAYS_S = 45

/** Clicks press the pointer and ring where they land; typing moves the face. */
const CLICKS = new Set(['click', 'double_click', 'middle_click', 'right_click'])
const TYPING = new Set(['key', 'type'])

/**
 * A link to the computer's screen through the daemon, renewed before it
 * expires. With `control` the screen takes clicks and keys; without, it
 * only shows them.
 */
function useScreen(live: boolean, control: boolean): null | string {
  const target = useConnection(state => state.target)
  // A restarted daemon forgets the old link.
  const epoch = useConnection(state => state.epoch)
  const view = useComputer(state => state.view)
  const [screen, setScreen] = useState<{ expires: number; src: string } | null>(null)
  const [renewals, setRenewals] = useState(0)

  useEffect(() => {
    setScreen(null)

    if (!live || !target) {
      return
    }

    let current = true

    void view(control).then(path => {
      if (current && path) {
        // A small watching screen needs no sound and fewer frames.
        const extra = control ? '' : '&audio=off&fps=12'
        setScreen({
          expires: Date.now() + 55 * 60_000,
          src: `${targetOrigin(target)}${path}${extra}`
        })
      }
    })

    return () => {
      current = false
    }
  }, [control, epoch, live, renewals, target, view])

  useEffect(() => {
    if (!screen) {
      return
    }

    const timer = setTimeout(() => setRenewals(count => count + 1), screen.expires - Date.now())

    return () => clearTimeout(timer)
  }, [screen])

  return screen?.src ?? null
}

/** Seconds since the epoch, moving on every few seconds while it matters. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    if (!running) {
      return
    }

    setNow(Date.now() / 1000)
    const timer = setInterval(() => setNow(Date.now() / 1000), 5000)

    return () => clearInterval(timer)
  }, [running])

  return now
}

const ARROW =
  'M4.5 3.2 20.4 10a.9.9 0 0 1-.1 1.7l-6.6 1.9-2 6.5a.9.9 0 0 1-1.7.1L3.2 4.5a.9.9 0 0 1 1.3-1.3Z'

/**
 * One bot's pointer: an arrow in its colour with its face beside it. It
 * glides to where the bot acts, presses and rings on a click, and its face
 * taps along while the bot types.
 */
function CursorMark({
  acting,
  bot,
  cursor,
  stale
}: {
  acting: boolean
  bot?: Bot
  cursor: ComputerCursor
  stale: boolean
}) {
  const name = bot?.display_name ?? cursor.bot
  const color = useFaceColor(bot, name) ?? '#3b82f6'
  const clicked = acting && CLICKS.has(cursor.action)
  const typing = acting && TYPING.has(cursor.action)

  return (
    <div
      aria-label={`${name}'s cursor`}
      className="hex-cursor"
      data-stale={stale}
      data-testid="computer-cursor"
      role="img"
      style={
        {
          '--hex-cursor': color,
          left: `${cursor.x * 100}%`,
          top: `${cursor.y * 100}%`
        } as CSSProperties
      }
    >
      <span className="hex-cursor-body">
        {clicked ? <span className="hex-cursor-ring" key={`ring-${cursor.at}`} /> : null}
        <svg
          aria-hidden
          className={cn('hex-cursor-arrow', clicked && 'hex-cursor-press')}
          key={`arrow-${cursor.at}`}
          viewBox="0 0 24 24"
        >
          <path d={ARROW} />
        </svg>
        <span className={cn('hex-cursor-face', typing && 'hex-cursor-typing')}>
          <Avatar
            {...botFace(bot)}
            className="size-full"
            mood={acting ? 'working' : 'idle'}
            name={name}
          />
        </span>
      </span>
    </div>
  )
}

/** Every bot that acted on the computer lately, where it last acted. Smaller on a small screen. */
function Cursors({ small = false, status }: { small?: boolean; status: ComputerStatus }) {
  const bots = useBots(state => state.byName)
  const cursors = status.cursors ?? []
  const now = useClock(cursors.length > 0)

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={small ? ({ '--hex-cursor-scale': 0.72 } as CSSProperties) : undefined}
    >
      {cursors.map(cursor => (
        <CursorMark
          acting={status.actor === cursor.bot}
          bot={bots[cursor.bot]}
          cursor={cursor}
          key={cursor.bot}
          stale={status.actor !== cursor.bot && now - cursor.at > CURSOR_STAYS_S}
        />
      ))}
    </div>
  )
}

function Frame({ control, src }: { control: boolean; src: string }) {
  return (
    <iframe
      allow="clipboard-read; clipboard-write; fullscreen; autoplay"
      className={cn('size-full border-0 bg-black', control ? '' : 'pointer-events-none')}
      key={src}
      src={src}
      tabIndex={control ? 0 : -1}
      title="Your bots' screen"
    />
  )
}

function useActorName(actor: null | string | undefined): null | string {
  return useBots(state => (actor ? (state.byName[actor]?.display_name ?? actor) : null))
}

/** One line under the screen: what is happening on it, in plain words. */
function caption(status: ComputerStatus, actor: null | string): string {
  if (BUSY[status.state]) {
    return `${BUSY[status.state]} your bots' computer`
  }

  if (status.control === 'user') {
    return 'You have control. Your bots wait until you give it back.'
  }

  if (actor && status.activity) {
    return `${actor} is ${computerLabel(status.activity, 'live').replace(/^\w/, c => c.toLowerCase())}`
  }

  return "Your bots' computer"
}

/**
 * The computer large, over the app: watch it, or take over and use it. Giving
 * it back, or closing the window, hands it back to the bots.
 */
function ComputerWindow({ onClose, status }: { onClose: () => void; status: ComputerStatus }) {
  const control = useComputer(state => state.control)
  const user = status.control === 'user'
  const src = useScreen(status.state === 'running', user)
  const actor = useActorName(status.actor)

  const close = () => {
    if (user) {
      void control('bot')
    }

    onClose()
  }

  return (
    <Dialog
      className="max-h-[94vh] w-[min(72rem,94vw)]"
      description={caption(status, actor)}
      onOpenChange={open => !open && close()}
      open
      title="Your bots' computer"
      toolbar={
        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <Button onClick={() => void control('bot')} size="sm" variant="primary">
              Give back
            </Button>
          ) : (
            <Button
              disabled={status.state !== 'running'}
              onClick={() => void control('user')}
              size="sm"
              variant="primary"
            >
              Take control
            </Button>
          )}
          <Button onClick={close} size="sm" variant="ghost">
            Close
          </Button>
        </div>
      }
    >
      <div className="px-6 pt-3 pb-6">
        <div
          className={cn(
            'relative aspect-[16/10] w-full overflow-hidden rounded-[14px] bg-black shadow-card',
            user ? 'ring-2 ring-info' : ''
          )}
        >
          {src ? <Frame control={user} src={src} /> : null}
          <Cursors status={status} />
        </div>
      </div>
    </Dialog>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid aspect-[16/10] w-full place-content-center justify-items-center gap-3 rounded-[16px] bg-foreground/[0.05] px-6 text-center">
      {children}
    </div>
  )
}

/** The bots' computer: its live screen, each bot's cursor, and its controls. */
function Screen({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const status = useComputer(state => state.status)
  const requestError = useComputer(state => state.error)
  const refresh = useComputer(state => state.refresh)
  const step = useComputer(state => state.step)
  const control = useComputer(state => state.control)
  const [open, setOpen] = useState(false)
  const enabled = bot.tools.includes('computer_use')
  const running = status?.state === 'running'
  const src = useScreen(running && enabled && !open, false)
  const actor = useActorName(status?.actor)
  const epoch = useConnection(state => state.epoch)

  useEffect(() => {
    void refresh()
  }, [epoch, refresh])

  // Nothing until the daemon answers; an older daemon has no computer.
  if (!status) {
    return null
  }

  if (!status.available) {
    return (
      <Placeholder>
        <Monitor className="text-muted" size={20} />
        <p className="max-w-64 text-[length:var(--text-secondary)] text-muted">
          To give your bots a computer, install Cua on the daemon's computer and start Docker.
        </p>
        <code className="rounded-[8px] bg-background px-2 py-1 text-[length:var(--text-meta)] shadow-card">
          uv tool install cua
        </code>
      </Placeholder>
    )
  }

  if (!enabled) {
    return (
      <Placeholder>
        <Monitor className="text-muted" size={20} />
        <p className="max-w-64 text-[length:var(--text-secondary)] text-muted">
          {bot.display_name} can work on your bots' computer: a Linux desktop you can watch and take
          over.
        </p>
        <Button
          onClick={() => void onSave({ tools: [...bot.tools, 'computer_use'] })}
          size="sm"
          variant="primary"
        >
          Turn on Computer use
        </Button>
      </Placeholder>
    )
  }

  const busy = BUSY[status.state]
  const error = status.error ?? requestError
  const lit = Boolean(status.actor) || status.control === 'user'

  const reset = async () => {
    if (
      await confirm({
        detail: 'Everything on it is erased, for every bot, and they get a fresh one.',
        title: "Reset your bots' computer?"
      })
    ) {
      void step('reset')
    }
  }

  return (
    <section className="grid grid-cols-1 gap-2.5">
      {running ? (
        <button
          aria-label="Open your bots' computer"
          className={cn(
            'hex-focus relative aspect-[16/10] w-full overflow-hidden rounded-[16px] bg-black shadow-card',
            lit ? 'ring-2 ring-info' : ''
          )}
          data-testid="computer-screen"
          onClick={() => setOpen(true)}
          type="button"
        >
          {src ? <Frame control={false} src={src} /> : null}
          {open ? null : <Cursors small status={status} />}
        </button>
      ) : (
        <Placeholder>
          <Monitor className="text-muted" size={20} />
          {busy ? (
            <p className="text-[length:var(--text-secondary)] text-muted">
              {busy}…
              {status.state === 'starting' ? (
                <span className="mt-1 block text-[length:var(--text-meta)]">
                  The first start downloads the computer, a few GB.
                </span>
              ) : null}
            </p>
          ) : (
            <>
              <p className="max-w-64 text-[length:var(--text-secondary)] text-muted">
                {status.state === 'absent'
                  ? 'Your bots get a computer the first time one needs it.'
                  : "Your bots' computer is off."}
              </p>
              <Button onClick={() => void step('start')} size="sm" variant="primary">
                Turn on
              </Button>
            </>
          )}
        </Placeholder>
      )}
      <div className="flex min-h-8 items-center gap-2 px-1">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[length:var(--text-secondary)]',
            lit ? 'text-foreground' : 'text-muted'
          )}
          data-testid="computer-caption"
        >
          {lit ? (
            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-info align-middle" />
          ) : null}
          {caption(status, actor)}
        </span>
        {running ? (
          status.control === 'user' ? (
            <Button onClick={() => void control('bot')} size="sm" variant="pill">
              Give back
            </Button>
          ) : (
            <Button
              onClick={() => {
                void control('user')
                setOpen(true)
              }}
              size="sm"
              variant="pill"
            >
              Take control
            </Button>
          )
        ) : null}
        <Menu
          items={[
            { disabled: !running, label: 'Open larger', onSelect: () => setOpen(true) },
            {
              disabled: !running || Boolean(busy),
              label: 'Restart',
              onSelect: () => void step('restart')
            },
            {
              disabled: !running || Boolean(busy),
              label: 'Turn off',
              onSelect: () => void step('stop')
            },
            { label: '', separator: true },
            {
              disabled: Boolean(busy) || status.state === 'absent',
              label: 'Reset…',
              onSelect: () => void reset()
            }
          ]}
          trigger={
            <button
              aria-label="Computer options"
              className="hex-focus grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground"
              type="button"
            >
              <Ellipsis size={16} />
            </button>
          }
        />
      </div>
      {error ? (
        <p className="px-1 text-[length:var(--text-meta)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {open && running ? <ComputerWindow onClose={() => setOpen(false)} status={status} /> : null}
    </section>
  )
}

/**
 * The bots' computer on top, then the bot's other tool calls in the section,
 * housekeeping included, newest first, each closed until clicked. Its work on
 * the computer shows on the screen instead, as its cursor.
 */
export function ComputerTab({
  bot,
  messages,
  onSave
}: {
  bot: Bot
  messages: TranscriptMessage[]
  onSave: SaveBot
}) {
  const calls = useMemo(
    () =>
      messages
        .flatMap(message => message.toolCalls)
        .filter(call => call.name !== 'computer_use')
        .reverse(),
    [messages]
  )

  const running = calls.find(call => call.status === 'running')
  const name = bot.display_name

  return (
    <div className="grid grid-cols-1 gap-5">
      <Screen bot={bot} onSave={onSave} />
      {calls.length ? (
        <div className="grid grid-cols-1 gap-3">
          {running ? (
            <div className="hex-fade flex items-center gap-2 px-1 text-[length:var(--text-secondary)]">
              <span className="size-1.5 shrink-0 rounded-full bg-info" />
              <span className="truncate">{activityLabel(running, name)}</span>
            </div>
          ) : null}
          <ul
            className="min-w-0 rounded-[16px] bg-background p-1.5 shadow-card"
            data-testid="computer-steps"
          >
            {calls.map(call => (
              <StepRow call={call} key={call.toolId} meta={clock(call)} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="grid justify-items-center gap-2 px-6 pt-2 text-center">
          <SquareTerminal className="text-muted" size={16} />
          <p className="max-w-60 text-[length:var(--text-secondary)] text-muted">
            When {name} runs a command, reads a page or edits a file, each step shows up here.
          </p>
        </div>
      )}
    </div>
  )
}
