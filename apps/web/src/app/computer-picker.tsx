/**
 * The computer a bot works on when it names none, switched from its chat:
 * in the sidebar under the list, and in the bot's Computer tab. Both read
 * and write the same `hexbot.computers.*` state.
 */

import { useNavigate } from '@tanstack/react-router'
import { ChevronsUpDown, Laptop, Monitor } from 'lucide-react'
import { useEffect } from 'react'

import { Menu, MenuCheckIcon } from '../components/ui/menu'
import { cn } from '../lib/cn'
import type { ComputerInfo } from '../lib/types'
import { computerTitle, useComputers } from '../stores/computers'
import { useConnection } from '../stores/connection'

const NONE: ComputerInfo[] = []

/** What a computer is to the bot, one short line under its name. */
export function computerLine(computer: ComputerInfo): string {
  if (computer.kind === 'bots') {
    return 'Nothing asks here'
  }

  return computer.limited ? 'Workspace sandbox only' : 'Follows the approval mode'
}

export function ComputerPicker({
  bot,
  className,
  variant
}: {
  bot: string
  className?: string
  variant: 'panel' | 'sidebar'
}): null | React.JSX.Element {
  const navigate = useNavigate()
  const computers = useComputers(state => state.byBot[bot] ?? NONE)
  const loaded = useComputers(state => bot in state.byBot)
  const refreshBot = useComputers(state => state.refreshBot)
  const pick = useComputers(state => state.pick)
  const connects = useConnection(state => state.connects)

  useEffect(() => {
    void refreshBot(bot)
  }, [bot, connects, refreshBot])

  if (!loaded) {
    return null
  }

  const active = computers.find(computer => computer.active)
  const settings = () => void navigate({ params: { tab: 'computer' }, to: '/settings/$tab' })

  // The sidebar says nothing when there is nothing to switch.
  if (variant === 'sidebar' && computers.length < 2) {
    return null
  }

  const Icon = active?.kind === 'bots' ? Monitor : Laptop

  return (
    <Menu
      items={[
        { disabled: true, label: 'Works on' },
        ...computers.map(computer => ({
          'data-testid': `computer-pick-${computer.id}`,
          label: (
            <span className="flex w-full items-center justify-between gap-6">
              <span className="min-w-0">
                <span className="block truncate">{computerTitle(computer)}</span>
                <span className="block text-[length:var(--text-meta)] text-muted">
                  {computerLine(computer)}
                </span>
              </span>
              {computer.active ? <MenuCheckIcon aria-label="Chosen" size={14} /> : null}
            </span>
          ),
          onSelect: () => void pick(bot, computer.id)
        })),
        { label: '', separator: true },
        { label: 'Choose computers…', onSelect: settings }
      ]}
      trigger={
        <button
          aria-label={
            active ? `Works on ${computerTitle(active)}. Switch computer` : 'Choose a computer'
          }
          className={cn(
            'hex-focus flex min-w-0 items-center gap-2 rounded-full text-left transition-colors',
            variant === 'sidebar'
              ? 'hex-glass hex-glass-press mb-1 w-full py-1.5 pr-3 pl-3 text-[length:var(--text-secondary)]'
              : 'h-8 px-2.5 text-[length:var(--text-secondary)] text-muted hover:bg-foreground/[0.06] hover:text-foreground',
            className
          )}
          data-testid={`computer-picker-${variant}`}
          type="button"
        >
          <Icon className="shrink-0 text-muted" size={14} />
          <span className="min-w-0 flex-1 truncate">
            {active ? computerTitle(active) : 'No computer'}
          </span>
          <ChevronsUpDown className="shrink-0 text-muted" size={12} />
        </button>
      }
    />
  )
}
