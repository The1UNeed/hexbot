import { ArrowUp, Plus, Square } from 'lucide-react'
import type { ReactNode } from 'react'

import { Spinner } from '../../components/ui/spinner'
import { cn } from '../../lib/cn'
import type { BotStatus } from '../../lib/types'

/** Border and notice colour per bot state; idle and working draw the plain pill. */
const TONES: Record<BotStatus, { border: string; text: string }> = {
  idle: { border: '', text: '' },
  needs_you: { border: 'border-accent/70 focus-within:border-accent', text: 'text-accent' },
  stopped: { border: 'border-danger/70 focus-within:border-danger', text: 'text-danger' },
  working: { border: '', text: '' }
}

export interface ComposerShellProps {
  /** Attachment chips or popovers rendered above the field. */
  above?: ReactNode
  /** A quiet control just before send, such as the model picker. */
  accessory?: ReactNode
  canSend: boolean
  children: ReactNode
  className?: string
  /** One line above the field, coloured by `status` (an error, "Waiting on you"). */
  notice?: ReactNode
  onAttach?: () => void
  onSend: () => void
  onStop?: () => void
  sending?: boolean
  /** Colours the pill so the bottom of the chat matches the bot's dot. */
  status?: BotStatus
  streaming: boolean
}

/**
 * The floating glass pill that wraps a message field: attach on the left,
 * an optional accessory and send or stop on the right. The 30px buttons sit
 * 8px from the pill's outer edge on every side, so they stay concentric with
 * its 23px corners as the field grows (46px tall for one line). They are
 * sized in px because the root font is 14px, which makes `size-8` 28px. The
 * field itself is passed as children so the bot and room composers share one
 * look.
 */
export function ComposerShell({
  above,
  accessory,
  canSend,
  children,
  className,
  notice,
  onAttach,
  onSend,
  onStop,
  sending = false,
  status = 'idle',
  streaming
}: ComposerShellProps) {
  const tone = TONES[status]

  return (
    <div className={cn('relative shrink-0 px-4 pt-2 pb-4', className)}>
      {above}
      {notice ? (
        <p
          className={cn(
            'hex-glass hex-bubble mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full px-3.5 py-1.5 text-[length:var(--text-secondary)]',
            tone.text || 'text-muted'
          )}
          data-testid="composer-notice"
          role={status === 'stopped' ? 'alert' : 'status'}
        >
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full bg-current')} />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
        </p>
      ) : null}
      <div
        className={cn(
          'hex-glass flex items-end gap-1.5 rounded-[23px] border border-transparent p-[7px] transition-[border-color,box-shadow] duration-[var(--hex-motion-fast)]',
          tone.border
        )}
        data-status={status}
      >
        {onAttach ? (
          <button
            aria-label="Attach files"
            className="hex-glass-press hex-focus grid size-[30px] shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-foreground hover:bg-foreground/10"
            onClick={onAttach}
            type="button"
          >
            <Plus size={16} />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 px-1">{children}</div>
        {accessory}
        {streaming ? (
          <button
            aria-label="Stop"
            className="hex-glass-press hex-focus hex-fade grid size-[30px] shrink-0 place-items-center rounded-full bg-foreground text-background hover:opacity-85"
            onClick={onStop}
            type="button"
          >
            <Square className="fill-current" size={12} />
          </button>
        ) : (
          <button
            aria-label="Send"
            className={cn(
              'hex-glass-press hex-focus grid size-[30px] shrink-0 place-items-center rounded-full',
              canSend
                ? 'bg-foreground text-background hover:opacity-85'
                : 'bg-foreground/[0.06] text-muted'
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
