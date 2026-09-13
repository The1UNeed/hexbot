import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'

import { SettingsPanel } from '../app/settings'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { useUsers } from '../stores/users'

const tabs = [
  'providers',
  'network',
  'connect',
  'memory',
  'users',
  'usage',
  'approvals',
  'appearance',
  'updates',
  'about'
] as const

export const Route = createFileRoute('/settings/$tab')({ component: SettingsDialog })

function SettingsDialog() {
  const { tab } = Route.useParams()
  const navigate = useNavigate()
  const supported = useUsers(state => state.supported)
  const current = useUsers(state => state.current)
  const usageSupported = useUsers(state => state.usageSupported)

  const visibleTabs = tabs.filter(item =>
    item === 'users'
      ? Boolean(supported && current?.role === 'admin')
      : item === 'usage'
        ? Boolean(usageSupported)
        : true
  )

  return (
    <Dialog
      className="h-[min(56rem,92vh)] max-h-[92vh] w-[min(76rem,94vw)]"
      onOpenChange={open => {
        if (!open) {
          void navigate({ to: '/' })
        }
      }}
      open
      title="Settings"
      toolbar={
        <Button
          aria-label="Close settings"
          icon={<X size={16} />}
          onClick={() => void navigate({ to: '/' })}
          size="sm"
          variant="ghost"
        />
      }
    >
      <div className="grid h-full grid-rows-[auto_1fr] sm:grid-cols-[208px_1fr] sm:grid-rows-1">
        <nav
          aria-label="Settings tabs"
          className="flex gap-1 overflow-x-auto border-b border-border p-2 sm:block sm:border-r sm:border-b-0 sm:p-3"
        >
          {visibleTabs.map(item => (
            <Button
              aria-current={tab === item ? 'page' : undefined}
              className="shrink-0 justify-start sm:mb-1 sm:w-full"
              key={item}
              onClick={() => void navigate({ to: '/settings/$tab', params: { tab: item } })}
              variant={tab === item ? 'secondary' : 'ghost'}
            >
              {item[0]?.toUpperCase()}
              {item.slice(1)}
            </Button>
          ))}
        </nav>
        <section aria-label={`${tab} settings`} className="min-h-0 overflow-y-auto">
          <SettingsPanel tab={tab} />
        </section>
      </div>
    </Dialog>
  )
}
