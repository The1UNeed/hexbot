import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { useEffect } from 'react'

import { AppShell } from '../app/app-shell'
import {
  BOT_SETTINGS_TABS,
  BotSettingsPanel,
  isBotSettingsTab,
  rememberTab,
  TAB_LABELS
} from '../app/bot-settings'
import { Avatar } from '../components/ui/avatar'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { avatarSrc } from '../lib/avatar-builder'
import { useBots } from '../stores/bots'
import { useUi } from '../stores/ui'

export const Route = createFileRoute('/b/$bot/settings/$tab')({
  component: BotSettingsDialog,
  validateSearch: (search: Record<string, unknown>): { connector?: string } =>
    typeof search.connector === 'string' && search.connector ? { connector: search.connector } : {}
})

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
    const section =
      lastSection?.bot === botName ? lastSection.section : bot?.sections_recent[0]?.id

    void (section
      ? navigate({ params: { bot: botName, section }, to: '/b/$bot/s/$section' })
      : navigate({ to: '/' }))
  }

  const current = isBotSettingsTab(tab) ? tab : 'profile'

  return (
    <>
      <AppShell />
      <Dialog
        className="h-[min(56rem,92vh)] max-h-[92vh] w-[min(76rem,94vw)]"
        onOpenChange={open => !open && close()}
        open
        title={
          <span className="flex items-center gap-2.5">
            {bot ? <Avatar image={avatarSrc(bot.avatar)} name={bot.display_name} size="sm" /> : null}
            <span>{bot?.display_name ?? botName}</span>
            <span className="font-normal text-muted">Bot settings</span>
          </span>
        }
        toolbar={
          <Button
            aria-label="Close bot settings"
            icon={<X size={16} />}
            onClick={close}
            size="sm"
            variant="ghost"
          />
        }
      >
        <div className="grid h-full grid-rows-[auto_1fr] sm:grid-cols-[208px_1fr] sm:grid-rows-1">
          <nav
            aria-label="Bot settings tabs"
            className="flex gap-1 overflow-x-auto border-b border-border p-2 sm:block sm:border-r sm:border-b-0 sm:p-3"
          >
            {BOT_SETTINGS_TABS.map(item => (
              <Button
                aria-current={current === item ? 'page' : undefined}
                className="shrink-0 justify-start sm:mb-1 sm:w-full"
                key={item}
                onClick={() =>
                  void navigate({
                    params: { bot: botName, tab: item },
                    to: '/b/$bot/settings/$tab'
                  })
                }
                variant={current === item ? 'secondary' : 'ghost'}
              >
                {TAB_LABELS[item]}
              </Button>
            ))}
          </nav>
          <section aria-label={`${current} bot settings`} className="min-h-0 overflow-y-auto">
            {bot ? (
              <BotSettingsPanel bot={bot} connector={connector} tab={current} />
            ) : (
              <p className="p-8 text-muted">{loaded ? 'This bot no longer exists.' : 'Loading…'}</p>
            )}
          </section>
        </div>
      </Dialog>
    </>
  )
}
