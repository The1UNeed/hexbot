import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export interface TooltipProps {
  children: ReactNode
  content: ReactNode
  /**
   * The element that opens the tooltip on hover and focus, with `children`
   * inside it. Defaults to an inline span; pass a focusable element (or one
   * with `tabIndex`) when the content is not itself a control.
   */
  trigger?: ReactElement
}

/**
 * The popup is solid: it sits over conversation text, so a glass fill would
 * let the words show through in either theme.
 */
export function Tooltip({ children, content, trigger }: TooltipProps) {
  return (
    <BaseTooltip.Provider>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={trigger ?? <span className="inline-flex" />}>
          {children}
        </BaseTooltip.Trigger>
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner className="z-50" sideOffset={6}>
            <BaseTooltip.Popup className="hex-glass-strong hex-fade rounded-[10px] bg-background px-2.5 py-1.5 text-[length:var(--text-meta)] text-foreground">
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  )
}
