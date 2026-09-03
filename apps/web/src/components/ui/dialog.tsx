import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

export interface DialogProps {
  children: ReactNode
  className?: string
  description?: ReactNode
  onOpenChange?: (open: boolean) => void
  open?: boolean
  title?: ReactNode
  /** Rendered on the right of the title row. */
  toolbar?: ReactNode
}

/** The one dialog: hairline border plus one soft shadow, nothing nested. */
export function Dialog({
  children,
  className,
  description,
  onOpenChange,
  open,
  title,
  toolbar
}: DialogProps) {
  return (
    <BaseDialog.Root onOpenChange={onOpenChange} open={open}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-foreground/20 backdrop-blur-[1px]" />
        <BaseDialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(56rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-border bg-surface text-foreground shadow-popup outline-none',
            className
          )}
        >
          {title ? (
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
              <div>
                <BaseDialog.Title className="text-[length:var(--text-body)] font-semibold">
                  {title}
                </BaseDialog.Title>
                {description ? (
                  <BaseDialog.Description className="mt-0.5 text-[length:var(--text-secondary)] text-muted">
                    {description}
                  </BaseDialog.Description>
                ) : null}
              </div>
              {toolbar}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export const DialogClose = BaseDialog.Close
export const DialogTrigger = BaseDialog.Trigger
