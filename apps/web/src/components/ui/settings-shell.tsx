import { X } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import { cn } from '../../lib/cn'

import { Dialog } from './dialog'
import { ScrollArea } from './scroll-area'

export interface SettingsTabItem<Id extends string = string> {
  icon: ComponentType<{ className?: string; size?: number }>
  id: Id
  label: string
}

export interface SettingsTabGroup<Id extends string = string> {
  items: SettingsTabItem<Id>[]
  /** A tiny muted label over the group, when it helps. */
  label?: string
}

export interface SettingsShellProps<Id extends string = string> {
  children: ReactNode
  /** Accessible name of the close button, such as "Close settings". */
  closeLabel: string
  current?: Id
  /** Sits at the top of the nav: the bot face and name, for instance. */
  header?: ReactNode
  /** Accessible name of the window. */
  label: string
  /** Accessible name of the tab list, such as "Settings tabs". */
  navLabel?: string
  onClose: () => void
  onSelect?: (id: Id) => void
  /** Tabs down the left. Without them the window is a single column. */
  tabs?: SettingsTabGroup<Id>[]
  /** `wide` is the two-column settings window; `narrow` a one-column sheet. */
  width?: 'narrow' | 'wide'
}

/**
 * The one settings window: a glass sheet over the blurred app, tabs down the
 * left (a pill row on top when narrow), the page on the right, and a round
 * close button floating in the corner. Settings, Bot settings and Room
 * settings all render through here.
 */
export function SettingsShell<Id extends string>({
  children,
  closeLabel,
  current,
  header,
  label,
  navLabel,
  onClose,
  onSelect,
  tabs,
  width = 'wide'
}: SettingsShellProps<Id>) {
  return (
    <Dialog
      className={cn(
        'max-h-[92dvh]',
        width === 'wide'
          ? 'h-[min(760px,92dvh)] w-[min(1080px,94vw)]'
          : 'h-[min(680px,92dvh)] w-[min(600px,94vw)]'
      )}
      label={label}
      onOpenChange={open => !open && onClose()}
      open
      scroll={false}
    >
      <div className="relative h-full">
        <div className="absolute top-4 right-4 z-10">
          <button
            aria-label={closeLabel}
            className="hex-glass hex-glass-press hex-focus grid size-9 place-items-center rounded-full text-foreground/70 hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <X size={15} />
          </button>
        </div>
        {tabs ? (
          <div className="grid h-full grid-rows-[auto_1fr] @min-[600px]:grid-cols-[220px_1fr] @min-[600px]:grid-rows-1">
            {/* The tabs scroll like the page beside them, fading at the window's edge. */}
            <ScrollArea>
              <nav
                aria-label={navLabel}
                // Narrow, the tabs are one row that scrolls sideways and fades at its ends.
                className="mr-14 flex gap-1 overflow-x-auto overflow-y-hidden px-3 pt-3 pb-1 [mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)] @min-[600px]:mr-0 @min-[600px]:flex-col @min-[600px]:gap-0 @min-[600px]:overflow-visible @min-[600px]:px-3 @min-[600px]:py-4 @min-[600px]:[mask-image:none]"
              >
                {header}
                {tabs.map((group, index) => (
                  <div
                    className={cn(
                      'flex shrink-0 gap-1 @min-[600px]:flex-col @min-[600px]:gap-px',
                      index > 0 && '@min-[600px]:mt-4'
                    )}
                    key={group.label ?? index}
                  >
                    {group.label ? (
                      <p className="hidden px-3 pb-1.5 text-[length:var(--text-meta)] font-medium text-muted/80 @min-[600px]:block">
                        {group.label}
                      </p>
                    ) : null}
                    {group.items.map(item => {
                      const active = item.id === current
                      const Icon = item.icon

                      return (
                        <button
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex h-[32px] shrink-0 items-center gap-2.5 rounded-[10px] px-3 text-[length:var(--text-secondary)] whitespace-nowrap transition-colors duration-[var(--hex-motion-fast)] outline-none focus-visible:ring-2 focus-visible:ring-accent/50 @min-[600px]:w-full',
                            active
                              ? 'bg-foreground/[0.07] font-medium text-foreground'
                              : 'text-muted hover:bg-foreground/[0.04] hover:text-foreground'
                          )}
                          key={item.id}
                          onClick={() => onSelect?.(item.id)}
                          type="button"
                        >
                          <Icon
                            className={cn('shrink-0', active ? 'text-foreground' : 'text-muted')}
                            size={16}
                          />
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </nav>
            </ScrollArea>
            <ScrollArea>{children}</ScrollArea>
          </div>
        ) : (
          <ScrollArea className="h-full">{children}</ScrollArea>
        )}
      </div>
    </Dialog>
  )
}

/** Padding and measure for one settings page. */
export const settingsPageClass = 'mx-auto w-full max-w-[640px] px-6 pt-8 pb-14 @min-[600px]:px-10'
