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
      className="h-[min(42rem,86vh)]"
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
      <div className="grid h-full grid-cols-[180px_1fr]">
        <nav aria-label="Settings tabs" className="border-r border-border p-3">
          {visibleTabs.map(item => (
            <Button
              className="mb-1 w-full justify-start"
              key={item}
              onClick={() => void navigate({ to: '/settings/$tab', params: { tab: item } })}
              variant={tab === item ? 'secondary' : 'ghost'}
            >
              {item[0]?.toUpperCase()}
              {item.slice(1)}
            </Button>
          ))}
        </nav>
        <section aria-label={`${tab} settings`} className="min-h-0 overflow-y-auto p-5">
          <SettingsPanel tab={tab} />
        </section>
      </div>
    </Dialog>
  )
}
