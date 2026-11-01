/**
 * Settings, Manuals, Computer use: the bots' own computer, one Cua sandbox
 * per daemon. Every bot has it, and runs code, browses and uses apps there,
 * so nothing a bot installs lands on the daemon's computer.
 */

import { AppWindow, Code, Globe, type LucideIcon } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '../../components/ui/button'
import { confirm } from '../../components/ui/confirm'
import { Select } from '../../components/ui/select'
import { SkeletonLines } from '../../components/ui/skeleton'
import type { ComputerSize, ComputerState } from '../../lib/types'
import { useComputer } from '../../stores/computer'
import { useConnection } from '../../stores/connection'
import { Group, Heading, Row } from '../bot-settings/shared'

const STATE_TEXT: Record<ComputerState, string> = {
  absent: 'Made the first time a bot needs it',
  error: 'Stopped with an error',
  resetting: 'Resetting…',
  restarting: 'Restarting…',
  running: 'On',
  starting: 'Starting…',
  stopped: 'Off',
  stopping: 'Turning off…'
}

const BUSY: ComputerState[] = ['resetting', 'restarting', 'starting', 'stopping']

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
    description: 'See the screen, click and type in its apps. You can watch and take over.',
    icon: AppWindow,
    title: 'Desktop'
  }
]

const sizeName = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`

export function ComputerSettings(): React.JSX.Element {
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
      <Heading description="Your bots share one computer of their own: a Linux desktop, separate from yours. Every bot has it, and runs code, browses and uses apps there.">
        Computer use
      </Heading>
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
          <Group title="Computer">
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
                  : 'Open a bot’s Computer tab to watch it or take control.'
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
