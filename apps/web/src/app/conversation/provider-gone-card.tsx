import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { providerModels } from '../../lib/api'
import type { Bot, ModelOption } from '../../lib/types'
import { botsActions } from '../../stores/bots'
import { useSettings } from '../../stores/settings'
import { errorText } from '../bot-settings/shared'

/** A bot whose provider lost its key or sign-in: nothing it says can reach a model. */
export function providerGone(bot: Bot | undefined): bot is Bot {
  return Boolean(bot?.provider) && bot?.provider_connected === false
}

/**
 * Sits above the composer while the bot's provider is gone, before the user
 * types: a connected provider and one of its models, and the bot moves there
 * from its next message. Keys live in Settings, Providers.
 */
export function ProviderGoneCard({ bot }: { bot: Bot }) {
  const providers = useSettings(state => state.providers)
  const refreshProviders = useSettings(state => state.refreshProviders)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')

  const [loaded, setLoaded] = useState<{ list: ModelOption[]; provider: string }>({
    list: [],
    provider: ''
  })

  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  // Each provider is asked for its current list; the daemon falls back to its catalog.
  useEffect(() => {
    if (!provider) {
      return
    }

    let current = true
    setError(null)
    void providerModels(provider)
      .then(list => current && setLoaded({ list, provider }))
      .catch(cause => current && setError(errorText(cause)))

    return () => {
      current = false
    }
  }, [provider])

  const connected = providers.filter(row => row.configured === true)
  const gone = providers.find(row => row.id === bot.provider)?.label ?? bot.provider
  const models = loaded.provider === provider ? loaded.list : []

  const save = async () => {
    setSaving(true)
    setError(null)

    try {
      await botsActions().update(bot.name, { model, provider })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      aria-label="Choose a model"
      className="mb-2 rounded-[18px] border border-border bg-background px-3.5 py-3 shadow-sm"
      data-testid="provider-gone"
      role="group"
    >
      <div className="flex items-center gap-2.5">
        <Sparkles aria-hidden className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{gone} is no longer connected</div>
          <div className="text-[length:var(--text-secondary)] text-muted">
            {connected.length
              ? `Choose a provider and model for ${bot.display_name} to continue, or add the key again in Settings, Providers.`
              : 'No provider is connected. Add one in Settings, Providers.'}
          </div>
        </div>
      </div>
      {connected.length ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <div className="w-[min(220px,100%)]">
            <Select
              label="Provider"
              onValueChange={next => {
                // The old provider's models must not be saved with the new provider.
                setModel('')
                setProvider(next)
              }}
              options={connected.map(row => ({ label: row.label, value: row.id }))}
              placeholder="Provider"
              value={provider || undefined}
            />
          </div>
          <div className="w-[min(220px,100%)]">
            <Select
              disabled={!provider}
              label="Model"
              onValueChange={setModel}
              options={models.map(item => ({ label: item.label, value: item.id }))}
              placeholder="Model"
              value={model || undefined}
            />
          </div>
          <Button
            busy={saving}
            disabled={!provider || !model}
            onClick={() => void save()}
            size="sm"
            variant="primary"
          >
            Use this model
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
