import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactNode } from 'react'

export interface TooltipProps {
  children: ReactNode
  content: ReactNode
}

export function Tooltip({ children, content }: TooltipProps) {
  return (
    <BaseTooltip.Provider>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={<span className="inline-flex" />}>
          {children}
        </BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner className="z-50" sideOffset={6}>
            <BaseTooltip.Popup className="rounded-control border border-border bg-surface px-2 py-1 text-[length:var(--text-meta)] text-foreground shadow-popup">
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  )
}
