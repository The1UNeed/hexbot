import { useEffect, useMemo, useState } from 'react'

import { Select } from '../../components/ui/select'
import { modelsList } from '../../lib/api'
import type { Bot, ModelOption } from '../../lib/types'
import { useSettings } from '../../stores/settings'

import { errorText, fieldLabel, Heading, type SaveBot } from './shared'

export function ModelTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [models, setModels] = useState<{ all: ModelOption[]; curated: ModelOption[] }>({
    all: [],
    curated: []
  })

  const [error, setError] = useState<string | null>(null)
  const providerRows = useSettings(state => state.providers)
  const refreshProviders = useSettings(state => state.refreshProviders)
  useEffect(() => {
    void modelsList()
      .then(setModels)
      .catch(cause => setError(errorText(cause)))

    if (!providerRows.length) {
      void refreshProviders()
    }
  }, [providerRows.length, refreshProviders])
  const providerLabel = (id: string) => providerRows.find(row => row.id === id)?.label ?? id

  const ordered = useMemo(() => {
    const ids = new Set(models.curated.map(item => `${item.provider}:${item.id}`))

    return [
      ...models.curated.map(item => ({ ...item, label: `Recommended · ${item.label}` })),
      ...models.all.filter(item => !ids.has(`${item.provider}:${item.id}`))
    ]
  }, [models])

  const providers = [
    ...new Set(ordered.map(item => item.provider).filter((item): item is string => Boolean(item)))
  ]

  const visible = ordered.filter(item => !bot.provider || item.provider === bot.provider)
  const current = visible.find(item => item.id === bot.model)

  return (
    <div>
      <Heading description="Which provider and model this bot thinks with. Keys are set once in Settings, Providers.">
        Model
      </Heading>
      <div className="grid max-w-xl gap-4">
        <label className="block">
          <span className={fieldLabel}>Provider</span>
          <Select
            label="Provider"
            onValueChange={provider => void onSave({ provider })}
            options={providers.map(provider => ({ label: providerLabel(provider), value: provider }))}
            placeholder="Choose a provider"
            value={bot.provider ?? undefined}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>Model</span>
          <Select
            label="Model"
            onValueChange={model => {
              const found = ordered.find(item => item.id === model)
              void onSave({ model, ...(found?.provider ? { provider: found.provider } : {}) })
            }}
            options={visible.map(item => ({ label: item.label, value: item.id }))}
            placeholder="Choose a model"
            value={bot.model ?? undefined}
          />
        </label>
        {current && (current.input_cost || current.output_cost || current.context) ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[length:var(--text-secondary)]">
            {current.context ? (
              <>
                <dt className="text-muted">Context</dt>
                <dd>{current.context.toLocaleString()} tokens</dd>
              </>
            ) : null}
            {current.input_cost ? (
              <>
                <dt className="text-muted">Input</dt>
                <dd>{current.input_cost} per million tokens</dd>
              </>
            ) : null}
            {current.output_cost ? (
              <>
                <dt className="text-muted">Output</dt>
                <dd>{current.output_cost} per million tokens</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {error && (
          <p className="text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
