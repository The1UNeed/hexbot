import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
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

function MenuPopup({ items, sideOffset }: { items: MenuItem[]; sideOffset?: number }) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="z-50 outline-none" sideOffset={sideOffset}>
        <BaseMenu.Popup className="hex-glass-strong hex-menu-in max-h-[min(70vh,32rem)] min-w-44 overflow-y-auto rounded-[14px] p-1 text-foreground outline-none">
          {items.map((item, index) =>
            item.separator ? (
              <BaseMenu.Separator className="my-1 h-px bg-foreground/[0.08]" key={index} />
            ) : (
              <BaseMenu.Item
                className={cn(
                  'flex cursor-default items-center rounded-[10px] px-2.5 py-1.5 text-[length:var(--text-secondary)] outline-none data-[highlighted]:bg-foreground/[0.07] data-[disabled]:opacity-50'
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
  )
}

export function Menu({ items, trigger }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <MenuPopup items={items} sideOffset={6} />
    </BaseMenu.Root>
  )
}

export interface ContextMenuProps {
  /** The element that opens the menu on right click or long press. */
  children: ReactElement
  items: MenuItem[]
}

/** The same menu, opened at the pointer by right click (or long press on touch). */
export function ContextMenu({ children, items }: ContextMenuProps) {
  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger render={children} />
      <MenuPopup items={items} />
    </BaseContextMenu.Root>
  )
}

export { Check as MenuCheckIcon, ChevronRight as MenuSubmenuIcon }
