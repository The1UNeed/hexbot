import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  Archive,
  Brain,
  Download,
  Gauge,
  Globe,
  Info,
  KeyRound,
  ShieldCheck,
  SunMoon,
  Users,
  Wifi
} from 'lucide-react'

import { AppShell } from '../app/app-shell'
import { SettingsPanel, type SettingsTab } from '../app/settings'
import {
  SettingsShell,
  type SettingsTabGroup,
  type SettingsTabItem
} from '../components/ui/settings-shell'
import { useUsers } from '../stores/users'

export const Route = createFileRoute('/settings/$tab')({ component: SettingsDialog })

const ITEMS: Record<SettingsTab, SettingsTabItem<SettingsTab>> = {
  about: { icon: Info, id: 'about', label: 'About' },
  archive: { icon: Archive, id: 'archive', label: 'Archive' },
  appearance: { icon: SunMoon, id: 'appearance', label: 'Appearance' },
  approvals: { icon: ShieldCheck, id: 'approvals', label: 'Approvals' },
  connect: { icon: Globe, id: 'connect', label: 'Hex Connect' },
  memory: { icon: Brain, id: 'memory', label: 'Memory' },
  network: { icon: Wifi, id: 'network', label: 'Network' },
  providers: { icon: KeyRound, id: 'providers', label: 'Providers' },
  updates: { icon: Download, id: 'updates', label: 'Updates' },
  usage: { icon: Gauge, id: 'usage', label: 'Usage' },
  users: { icon: Users, id: 'users', label: 'Users' }
}

const GROUPS: { ids: SettingsTab[]; label: string }[] = [
  { ids: ['providers', 'usage'], label: 'Models' },
  { ids: ['network', 'connect', 'users'], label: 'Devices' },
  { ids: ['memory', 'archive', 'approvals', 'appearance'], label: 'You' },
  { ids: ['updates', 'about'], label: 'App' }
]

function SettingsDialog() {
  const { tab } = Route.useParams()
  const navigate = useNavigate()
  const supported = useUsers(state => state.supported)
  const current = useUsers(state => state.current)
  const usageSupported = useUsers(state => state.usageSupported)

  const visible = (item: SettingsTab) =>
    item === 'users'
      ? Boolean(supported && current?.role === 'admin')
      : item === 'usage'
        ? Boolean(usageSupported)
        : true

  const tabs: SettingsTabGroup<SettingsTab>[] = GROUPS.map(group => ({
    items: group.ids.filter(visible).map(id => ITEMS[id]),
    label: group.label
  }))

  return (
    <>
      <AppShell />
      <SettingsShell
        closeLabel="Close settings"
        current={tab as SettingsTab}
        label="Settings"
        navLabel="Settings tabs"
        onClose={() => void navigate({ to: '/' })}
        onSelect={item => void navigate({ to: '/settings/$tab', params: { tab: item } })}
        tabs={tabs}
      >
        <SettingsPanel tab={tab} />
      </SettingsShell>
    </>
  )
}
