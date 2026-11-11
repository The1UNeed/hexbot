import { useNavigate } from '@tanstack/react-router'
import { Bell, Ellipsis, X } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { Menu } from '../../components/ui/menu'
import { useNotificationsPrompt } from '../../lib/notify'

/**
 * Asks once per device to turn notifications on, under the chat's header.
 * Enable asks the browser, or sends the app's first notification, which is
 * when macOS asks. ✕ hides it until Hexbot opens again; the menu stops it.
 */
export function NotificationsBanner() {
  const prompt = useNotificationsPrompt()
  const navigate = useNavigate()

  if (!prompt.visible) {
    return null
  }

  const iconButton =
    'hex-focus grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground'

  return (
    <div
      aria-label="Turn on notifications"
      className="hex-glass hex-fade hex-no-drag pointer-events-auto mx-auto flex w-full max-w-[34rem] shrink-0 items-center gap-3 rounded-[18px] py-2.5 pr-2 pl-4"
      data-testid="notifications-banner"
      role="region"
    >
      <Bell aria-hidden className="shrink-0 text-foreground" size={18} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[length:var(--text-body)] font-medium">Turn on notifications</p>
        <p className="truncate text-[length:var(--text-secondary)] text-muted">
          Know when a bot replies or needs you.
        </p>
      </div>
      <Button
        className="rounded-full"
        onClick={() => void prompt.enable()}
        size="sm"
        variant="primary"
      >
        Enable
      </Button>
      <Menu
        items={[
          {
            label: 'Notification settings',
            onSelect: () =>
              void navigate({ params: { tab: 'notifications' }, to: '/settings/$tab' })
          },
          { label: 'Don’t ask again', onSelect: prompt.never }
        ]}
        trigger={
          <button aria-label="More" className={iconButton} type="button">
            <Ellipsis size={16} />
          </button>
        }
      />
      <button aria-label="Close" className={iconButton} onClick={prompt.close} type="button">
        <X size={16} />
      </button>
    </div>
  )
}
