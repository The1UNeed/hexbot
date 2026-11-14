/**
 * Settings, Manuals, Computers: where bots work. The user picks the bots'
 * computer and their own, one of them, or neither, and which bots use each.
 * The bots' computer is one Cua sandbox per daemon; nothing there asks. The
 * daemon's computer runs commands in the workspace sandbox, as the approval
 * mode says.
 */

import { AppWindow, Code, Globe, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Avatar } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { botFace } from '../../lib/avatar-builder'
import { getBridge, type LendState } from '../../lib/bridge'
import { offerComputer } from '../../lib/lend'
import type { ComputerChoice, ComputerInfo, ComputerSize, ComputerState } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useComputer } from '../../stores/computer'
import { computerTitle, useComputers } from '../../stores/computers'
import { useConnection } from '../../stores/connection'
import { ChoiceRow, dividerClass, Group, Heading, Row } from '../bot-settings/shared'

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

/** What bots do on the computer. Each is room for its own controls later. */
const USES: { description: string; icon: LucideIcon; title: string }[] = [
  {
    description: 'Run scripts and install the programs a job needs, in its terminal.',
    icon: Code,
    title: 'Code execution'
  },
  {
    description: 'Open pages and work through them in Chrome.',
    icon: Globe,
    title: 'Browser'
  },
  {
    description: 'See the screen, click and type in its apps. You can watch and use it with them.',
    icon: AppWindow,
    title: 'Desktop'
  }
]

const sizeName = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`

/** The four choices, each saying what bots can touch on the user's computer. */
export const CHOICES: { describe: (name: string) => string; label: string; value: ComputerChoice }[] =
  [
    {
      describe: name =>
        `Bots work on their own computer, and run commands on ${name} when a task needs it.`,
      label: "Bots' computer and yours",
      value: 'both'
    },
    {
      describe: name => `Nothing runs on ${name}. File tools stay in the workspace.`,
      label: "Bots' computer only",
      value: 'bots'
    },
    {
      describe: name =>
        `Bots run commands on ${name}, as the approval mode allows. They don't use their own computer.`,
      label: 'Your computer only',
      value: 'yours'
    },
    {
      describe: name =>
        `Commands stay in the workspace sandbox on ${name}, without internet, in every approval mode.`,
      label: 'Neither',
      value: 'none'
    }
  ]

/** What the daemon's terminal does under each choice. */
const TERMINAL: Record<ComputerChoice, string> = {
  both: 'Commands run in the workspace sandbox. Leaving it follows the approval mode.',
  bots: "Off. Bots don't run anything here.",
  none: 'Commands stay in the workspace sandbox, in every approval mode.',
  yours: 'Commands run in the workspace sandbox. Leaving it follows the approval mode.'
}

/**
 * This computer, lent to your bots from the desktop app on it: its terminal,
 * and its screen too. Not shown in a browser, or on the daemon's own computer,
 * whose row covers it.
 */
function ThisComputer({ daemonName }: { daemonName: string }) {
  const lend = getBridge()?.computer
  const [state, setState] = useState<LendState | null>(null)
  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void lend
      ?.state()
      .then(setState)
      .catch(() => {})
  }, [lend])

  const plain = (name: string) => name.replace(/\.local$/i, '').toLowerCase()

  if (!lend || !state || plain(state.name) === plain(daemonName)) {
    return null
  }

  const change = async (choice: { on: boolean; screen: boolean }) => {
    setSaving(true)
    setError(null)

    try {
      // The switch shows what this computer lends even if the daemon is away;
      // the next connect offers it again.
      const next = await lend.set(choice)
      setState(next)
      await offerComputer(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Group
      description="Lend it to your bots from here, while this app is open. They run commands in its workspace sandbox, ~/Hexbot, as the approval mode allows."
      footer={
        error ? (
          <span className="text-danger" role="alert">
            {error}
          </span>
        ) : null
      }
      title={`This computer, ${state.name}`}
    >
      <Row
        control={
          <Switch
            aria-label="Let bots use this computer"
            checked={state.on}
            disabled={saving}
            onCheckedChange={on => void change({ on, screen: on && state.screen })}
          />
        }
        description={
          state.sandbox
            ? 'Then choose its bots below.'
            : 'This computer has no OS sandbox, so its commands run only in Bypass.'
        }
        title="Let bots use this computer"
      />
      {state.on ? (
        <Row
          control={
            <Switch
              aria-label="Its screen too"
              checked={state.screen}
              disabled={saving || !state.cua}
              onCheckedChange={screen => void change({ on: true, screen })}
            />
          }
          description={
            state.cua
              ? 'Bots see your apps and click and type there, asking first except in Bypass. On a Mac, allow Screen Recording and Accessibility when macOS asks.'
              : 'Needs Cua on this computer: uv tool install cua'
          }
          title="Its screen too"
        />
      ) : null}
    </Group>
  )
}

/**
 * A switch for each bot: whether it may use this computer, or with `screen`,
 * whether it may also see and use the daemon's screen.
 */
function BotAccess({ computer, screen }: { computer: ComputerInfo; screen?: boolean }) {
  const order = useBots(state => state.order)
  const byName = useBots(state => state.byName)
  const allow = useComputers(state => state.allow)
  const allowScreen = useComputers(state => state.allowScreen)
  const title = computerTitle(computer)

  if (!order.length) {
    return null
  }

  return (
    <Group
      description={
        screen
          ? "They see your apps and files, and click and type there. Auto asks once a conversation, Manual before every action, Bypass never. They never click or type in Hexbot's own windows."
          : null
      }
      footer={
        screen
          ? computer.kind === 'daemon'
            ? 'The first bot you pick lets Cua use this screen. On a Mac, allow Screen Recording and Accessibility when macOS asks.'
            : 'The Hexbot app on that computer lent its screen.'
          : computer.on === false
            ? 'Your choice above keeps this computer off for every bot.'
            : null
      }
      title={screen ? `Bots that use the screen of ${title}` : `Bots that use ${title}`}
    >
      {order.map(name => {
        const bot = byName[name]

        if (!bot) {
          return null
        }

        return (
          <Row
            control={
              screen ? (
                <Switch
                  aria-label={`${bot.display_name} uses the screen of ${title}`}
                  checked={computer.screen_bots?.includes(name) ?? false}
                  onCheckedChange={allowed => void allowScreen(computer.id, name, allowed)}
                />
              ) : (
                <Switch
                  aria-label={`${bot.display_name} uses ${title}`}
                  checked={computer.bots?.includes(name) ?? false}
                  onCheckedChange={allowed => void allow(computer.id, name, allowed)}
                />
              )
            }
            key={name}
            title={
              <span className="flex items-center gap-2.5">
                <Avatar {...botFace(bot)} name={bot.display_name} size="sm" />
                {bot.display_name}
              </span>
            }
          />
        )
      })}
    </Group>
  )
}

export function ComputerSettings(): React.JSX.Element {
  const list = useComputers(state => state.list)
  const listError = useComputers(state => state.error)
  const refreshList = useComputers(state => state.refresh)
  const choose = useComputers(state => state.choose)
  const status = useComputer(state => state.status)
  const requestError = useComputer(state => state.error)
  const refresh = useComputer(state => state.refresh)
  const step = useComputer(state => state.step)
  const configure = useComputer(state => state.configure)
  const connects = useConnection(state => state.connects)

  useEffect(() => {
    void refresh()
    void refreshList()
  }, [connects, refresh, refreshList])

  const botsComputer = list?.computers.find(computer => computer.kind === 'bots')
  const daemon = list?.computers.find(computer => computer.kind === 'daemon')
  const daemonName = daemon?.name ?? 'this computer'

  const busy = status ? BUSY.includes(status.state) : false
  const running = status?.state === 'running'
  const error = status?.error ?? requestError ?? listError

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
      <Heading description="Choose where your bots work. Nothing on the bots' computer asks before it runs. On yours, the approval mode decides.">
        Computers
      </Heading>
      <div className="mb-8 space-y-8">
        {!list ? (
          <SkeletonLines label="Loading computers" />
        ) : (
          <Group title="Where bots work">
            <div aria-label="Where bots work" className={dividerClass} role="radiogroup">
              {CHOICES.map(item => (
                <ChoiceRow
                  checked={list.choice === item.value}
                  description={item.describe(daemonName)}
                  key={item.value}
                  onSelect={() => void choose(item.value)}
                  title={item.label}
                />
              ))}
            </div>
          </Group>
        )}
        {daemon && list ? (
          <>
            <Group
              description={`${daemon.os}. The computer the daemon runs on.`}
              title={daemon.name}
            >
              <Row description={TERMINAL[list.choice]} title="Terminal" />
              <Row
                description="Always in the workspace, where attachments and files bots make are kept."
                title="Files"
              />
            </Group>
            {list.choice === 'bots' ? null : <BotAccess computer={daemon} />}
            {list.choice === 'bots' || list.choice === 'none' ? null : (
              <BotAccess computer={daemon} screen />
            )}
            <ThisComputer daemonName={daemon.name} />
            {list.computers
              .filter(computer => computer.kind === 'device')
              .map(computer => (
                <div className="space-y-8" key={computer.id}>
                  <Group
                    description={`${computer.os}. ${
                      computer.online
                        ? 'Lent by the Hexbot app there.'
                        : 'Offline: the Hexbot app there is closed or stopped lending it.'
                    }`}
                    title={computer.name}
                  >
                    <Row
                      description="Commands run in its workspace sandbox, ~/Hexbot. Leaving it follows the approval mode."
                      title="Terminal"
                    />
                  </Group>
                  <BotAccess computer={computer} />
                  {computer.lends_screen ? <BotAccess computer={computer} screen /> : null}
                </div>
              ))}
          </>
        ) : null}
      </div>
      {!status ? (
        <SkeletonLines label="Loading the computer" />
      ) : !status.available ? (
        <Group title="Bots' computer">
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
          <Group
            description="A Linux desktop your bots share, separate from yours. They run code, install programs and browse there."
            title="Bots' computer"
          >
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
          {botsComputer ? <BotAccess computer={botsComputer} /> : null}
          <Group title="What your bots do there">
            {USES.map(use => (
              <Row
                description={use.description}
                key={use.title}
                title={
                  <span className="flex items-center gap-2.5">
                    <use.icon className="text-muted" size={16} />
                    {use.title}
                  </span>
                }
              />
            ))}
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
