import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import type { Bot } from '../../lib/types'
import { useBots } from '../../stores/bots'

import { AdvancedTab } from './advanced'
import { ApprovalsTab } from './approvals'
import { ConnectorsTab } from './connectors'
import { MemoryTab } from './memory'
import { ModelTab } from './model'
import { PersonaTab } from './persona'
import { ProfileTab } from './profile'
import { SectionsTab } from './sections'
import { errorText } from './shared'
import { SkillsTab } from './skills'
import { ToolsTab } from './tools'

export const BOT_SETTINGS_TABS = [
  'profile',
  'persona',
  'model',
  'memory',
  'tools',
  'connectors',
  'skills',
  'approvals',
  'sections',
  'advanced'
] as const

export type BotSettingsTab = (typeof BOT_SETTINGS_TABS)[number]

export const TAB_LABELS: Record<BotSettingsTab, string> = {
  advanced: 'Advanced',
  approvals: 'Approvals',
  connectors: 'Connectors',
  memory: 'Memory',
  model: 'Model',
  persona: 'Persona',
  profile: 'Profile',
  sections: 'Sections',
  skills: 'Skills',
  tools: 'Tools'
}

const TAB_KEY = 'hexbot.ui.botSettingsTab.'

export function isBotSettingsTab(value: string): value is BotSettingsTab {
  return (BOT_SETTINGS_TABS as readonly string[]).includes(value)
}

/** The tab the window last showed for this bot, or Profile. */
export function rememberedTab(bot: string): BotSettingsTab {
  try {
    const saved = localStorage.getItem(TAB_KEY + bot)

    return saved && isBotSettingsTab(saved) ? saved : 'profile'
  } catch {
    return 'profile'
  }
}

export function rememberTab(bot: string, tab: BotSettingsTab): void {
  try {
    localStorage.setItem(TAB_KEY + bot, tab)
  } catch {
    // Private windows may refuse storage; the default tab is fine.
  }
}

/** Complete window body; the file route owns the dialog and navigation. */
export function BotSettingsPanel({
  bot,
  connector,
  tab
}: {
  bot: Bot
  /** Connector id to open in the set-up sheet (from `?connector=`). */
  connector?: string
  tab: BotSettingsTab
}): React.JSX.Element {
  const updateBot = useBots(state => state.update)
  const removeBot = useBots(state => state.remove)
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  const save = async (patch: Parameters<typeof updateBot>[1]) => {
    try {
      setError(null)
      await updateBot(bot.name, patch)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const remove = async () => {
    await removeBot(bot.name)
    await navigate({ to: '/' })
  }

  return (
    <section aria-label={`${TAB_LABELS[tab]} bot settings`} className="min-w-0 max-w-3xl p-8">
      {tab === 'profile' && <ProfileTab bot={bot} onSave={save} />}
      {tab === 'persona' && <PersonaTab bot={bot} onSave={save} />}
      {tab === 'model' && <ModelTab bot={bot} onSave={save} />}
      {tab === 'memory' && <MemoryTab bot={bot} onSave={save} />}
      {tab === 'tools' && <ToolsTab bot={bot} onSave={save} />}
      {tab === 'connectors' && <ConnectorsTab bot={bot} initialConnector={connector} />}
      {tab === 'skills' && <SkillsTab bot={bot} onSave={save} />}
      {tab === 'approvals' && <ApprovalsTab bot={bot} onSave={save} />}
      {tab === 'sections' && <SectionsTab botName={bot.name} />}
      {tab === 'advanced' && <AdvancedTab bot={bot} onDelete={remove} />}
      {error ? (
        <p className="mt-4 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export { DreamingBlock, MemorySectionEditor, MemoryTab } from './memory'
