import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { cardSize, extensionOf, kindOf } from '../../lib/file-kinds'

export { cardSize, extensionOf, kindOf }

/** A page with two lines of text and a band in the file type's colour. */
function PageIcon({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="relative flex h-10 w-8 shrink-0 flex-col overflow-hidden rounded-[6px] bg-foreground/[0.06]"
    >
      <span className="mx-1.5 mt-2 h-[3px] rounded-full bg-foreground/[0.18]" />
      <span className="mx-1.5 mt-1 h-[3px] w-3 rounded-full bg-foreground/[0.18]" />
      <span className="mt-auto h-3" style={{ backgroundColor: color }} />
    </span>
  )
}

/**
 * A file as one small card: its type, its name cut in the middle so the
 * extension stays, and its size or kind. Pictures and videos show themselves
 * instead; every other file is this card.
 */
export function FileCard({
  detail,
  label,
  name,
  onOpen,
  onRemove,
  size
}: {
  /** Shown under the name when there is no size, such as the bot's own file. */
  detail?: ReactNode
  /** The accessible name of the open action. */
  label?: string
  name: string
  onOpen?: () => void
  onRemove?: () => void
  size?: number
}) {
  const kind = kindOf(name)
  const ext = extensionOf(name)
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name

  const body = (
    <>
      <PageIcon color={kind.color} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        {/* Cut in the middle on screen; read whole, once. */}
        <span className="sr-only">{name}</span>
        <span
          aria-hidden
          className="flex min-w-0 text-[length:var(--text-secondary)] font-medium text-foreground"
        >
          <span className="truncate">{stem}</span>
          {ext ? <span className="shrink-0">.{ext}</span> : null}
        </span>
        <span className="truncate text-[length:var(--text-meta)] text-muted">
          {size !== undefined ? cardSize(size) : (detail ?? kind.label)}
        </span>
      </span>
    </>
  )

  return (
    <div
      className="relative flex w-[min(100%,17.5rem)] items-center rounded-[18px] border border-foreground/[0.06] bg-background text-foreground shadow-card"
      title={name}
    >
      {onOpen ? (
        <button
          aria-label={label ?? `Open ${name}`}
          className="hex-focus flex min-w-0 flex-1 items-center gap-3 rounded-[18px] py-2.5 pr-3 pl-2.5 transition-colors duration-[var(--hex-motion-fast)] hover:bg-foreground/[0.03]"
          onClick={onOpen}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 pl-2.5">{body}</div>
      )}
      {onRemove ? (
        <button
          aria-label={`Remove ${name}`}
          className={cn(
            'hex-focus absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-card'
          )}
          onClick={onRemove}
          type="button"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  )
}
