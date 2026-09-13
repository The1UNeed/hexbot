import { useNavigate } from '@tanstack/react-router'
import { ChevronsRight, Settings } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Chip } from '../../components/ui/chip'
import { Switch } from '../../components/ui/switch'
import { cn } from '../../lib/cn'
import { useBots } from '../../stores/bots'
import { useUi } from '../../stores/ui'
import { rememberedTab } from '../bot-settings'
import { AvatarPicker, cardClass, errorText, IdentityFields } from '../bot-settings/shared'

/**
 * The right panel: a glance at the bot. Name, label, description, whether it
 * may notify you, and the door to the Bot settings window. Status lives in
 * the chat; everything else lives in the window.
 */
export function ProfilePanel(): React.JSX.Element {
  const selectedName = useUi(state => state.lastSection?.bot ?? null)
  const bot = useBots(state => (selectedName ? state.byName[selectedName] : undefined))
  const updateBot = useBots(state => state.update)
  const closePanel = useUi(state => state.toggleRightPanel)
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  if (!bot) {
    return (
      <div className="grid h-full place-content-center p-5 text-center text-muted">
        Select a bot to see its settings.
      </div>
    )
  }

  const save = async (patch: Parameters<typeof updateBot>[1]) => {
    try {
      setError(null)
      await updateBot(bot.name, patch)
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const openSettings = () =>
    void navigate({
      params: { bot: bot.name, tab: rememberedTab(bot.name) },
      to: '/b/$bot/settings/$tab'
    })

  return (
    <div className="flex h-screen min-h-0 flex-col" data-testid="profile-panel">
      <header className="hex-drag flex h-11 shrink-0 items-center px-2">
        <span className="size-7" />
        <span className="flex-1 truncate text-center text-[length:var(--text-secondary)] font-semibold">
          {bot.display_name}
        </span>
        <button
          aria-label="Hide settings"
          className="hex-no-drag grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          onClick={() => closePanel(false)}
          type="button"
        >
          <ChevronsRight size={16} />
        </button>
      </header>
      <div className="hex-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-4">
        <AvatarPicker bot={bot} onSave={save} />
        <div className="mt-2.5 flex flex-col items-center gap-1">
          <span className="text-[length:var(--text-heading)] font-semibold">{bot.display_name}</span>
          <span className="flex items-center gap-1.5">
            {bot.title ? <Chip>{bot.title}</Chip> : null}
            {bot.model ? (
              <span className="text-[length:var(--text-meta)] text-muted">{bot.model}</span>
            ) : null}
          </span>
        </div>
        <div className="mt-5">
          <IdentityFields bot={bot} onSave={save} />
        </div>
        {error ? (
          <p className="mt-3 text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className={cn(cardClass, 'mt-5 flex items-center justify-between gap-3 px-3 py-2.5')}>
          <span>
            <span className="block font-medium">Notify me</span>
            <span className="block text-[length:var(--text-meta)] text-muted">
              When {bot.display_name} stops or needs you
            </span>
          </span>
          <Switch
            aria-label="Notify me when this bot stops or needs me"
            checked={bot.notify ?? true}
            onCheckedChange={checked => void save({ notify: checked })}
          />
        </div>
        <div className="mt-auto pt-5">
          <Button className="w-full" icon={<Settings size={15} />} onClick={openSettings}>
            Bot settings
          </Button>
          <p className="mt-2 text-center text-[length:var(--text-meta)] text-muted">
            Persona, Model, Memory, Tools, Connectors, Skills
          </p>
        </div>
      </div>
    </div>
  )
}
