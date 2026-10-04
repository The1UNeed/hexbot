import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  BookOpen,
  Brain,
  Cpu,
  MessagesSquare,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Wrench
} from 'lucide-react'
import { useEffect } from 'react'

import { AppShell } from '../app/app-shell'
import {
  BotSettingsPanel,
  type BotSettingsTab,
  isBotSettingsTab,
  rememberTab,
  TAB_LABELS
} from '../app/bot-settings'
import { Avatar } from '../components/ui/avatar'
import {
  SettingsShell,
  type SettingsTabGroup,
  type SettingsTabItem
} from '../components/ui/settings-shell'
import { avatarSrc } from '../lib/avatar-builder'
import { useBots } from '../stores/bots'
import { useUi } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/settings/$tab')({
  component: BotSettingsDialog,
  validateSearch: (search: Record<string, unknown>): { connector?: string } =>
    typeof search.connector === 'string' && search.connector ? { connector: search.connector } : {}
})

const ICONS: Record<BotSettingsTab, SettingsTabItem['icon']> = {
  advanced: SlidersHorizontal,
  approvals: ShieldCheck,
  connectors: Plug,
  memory: Brain,
  model: Cpu,
  persona: Sparkles,
  profile: UserRound,
  sections: MessagesSquare,
  skills: BookOpen,
  tools: Wrench
}

const GROUPS: { ids: BotSettingsTab[]; label?: string }[] = [
  { ids: ['profile', 'persona', 'model'] },
  { ids: ['memory', 'tools', 'connectors', 'skills'], label: 'Abilities' },
  { ids: ['approvals', 'sections', 'advanced'], label: 'Manage' }
]

const TABS: SettingsTabGroup<BotSettingsTab>[] = GROUPS.map(group => ({
  items: group.ids.map(id => ({ icon: ICONS[id], id, label: TAB_LABELS[id] })),
  label: group.label
}))

function BotSettingsDialog() {
  const { bot: botName, tab } = Route.useParams()
  const { connector } = Route.useSearch()
  const navigate = useNavigate()
  const bot = useBots(state => state.byName[botName])
  const loaded = useBots(state => state.loaded)
  const refresh = useBots(state => state.refresh)
  const lastSection = useUi(state => state.lastSection)
  useEffect(() => {
    if (!loaded) {
      void refresh()
    }
  }, [loaded, refresh])
  useEffect(() => {
    if (isBotSettingsTab(tab)) {
      rememberTab(botName, tab)
    }
  }, [botName, tab])

  const close = () => {
    const section = lastSection?.bot === botName ? lastSection.section : bot?.sections_recent[0]?.id

    void (section
      ? navigate({ params: { bot: botName, section }, to: '/b/$bot/s/$section' })
      : navigate({ to: '/' }))
  }

  const current = isBotSettingsTab(tab) ? tab : 'profile'
  const name = bot?.display_name ?? botName

  return (
    <>
      <AppShell />
      <SettingsShell
        closeLabel="Close bot settings"
        current={current}
        header={
          <div className="mr-2 flex shrink-0 items-center gap-2.5 sm:mr-0 sm:mb-4 sm:px-3 sm:pt-2">
            {bot ? <Avatar image={avatarSrc(bot.avatar)} name={name} size="md" /> : null}
            <span className="min-w-0">
              <span className="block truncate text-[length:var(--text-body)] font-semibold">
                {name}
              </span>
              <span className="hidden text-[length:var(--text-meta)] text-muted sm:block">
                Bot settings
              </span>
            </span>
          </div>
        }
        label={`${name} bot settings`}
        navLabel="Bot settings tabs"
        onClose={close}
        onSelect={item =>
          void navigate({ params: { bot: botName, tab: item }, to: '/b/$bot/settings/$tab' })
        }
        tabs={TABS}
      >
        {bot ? (
          <BotSettingsPanel bot={bot} connector={connector} tab={current} />
        ) : (
          <p className="p-10 text-muted">{loaded ? 'This bot no longer exists.' : 'Loading…'}</p>
        )}
      </SettingsShell>
    </>
  )
}
