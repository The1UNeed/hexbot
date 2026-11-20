import { Download, MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'

import { Menu } from '../../../components/ui/menu'
import { cn } from '../../../lib/cn'

/** A toolbar button, as the text editor's are. */
export const toolClass =
  'hex-focus grid h-8 min-w-8 shrink-0 place-items-center rounded-[9px] px-1.5 text-[13px] font-semibold text-muted transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground'

export interface MenuEntry {
  icon: ReactNode
  label: string
  onSelect: () => void
  disabled?: boolean
}

/** A menu row with its icon, as the text editor's menu draws them. */
export function menuItem(icon: ReactNode, label: string) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="text-muted">{icon}</span>
      {label}
    </span>
  )
}

/** Saves bytes as a file under `name`. */
export function downloadBlob(name: string, blob: Blob) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)

  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const downloadEntry = (onSelect: () => void): MenuEntry => ({
  icon: <Download size={14} />,
  label: 'Download',
  onSelect
})

/**
 * The floating glass bar over a file beside the chat: its tools on the left,
 * the save state and a menu on the right. The same bar the text editor has.
 */
export function FileToolbar({
  children,
  className,
  menu,
  status
}: {
  children?: ReactNode
  className?: string
  menu?: MenuEntry[]
  status?: string
}) {
  return (
    <div className={cn('p-2', className)}>
      <div className="hex-glass flex min-h-10 flex-wrap items-center gap-1 rounded-[20px] px-1.5 py-1">
        {children}
        <span aria-live="polite" className="ml-auto pr-1 text-[length:var(--text-meta)] text-muted">
          {status}
        </span>
        {menu?.length ? (
          <Menu
            items={menu.map(entry => ({
              disabled: entry.disabled,
              label: menuItem(entry.icon, entry.label),
              onSelect: entry.onSelect
            }))}
            trigger={
              <button aria-label="More" className={toolClass} type="button">
                <MoreHorizontal size={16} />
              </button>
            }
          />
        ) : null}
      </div>
    </div>
  )
}

/** A label in the bar, such as the kind of file. */
export function ToolbarLabel({ children }: { children: ReactNode }) {
  return (
    <span className="truncate px-1.5 text-[length:var(--text-meta)] text-muted">{children}</span>
  )
}

/** Two or three views of one file, such as Table and Text. */
export function ViewSwitch<T extends string>({
  onChange,
  options,
  value
}: {
  onChange: (value: T) => void
  options: { label: string; value: T }[]
  value: T
}) {
  return (
    <div
      aria-label="View"
      className="flex rounded-full bg-foreground/[0.05] p-0.5"
      role="radiogroup"
    >
      {options.map(option => (
        <button
          aria-checked={value === option.value}
          className={cn(
            'hex-focus rounded-full px-2.5 py-1 text-[length:var(--text-meta)] font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
