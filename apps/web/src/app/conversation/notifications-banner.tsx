import { useNavigate } from '@tanstack/react-router'
import { Bell, BellOff, Ellipsis, X } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { Menu } from '../../components/ui/menu'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { systemNotificationSettings, useNotificationsPrompt } from '../../lib/notify'

/** What the banner calls the computer's system when it hides notifications. */
function systemName(): string {
  const platform = getBridge()?.platform

  if (platform === 'darwin') {
    return 'macOS'
  }

  return platform === 'win32' ? 'Windows' : 'Your system'
}

/**
 * Asks once per device to turn notifications on, under the chat's header.
 * Enable asks the browser. The app cannot tell whether its system shows
 * notifications (macOS hides them until Hexbot is allowed, and says nothing),
 * so there Enable sends a test and the banner asks whether it appeared: yes
 * ends it, no leads to the system's settings and another test. ✕ hides it
 * until Hexbot opens again; the menu stops it.
 */
export function NotificationsBanner() {
  const prompt = useNotificationsPrompt()
  const navigate = useNavigate()

  if (!prompt.visible) {
    return null
  }

  const iconButton =
    'hex-focus grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground'

  const settings = systemNotificationSettings()
  const blocked = prompt.step === 'blocked'
  const Icon = blocked ? BellOff : Bell

  const [title, detail] =
    prompt.step === 'ask'
      ? ['Turn on notifications', 'Know when a bot replies or needs you.']
      : prompt.step === 'check'
        ? ['Did a test notification appear?', 'Hexbot just sent one to this computer.']
        : [
            `${systemName()} is not showing them`,
            settings
              ? `Allow Hexbot in ${settings.name}, then try again.`
              : 'Allow Hexbot in its notification settings, then try again.'
          ]

  return (
    <div
      aria-label="Turn on notifications"
      className={cn(
        'hex-glass hex-fade hex-no-drag pointer-events-auto mx-auto flex w-full max-w-[34rem] shrink-0 gap-3 rounded-[18px] py-2.5 pr-2 pl-4',
        // Its two buttons sit under the words, which a narrow chat would otherwise cut off.
        blocked ? 'items-start' : 'items-center'
      )}
      data-step={prompt.step}
      data-testid="notifications-banner"
      role="region"
    >
      <Icon aria-hidden className={cn('shrink-0 text-foreground', blocked && 'mt-2')} size={18} />
      <div aria-live="polite" className={cn('min-w-0 flex-1', blocked && 'py-1')}>
        <p className="truncate text-[length:var(--text-body)] font-medium">{title}</p>
        <p
          className={cn('text-[length:var(--text-secondary)] text-muted', !blocked && 'truncate')}
        >
          {detail}
        </p>
        {blocked ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {settings ? (
              <Button className="rounded-full" onClick={settings.open} size="sm" variant="primary">
                Open {settings.name}
              </Button>
            ) : null}
            <Button className="rounded-full" onClick={() => void prompt.enable()} size="sm">
              Try again
            </Button>
          </div>
        ) : null}
      </div>
      {prompt.step === 'ask' ? (
        <Button
          className="rounded-full"
          onClick={() => void prompt.enable()}
          size="sm"
          variant="primary"
        >
          Enable
        </Button>
      ) : null}
      {prompt.step === 'check' ? (
        <>
          <Button className="rounded-full" onClick={prompt.missing} size="sm">
            No
          </Button>
          <Button className="rounded-full" onClick={prompt.confirm} size="sm" variant="primary">
            Yes
          </Button>
        </>
      ) : null}
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
