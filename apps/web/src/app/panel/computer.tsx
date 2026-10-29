import { Ellipsis, Monitor } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { Avatar, useFaceColor } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Dialog } from '../../components/ui/dialog'
import { Menu, MenuCheckIcon } from '../../components/ui/menu'
import { botFace } from '../../lib/avatar-builder'
import { cn } from '../../lib/cn'
import { targetOrigin } from '../../lib/connection'
import type { Bot, ComputerCursor, ComputerQuality, ComputerStatus } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useConnection } from '../../stores/connection'
import { useUi } from '../../stores/ui'
import type { SaveBot } from '../bot-settings/shared'
import { computerLabel } from '../conversation/steps'

const BUSY: Partial<Record<ComputerStatus['state'], string>> = {
  resetting: 'Resetting',
  restarting: 'Restarting',
  starting: 'Starting',
  stopping: 'Turning off'
}

/** The screen's quality on this device, as the menu lists it. */
const QUALITIES: { label: string; value: ComputerQuality }[] = [
  { label: 'Auto', value: 'auto' },
  { label: '1080p · 60 fps', value: '1080p60' },
  { label: '1080p · 30 fps', value: '1080p30' },
  { label: '720p · 60 fps', value: '720p60' },
  { label: '720p · 30 fps', value: '720p30' }
]

/**
 * Browsers play the screen's video only on a secure page: HTTPS, or the
 * daemon's own computer. A daemon reached at a plain http:// address on the
 * network, as LAN pairing and Tailscale do, cannot show it.
 */
export function screenPlays(origin: string): boolean {
  const { hostname, protocol } = new URL(origin)

  return (
    protocol === 'https:' ||
    ['127.0.0.1', '[::1]', 'localhost'].includes(hostname) ||
    hostname.endsWith('.localhost')
  )
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
  // After a reconnect the old link may be gone (a restart, a reset meanwhile);
  // a new one waits for fresh status, so a hold given up is not taken again.
  const connects = useConnection(state => state.connects)
  const read = useComputer(state => state.read)
  const view = useComputer(state => state.view)
  const quality = useUi(state => state.computerQuality)
  const [screen, setScreen] = useState<{ expires: number; src: string } | null>(null)
  const [renewals, setRenewals] = useState(0)

  useEffect(() => {
    // A new link for the same screen, as taking control or giving it back
    // asks for, leaves the old one up until it arrives.
    if (!live || !target || read !== connects || !screenPlays(targetOrigin(target))) {
      setScreen(null)

      return
    }

    let current = true

    void view(control, quality).then(path => {
      if (current && path) {
        // A watching screen needs no sound. The daemon sets size and frame rate.
        const extra = control ? '' : '&audio=none'
        setScreen({
          expires: Date.now() + 55 * 60_000,
          src: `${targetOrigin(target)}${path}${extra}`
        })
      }
    })

    return () => {
      current = false
    }
  }, [connects, control, live, quality, read, renewals, target, view])

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

/** A screen that says nothing about its state, from an older daemon, takes over after this. */
const QUIET_SCREEN_MS = 4000
/** A screen that is still connecting takes over after this, so its error shows. */
const SLOW_SCREEN_MS = 15_000

/**
 * The screen at `src`. A new link loads under the screen on show and takes
 * its place once its picture is up, so taking control or giving it back
 * never blanks it. Frames keep their place in the page, since moving one
 * would reload it.
 */
function Frames({ control, src }: { control: boolean; src: null | string }) {
  // The first is on show; a second is loading under it.
  const [frames, setFrames] = useState<{ control: boolean; src: string }[]>([])
  const pending = useRef<HTMLIFrameElement>(null)
  const next = frames[1]?.src

  if (src ? frames.at(-1)?.src !== src : frames.length > 0) {
    setFrames(
      !src
        ? []
        : frames[0]?.src === src
          ? frames.slice(0, 1)
          : [...frames.slice(0, 1), { control, src }]
    )
  }

  useEffect(() => {
    if (!next) {
      return
    }

    const show = () => setFrames(current => (current[1]?.src === next ? [current[1]] : current))
    let timer = setTimeout(show, QUIET_SCREEN_MS)

    const listen = (event: MessageEvent) => {
      const status = (event.data as { status?: string; type?: string } | null) ?? {}

      if (
        event.source !== pending.current?.contentWindow ||
        status.type !== 'hexbot.computer.screen'
      ) {
        return
      }

      clearTimeout(timer)

      if (status.status === 'streaming' || status.status === 'failed') {
        show()
      } else {
        timer = setTimeout(show, SLOW_SCREEN_MS)
      }
    }

    window.addEventListener('message', listen)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('message', listen)
    }
  }, [next])

  return (
    <div className="absolute inset-0 isolate">
      {frames.map((frame, index) => {
        // Only the current link takes clicks; one given back no longer can.
        const input = index === 0 && frame.control && frame.src === src

        return (
          <iframe
            allow="clipboard-read; clipboard-write; fullscreen; autoplay"
            aria-hidden={index > 0 || undefined}
            className={cn(
              'absolute inset-0 size-full border-0 bg-black',
              index === 0 ? 'z-[1]' : '',
              input ? '' : 'pointer-events-none'
            )}
            key={frame.src}
            ref={index === 1 ? pending : undefined}
            src={frame.src}
            tabIndex={input ? 0 : -1}
            title="Your bots' screen"
          />
        )
      })}
    </div>
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
  // Closing the window, or the panel going away under it, hands it back,
  // once a take-over still on its way has landed.
  useEffect(
    () => () => {
      // Only to the daemon that has it: a switch to another one leaves it be.
      const target = useConnection.getState().target

      void useComputer.getState().taking.then(() => {
        if (
          useConnection.getState().target === target &&
          useComputer.getState().status?.control === 'user'
        ) {
          void useComputer.getState().control('bot')
        }
      })
    },
    []
  )

  return (
    <Dialog
      className="max-h-[94vh] w-[min(72rem,94vw)]"
      description={caption(status, actor)}
      onOpenChange={open => !open && onClose()}
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
          <Button onClick={onClose} size="sm" variant="ghost">
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
          <Frames control={user} src={src} />
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
  // It keeps playing while the window is open, so it is there when it closes.
  const src = useScreen(running && enabled, false)
  const actor = useActorName(status?.actor)
  const connects = useConnection(state => state.connects)
  const target = useConnection(state => state.target)
  const plays = !target || screenPlays(targetOrigin(target))
  const quality = useUi(state => state.computerQuality)
  const setQuality = useUi(state => state.setComputerQuality)

  useEffect(() => {
    void refresh()
  }, [connects, refresh])

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
      {running && !plays ? (
        <Placeholder>
          <Monitor className="text-muted" size={20} />
          <p
            className="max-w-64 text-[length:var(--text-secondary)] text-muted"
            data-testid="computer-insecure"
          >
            Your bots' screen plays only over a secure connection, and this one is plain HTTP.
            Connect through Hex Connect, or open Hexbot on the daemon's computer, to watch it.
          </p>
        </Placeholder>
      ) : running ? (
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
          <Frames control={false} src={src} />
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
        {running && (plays || status.control === 'user') ? (
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
            { disabled: !running || !plays, label: 'Open larger', onSelect: () => setOpen(true) },
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
            },
            { label: '', separator: true },
            { disabled: true, label: 'Quality on this device' },
            ...QUALITIES.map(option => ({
              'data-testid': `computer-quality-${option.value}`,
              label: (
                <span className="flex w-full items-center justify-between gap-6">
                  {option.label}
                  {quality === option.value ? (
                    <MenuCheckIcon aria-label="Chosen" size={14} />
                  ) : null}
                </span>
              ),
              onSelect: () => setQuality(option.value)
            }))
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
      {open && running && plays ? (
        <ComputerWindow onClose={() => setOpen(false)} status={status} />
      ) : null}
    </section>
  )
}

/** The Computer tab: the bots' computer alone, with no list of steps. */
export function ComputerTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  return <Screen bot={bot} onSave={onSave} />
}
