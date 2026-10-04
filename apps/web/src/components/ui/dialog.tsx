import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { type ReactNode, useRef } from 'react'

import { cn } from '../../lib/cn'

export interface DialogProps {
  children: ReactNode
  className?: string
  description?: ReactNode
  /** Accessible name when there is no visible title. */
  label?: string
  onOpenChange?: (open: boolean) => void
  open?: boolean
  title?: ReactNode
  /** Rendered on the right of the title row. */
  toolbar?: ReactNode
}

/**
 * The one dialog: a glass window over the dimmed, blurred app. The popup only
 * positions; the inner surface carries the glass, the radius and the clip, so
 * the glass rim and shadow stay intact.
 */
export function Dialog({
  children,
  className,
  description,
  label,
  onOpenChange,
  open,
  title,
  toolbar
}: DialogProps) {
  const popup = useRef<HTMLDivElement>(null)

  return (
    <BaseDialog.Root onOpenChange={onOpenChange} open={open}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="hex-fade fixed inset-0 z-50 bg-black/25 backdrop-blur-md" />
        <BaseDialog.Popup
          aria-label={title ? undefined : label}
          className={cn(
            'hex-dialog-in fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 flex max-h-[85vh] w-[min(36rem,92vw)] flex-col text-foreground outline-none',
            className
          )}
          // A keyboard user lands on the first control; a click or a route
          // change lands on the window itself, so no focus ring appears unasked.
          initialFocus={openType => (openType === 'keyboard' ? true : popup.current)}
          ref={popup}
        >
          <div className="hex-glass-strong flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px]">
            {title || toolbar ? (
              <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
                <div className="min-w-0">
                  {title ? (
                    <BaseDialog.Title className="text-[length:var(--text-heading)] font-semibold tracking-[-0.01em]">
                      {title}
                    </BaseDialog.Title>
                  ) : null}
                  {description ? (
                    <BaseDialog.Description className="mt-1 text-[length:var(--text-secondary)] text-muted">
                      {description}
                    </BaseDialog.Description>
                  ) : null}
                </div>
                {toolbar}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
