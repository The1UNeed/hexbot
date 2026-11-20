/**
 * Settings, Computers: every place bots can act (`machines.rs`), and which
 * bots may use each one's terminal and desktop. The bots' own computer, one
 * Cua sandbox per daemon, is where they run code, browse and use apps first;
 * this computer and the user's own computers are there when the user wants
 * bots to work on them, with each app allowed the first time.
 */

import { Laptop, Monitor, Server, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { confirm } from '../../components/ui/confirm'
import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { botFace } from '../../lib/avatar-builder'
import { type ComputerShare, getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { canOfferComputer } from '../../lib/computer-endpoint'
import type { ComputerSize, ComputerState } from '../../lib/types'
import type { Computer } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { useComputers } from '../../stores/computers'
import { useConnection } from '../../stores/connection'
import { cardClass, dividerClass, Group, Heading, Row } from '../bot-settings/shared'

const STATE_TEXT: Record<ComputerState, string> = {
  absent: 'Made the first time a bot needs it',
  error: 'Stopped with an error',
  repairing: 'Repairing…',
  resetting: 'Resetting…',
  restarting: 'Restarting…',
  running: 'On',
  starting: 'Starting…',
  stopped: 'Off',
  stopping: 'Turning off…'
}

const BUSY: ComputerState[] = ['repairing', 'resetting', 'restarting', 'starting', 'stopping']

const sizeName = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`

function VmControls(): React.JSX.Element {
  const status = useComputer(state => state.status)
  const requestError = useComputer(state => state.error)
  const refresh = useComputer(state => state.refresh)
  const step = useComputer(state => state.step)
  const configure = useComputer(state => state.configure)
  const connects = useConnection(state => state.connects)

  useEffect(() => {
    void refresh()
  }, [connects, refresh])

  const busy = status ? BUSY.includes(status.state) : false
  const running = status?.state === 'running'
  const error = status?.error ?? requestError

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
    <>
      {!status ? (
        <SkeletonLines label="Loading the computer" />
      ) : !status.available ? (
        <Group title="Set up">
          <Row
            description={
              <>
                Install Cua on the daemon&apos;s computer and start Docker. Run{' '}
                <code className="rounded-[6px] bg-foreground/[0.07] px-1.5 py-0.5 font-mono text-[length:var(--text-meta)]">
                  uv tool install cua
                </code>
              </>
            }
            title="Your bots need Cua for their computer"
          />
        </Group>
      ) : (
        <div className="space-y-8">
          <Group>
            <Row
              control={
                running ? (
                  <>
                    <Button disabled={busy} onClick={() => void step('restart')} size="sm">
                      Restart
                    </Button>
                    <Button disabled={busy} onClick={() => void step('stop')} size="sm">
                      Turn off
                    </Button>
                  </>
                ) : (
                  <Button
                    busy={busy}
                    disabled={busy}
                    onClick={() => void step('start')}
                    size="sm"
                    variant="primary"
                  >
                    Turn on
                  </Button>
                )
              }
              description={
                status.state === 'starting'
                  ? 'The first start downloads the computer, a few GB.'
                  : 'Open a bot’s Computer tab to watch it or use it.'
              }
              title={
                <span className="flex items-baseline gap-2">
                  Status
                  <span
                    className={
                      status.state === 'error'
                        ? 'text-[length:var(--text-meta)] text-danger'
                        : 'text-[length:var(--text-meta)] text-muted'
                    }
                    data-testid="computer-state"
                  >
                    {STATE_TEXT[status.state]}
                  </span>
                </span>
              }
            />
            {status.sizes ? (
              <Row
                control={
                  <Select
                    label="Computer size"
                    onValueChange={value => void configure(value as ComputerSize)}
                    options={status.sizes.map(size => ({
                      label: `${sizeName(size.name)} · ${size.cpu} CPUs, ${size.memory_gb} GB`,
                      value: size.name
                    }))}
                    value={status.size}
                  />
                }
                description={
                  status.state === 'absent'
                    ? 'Used when the computer is made.'
                    : 'A new size applies after Reset.'
                }
                title="Size"
              />
            ) : null}
            <Row
              control={
                <Button
                  disabled={busy || status.state === 'absent'}
                  onClick={() => void reset()}
                  size="sm"
                  variant="ghost"
                >
                  Reset…
                </Button>
              }
              description="Erase it and start fresh, for every bot."
              title="Reset"
            />
          </Group>
        </div>
      )}
      {error ? (
        <p className="mt-4 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}

/**
 * One row per bot, one switch: this computer is one of the bot's
 * environments, where its terminal works. Its screen comes with the
 * Computer Use plugin, where the computer shares it.
 */
function BotGrid({ computer }: { computer: Computer }) {
  const byName = useBots(state => state.byName)
  const order = useBots(state => state.order)
  const grant = useComputers(state => state.grant)
  const available = computer.terminal.available

  if (!order.length || (!available && !computer.terminal.bots.length)) {
    return null
  }

  return (
    <div
      aria-label={`Bots on ${computer.name}`}
      className={cn(cardClass, dividerClass)}
      role="group"
    >
      <div className="flex min-h-[36px] items-center gap-3 px-4 py-1.5 text-[length:var(--text-meta)] text-muted">
        <span className="flex-1">
          {computer.kind === 'device' ? `Bots on ${computer.name}` : 'Bots'}
        </span>
        <span className="w-[88px] text-center">Works here</span>
      </div>
      {order.map(name => {
        const bot = byName[name]

        if (!bot) {
          return null
        }

        const on = computer.terminal.bots.includes(name)
        const screen = computer.desktop.bots.includes(name)

        return (
          <div className="flex min-h-[48px] items-center gap-3 px-4 py-2" key={name}>
            <span aria-hidden className="inline-flex">
              <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-body)]">
              {bot.display_name}
              {screen ? (
                <span className="ml-2 text-[length:var(--text-meta)] text-muted">
                  · Computer Use
                </span>
              ) : null}
            </span>
            <span className="flex w-[88px] justify-center">
              <Switch
                aria-label={`${bot.display_name} works on ${computer.name}`}
                checked={on}
                disabled={!on && !available}
                onCheckedChange={next => void grant(computer.id, 'terminal', name, next)}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Apps bots may always use on a computer, each with a way to take it back. */
function AllowedApps({ computer }: { computer: Computer }) {
  const byName = useBots(state => state.byName)
  const removeApp = useComputers(state => state.removeApp)
  const entries = Object.entries(computer.apps).filter(([, apps]) => apps.length)

  if (!entries.length) {
    return null
  }

  return (
    <Group
      description="A bot asks before it uses any other app here, except in Bypass."
      title={
        computer.kind === 'device'
          ? `Always allowed apps on ${computer.name}`
          : 'Always allowed apps'
      }
    >
      {entries.map(([bot, apps]) => (
        <Row
          description={
            <span className="mt-1 flex flex-wrap gap-1.5">
              {apps.map(app => (
                <Chip key={app}>
                  {app}
                  <button
                    aria-label={`Stop always allowing ${app}`}
                    className="hex-focus -mr-1 rounded-full p-0.5 hover:text-foreground"
                    onClick={() => void removeApp(computer.id, bot, app)}
                    type="button"
                  >
                    <X size={11} />
                  </button>
                </Chip>
              ))}
            </span>
          }
          key={bot}
          title={byName[bot]?.display_name ?? bot}
        />
      ))}
    </Group>
  )
}

/** This app's own computer, when it runs on another computer than the daemon. */
function ThisComputerShare() {
  const computer = getBridge()?.computer
  const [share, setShare] = useState<ComputerShare | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!computer) {
      return
    }

    void computer.state().then(setShare)

    return computer.onState?.(setShare)
  }, [computer])

  if (!computer || !share) {
    return null
  }

  const change = async (request: () => Promise<ComputerShare>) => {
    setBusy(true)
    setError(null)

    try {
      setShare(await request())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group
      description="Only you can turn this on, here. Auto checks each command first; Manual asks before each one; Bypass runs them without asking. Bots ask before each app the first time in each conversation (Always allow keeps it), except in Bypass."
      footer={error ? <span className="text-danger">{error}</span> : undefined}
      title={`${share.name}, where you are now`}
    >
      <Row
        control={
          <Switch
            aria-label="Let bots work on this computer"
            checked={share.terminal}
            disabled={busy}
            onCheckedChange={next => void change(() => computer.allow({ terminal: next }))}
          />
        }
        description="It becomes an environment you can give bots on the daemon's Settings, Computers. They run commands here, outside any sandbox."
        title="Let bots work here"
      />
      <Row
        control={
          // Kept while it is on, so it can always be turned off here.
          share.desktopReady || share.desktop ? (
            <Switch
              aria-label="Let Computer Use reach this computer's screen"
              checked={share.desktop}
              // It sits on Let bots work here; off, it can always be turned off.
              disabled={busy || (!share.desktop && !share.terminal)}
              onCheckedChange={next => void change(() => computer.allow({ desktop: next }))}
            />
          ) : (
            <Button
              busy={busy}
              disabled={busy}
              onClick={() => void change(computer.setupDesktop)}
              size="sm"
            >
              Set up
            </Button>
          )
        }
        description={
          !share.terminal && !share.desktop
            ? 'Turn on Let bots work here first: bots with Computer Use see the screen of a computer they work on.'
            : share.desktopReady
              ? 'Bots with Computer Use see the screen, click and type in the apps you allow (in Bypass, without asking), never in terminals, editors or Hexbot.'
              : share.desktop
                ? `${share.desktopNote ?? "Cua isn't ready here."} Bots can't use it until it is; turn it off and choose Set up to set it up again.`
                : (share.desktopNote ??
                  'Needs Cua. Your computer asks for Screen Recording and Accessibility.')
        }
        title="Computer Use here"
      />
    </Group>
  )
}

function ComputerTitle({ computer }: { computer: Computer }) {
  const Icon = computer.kind === 'vm' ? Monitor : computer.kind === 'host' ? Server : Laptop

  return (
    <span className="flex items-center gap-2">
      <Icon className="text-muted" size={15} />
      {computer.kind === 'vm' ? "The bots' computer" : computer.name}
      {computer.os ? (
        <span className="text-[length:var(--text-meta)] text-muted">{computer.os}</span>
      ) : null}
      {computer.kind === 'device' ? (
        <Chip tone={computer.online ? 'success' : 'neutral'}>
          {computer.online ? 'Online' : 'Offline'}
        </Chip>
      ) : null}
    </span>
  )
}

function HostDesktop({ computer }: { computer: Computer }) {
  const set = useComputers(state => state.set)
  const [busy, setBusy] = useState(false)
  const desktop = computer.desktop

  return (
    <Row
      control={
        <Switch
          aria-label={`Let Computer Use reach ${computer.name}'s screen`}
          checked={Boolean(desktop.on)}
          disabled={busy || (!desktop.on && !desktop.available)}
          onCheckedChange={next => {
            setBusy(true)
            void set('host', { desktop: next }).finally(() => setBusy(false))
          }}
        />
      }
      description={
        desktop.note ??
        (desktop.on && !desktop.ready
          ? `Waiting for Cua. Allow Screen Recording and Accessibility on ${computer.name} if it asks.`
          : `Bots with Computer Use see its screen, click and type in the apps you allow (in Bypass, without asking), never in terminals, editors or Hexbot. Turning it on sets up Cua on ${computer.name}.`)
      }
      title="Computer Use here"
    />
  )
}

export function ComputerSettings(): React.JSX.Element {
  const listed = useComputers(state => state.computers)
  const answered = useComputers(state => state.answered)
  const listFailed = useComputers(state => state.listFailed)
  const error = useComputers(state => state.error)
  const refresh = useComputers(state => state.refresh)
  const set = useComputers(state => state.set)
  const forget = useComputers(state => state.forget)
  const notices = useComputers(state => state.notices)
  const dismissNotice = useComputers(state => state.dismissNotice)
  const connects = useConnection(state => state.connects)

  useEffect(() => {
    void refresh()
  }, [connects, refresh])

  // Only this connection's list: grants may have changed while away, and a
  // switch must not show (or change from) what was true before.
  const computers = answered === connects ? listed : null
  // A daemon from before computers: its bots' computer still answers, so its
  // controls stay; choosing bots for each computer waits for an update there.
  const older = useComputers(state => state.older) && answered === connects
  const vm = computers?.find(computer => computer.kind === 'vm')
  const host = computers?.find(computer => computer.kind === 'host')
  const devices = computers?.filter(computer => computer.kind === 'device') ?? []

  return (
    <>
      <Heading description="Where your bots work. Each computer you give a bot is one of its environments, where it runs commands; with the Computer Use plugin it also sees and uses that computer's screen.">
        Computers
      </Heading>
      {notices.map(notice => (
        <div
          className="mb-5 flex items-start gap-3 rounded-[12px] bg-warning/10 px-4 py-3 text-[length:var(--text-secondary)] text-warning"
          key={notice}
          role="alert"
        >
          <span className="flex-1">{notice}</span>
          <Button onClick={() => dismissNotice(notice)} size="sm" variant="ghost">
            OK
          </Button>
        </div>
      ))}
      {older ? (
        <section className="space-y-4">
          <p className="text-[length:var(--text-secondary)] text-muted">
            Choosing bots for each computer needs a newer Hexbot on the daemon's computer.
          </p>
          <VmControls />
        </section>
      ) : !computers ? (
        listFailed?.connects === connects ? (
          <Button onClick={() => void refresh()} size="sm" variant="secondary">
            Try again
          </Button>
        ) : (
          <SkeletonLines label="Loading computers" />
        )
      ) : (
        <div className="space-y-10">
          {vm ? (
            <section className="space-y-4">
              <Group
                description="A Linux desktop of their own, separate from yours, that every bot shares. Suggested: easy to reset, so commands run there without a sandbox and Auto checks only risky ones."
                title="The bots' computer"
              >
                <Row
                  control={
                    <Switch
                      aria-label="Use the bots' computer"
                      checked={vm.on}
                      onCheckedChange={next => void set('vm', { on: next })}
                    />
                  }
                  title={<ComputerTitle computer={vm} />}
                />
              </Group>
              {vm.on ? (
                <>
                  <VmControls />
                  <BotGrid computer={vm} />
                </>
              ) : null}
            </section>
          ) : null}
          {host ? (
            <section className="space-y-4">
              <Group
                description={
                  host.terminal.sandboxed
                    ? 'The computer Hexbot runs on. Commands run in the sandbox in Auto and Manual.'
                    : 'The computer Hexbot runs on. Hexbot has no sandbox on Windows yet, so its terminal works only in Bypass.'
                }
                title={`${host.name}, where Hexbot runs`}
              >
                <Row title={<ComputerTitle computer={host} />} />
                <HostDesktop computer={host} />
              </Group>
              <BotGrid computer={host} />
              <AllowedApps computer={host} />
            </section>
          ) : null}
          <section className="space-y-4">
            <Group
              description="Your other computers, online while Hexbot is open there. Each one is added when you turn on Let bots work here in Hexbot on that computer."
              title="Your computers"
            >
              {devices.length ? (
                devices.map(device => (
                  <Row
                    control={
                      <Button
                        onClick={async () => {
                          if (
                            await confirm({
                              detail:
                                'Bots lose it and its allowed apps, and what they are doing there stops. It shows again, with no bots, when Hexbot there connects.',
                              title: `Forget ${device.name}?`
                            })
                          ) {
                            void forget(device.id)
                          }
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Forget…
                      </Button>
                    }
                    key={device.id}
                    title={<ComputerTitle computer={device} />}
                  />
                ))
              ) : (
                <Row
                  description="Open Hexbot on another computer, connect it to this daemon, then turn on Let bots work here in its Settings, Computers."
                  title="None yet"
                />
              )}
            </Group>
            {devices.map(device => (
              <div className="space-y-4" key={device.id}>
                <BotGrid computer={device} />
                <AllowedApps computer={device} />
              </div>
            ))}
            {canOfferComputer() ? <ThisComputerShare /> : null}
          </section>
        </div>
      )}
      {error && !older ? (
        <p className="mt-4 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
