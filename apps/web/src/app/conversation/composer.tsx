import { ArrowUp, Plus, Square } from 'lucide-react'
import type { ReactNode } from 'react'

import { Spinner } from '../../components/ui/spinner'
import { cn } from '../../lib/cn'

export interface ComposerShellProps {
  /** Attachment chips or popovers rendered above the field. */
  above?: ReactNode
  canSend: boolean
  children: ReactNode
  className?: string
  onAttach?: () => void
  onSend: () => void
  onStop?: () => void
  sending?: boolean
  streaming: boolean
}

/**
 * The floating pill that wraps a message field: attach on the left, send or
 * stop on the right. The field itself is passed as children so the bot and
 * room composers share one look.
 */
export function ComposerShell({
  above,
  canSend,
  children,
  className,
  onAttach,
  onSend,
  onStop,
  sending = false,
  streaming
}: ComposerShellProps) {
  return (
    <div className={cn('relative shrink-0 px-4 pt-2 pb-4', className)}>
      {above}
      <div className="flex items-end gap-2 rounded-[26px] border border-border bg-surface py-1.5 pr-1.5 pl-1.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-foreground/25">
        {onAttach ? (
          <button
            aria-label="Attach files"
            className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-border text-foreground transition-colors hover:bg-surface-2"
            onClick={onAttach}
            type="button"
          >
            <Plus size={16} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 py-1">{children}</div>
        {streaming ? (
          <button
            aria-label="Stop"
            className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
            onClick={onStop}
            type="button"
          >
            <Square className="fill-current" size={12} />
          </button>
        ) : (
          <button
            aria-label="Send"
            className={cn(
              'mb-0.5 grid size-8 shrink-0 place-items-center rounded-full transition-all duration-[var(--hex-motion-fast)]',
              canSend ? 'bg-foreground text-background hover:opacity-85' : 'bg-surface-2 text-muted'
            )}
            disabled={!canSend || sending}
            onClick={onSend}
            type="button"
          >
            {sending ? <Spinner size="sm" /> : <ArrowUp size={16} strokeWidth={2.5} />}
          </button>
        )}
      </div>
    </div>
  )
}

export const composerFieldClass =
  'block max-h-44 w-full resize-none border-0 bg-transparent px-1 py-1 text-[length:var(--text-body)] leading-[22px] text-foreground outline-none placeholder:text-muted disabled:opacity-50'
