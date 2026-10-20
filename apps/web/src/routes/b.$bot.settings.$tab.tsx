import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import {
  BellRing,
  BookOpen,
  Brain,
  Cpu,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Wrench
} from 'lucide-react'
import { useEffect, useState } from 'react'

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
import { botFace } from '../lib/avatar-builder'
import { useChatSelection } from '../lib/use-chat-selection'
import { useBots } from '../stores/bots'
import { sectionsActions } from '../stores/sections'
import { useSettings } from '../stores/settings'
import { uiActions } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/settings/$tab')({
  // A removed tab, such as Sections from before chats, opens Profile.
  beforeLoad: ({ params }) => {
    if (!isBotSettingsTab(params.tab)) {
      throw redirect({
        params: { bot: params.bot, tab: 'profile' },
        replace: true,
        to: '/b/$bot/settings/$tab'
      })
    }
  },
  component: BotSettingsDialog,
  validateSearch: (search: Record<string, unknown>): { connector?: string } =>
    typeof search.connector === 'string' && search.connector ? { connector: search.connector } : {}
})

const ICONS: Record<BotSettingsTab, SettingsTabItem['icon']> = {
  advanced: SlidersHorizontal,
  approvals: ShieldCheck,
  checkins: BellRing,
  connectors: Plug,
  memory: Brain,
  model: Cpu,
  persona: Sparkles,
  profile: UserRound,
  skills: BookOpen,
  tools: Wrench
}

const GROUPS: { ids: BotSettingsTab[]; label?: string }[] = [
  { ids: ['profile', 'persona', 'model'] },
  { ids: ['memory', 'tools', 'connectors', 'skills'], label: 'Abilities' },
  { ids: ['approvals', 'checkins', 'advanced'], label: 'Manage' }
]

/** Only the primary bot checks in, so only its settings show Check-ins, and only on a daemon that has them. */
function tabsFor(primary: boolean): SettingsTabGroup<BotSettingsTab>[] {
  return GROUPS.map(group => ({
    items: group.ids
      .filter(id => primary || id !== 'checkins')
      .map(id => ({ icon: ICONS[id], id, label: TAB_LABELS[id] })),
    label: group.label
  }))
}

function BotSettingsDialog() {
  const { bot: botName, tab } = Route.useParams()
  const { connector } = Route.useSearch()
  const navigate = useNavigate()
  const bot = useBots(state => state.byName[botName])
  const loaded = useBots(state => state.loaded)
  const refresh = useBots(state => state.refresh)
  const { startSelection } = useChatSelection()
  const [closeError, setCloseError] = useState<string | null>(null)
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

  const close = async () => {
    const current = startSelection()
    const missing = () => useBots.getState().loaded && !useBots.getState().byName[botName]

    const exitMissing = () => {
      if (!current() || !missing()) {
        return false
      }

      // Home restores the remembered chat. Forget only this deleted bot's pick.
      if (uiActions().lastSection?.bot === botName) {
        uiActions().setLastSection(null)
      }

      void navigate({ to: '/' })

      return true
    }

    setCloseError(null)

    if (exitMissing()) {
      return
    }

    // Without a roster this bot may or may not exist: look nothing up and
    // forget nothing. Home restores the remembered chat, which checks itself.
    if (!useBots.getState().loaded && !useBots.getState().byName[botName]) {
      void navigate({ to: '/' })

      return
    }

    try {
      const section = await sectionsActions().chat(botName, () => current() && !missing())

      if (current() && !exitMissing() && section) {
        void navigate({ params: { bot: botName, section: section.id }, to: '/b/$bot/s/$section' })
      }
    } catch (error) {
      if (current() && !exitMissing()) {
        setCloseError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  // A daemon from before check-ins sends no check-in settings.
  const checkins = useSettings(state => state.settings?.checkin_enabled !== undefined)
  const showCheckins = bot?.primary === true && checkins
  const current = isBotSettingsTab(tab) && (tab !== 'checkins' || showCheckins) ? tab : 'profile'

  const name = bot?.display_name ?? botName

  return (
    <>
      <AppShell />
      <SettingsShell
        closeLabel="Close bot settings"
        current={current}
        header={
          <div className="mr-2 flex shrink-0 items-center gap-2.5 sm:mr-0 sm:mb-4 sm:px-3 sm:pt-2">
            {bot ? <Avatar {...botFace(bot)} name={name} size="md" /> : null}
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
        onClose={() => void close()}
        onSelect={item =>
          void navigate({ params: { bot: botName, tab: item }, to: '/b/$bot/settings/$tab' })
        }
        tabs={tabsFor(showCheckins)}
      >
        {closeError ? (
          <p className="px-6 pt-4 text-danger" role="alert">
            {closeError}
          </p>
        ) : null}
        {bot ? (
          <BotSettingsPanel bot={bot} connector={connector} tab={current} />
        ) : (
          <p className="p-10 text-muted">{loaded ? 'This bot no longer exists.' : 'Loading…'}</p>
        )}
      </SettingsShell>
    </>
  )
}
