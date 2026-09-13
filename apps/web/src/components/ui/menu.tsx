import { Menu as BaseMenu } from '@base-ui/react/menu'
import { Check, ChevronRight } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '../../lib/cn'

export interface MenuItem {
  'data-testid'?: string
  disabled?: boolean
  label: ReactNode
  onSelect?: () => void
  separator?: boolean
}

export interface MenuProps {
  items: MenuItem[]
  /** The button that opens the menu. Base UI merges its trigger props onto it. */
  trigger: ReactElement
}

export function Menu({ items, trigger }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-50 outline-none" sideOffset={6}>
          <BaseMenu.Popup className="hex-bubble max-h-[min(70vh,32rem)] min-w-44 overflow-y-auto rounded-panel border border-border bg-surface p-1 text-foreground shadow-popup outline-none">
            {items.map((item, index) =>
              item.separator ? (
                <BaseMenu.Separator className="my-1 h-px bg-border" key={index} />
              ) : (
                <BaseMenu.Item
                  className={cn(
                    'flex cursor-default items-center rounded-control px-2.5 py-2 text-[length:var(--text-secondary)] outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50'
                  )}
                  data-testid={item['data-testid']}
                  disabled={item.disabled}
                  key={index}
                  onClick={item.onSelect}
                >
                  {item.label}
                </BaseMenu.Item>
              )
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

export { Check as MenuCheckIcon, ChevronRight as MenuSubmenuIcon }
