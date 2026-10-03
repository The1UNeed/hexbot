import { useEffect, useMemo, useState } from 'react'

import { Select } from '../../components/ui/select'
import { modelsList } from '../../lib/api'
import type { Bot, ModelOption } from '../../lib/types'
import { useSettings } from '../../stores/settings'

import { errorText, Group, Heading, Row, type SaveBot } from './shared'

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

  const detail = (text: string) => (
    <span className="text-[length:var(--text-secondary)] text-muted">{text}</span>
  )

  return (
    <div>
      <Heading description="Which provider and model this bot thinks with. Keys live in Settings, Providers.">
        Model
      </Heading>
      <div className="space-y-8">
        <Group>
          <Row
            control={
              <div className="w-[min(280px,42vw)]">
                <Select
                  label="Provider"
                  onValueChange={provider => void onSave({ provider })}
                  options={providers.map(provider => ({
                    label: providerLabel(provider),
                    value: provider
                  }))}
                  placeholder="Choose a provider"
                  value={bot.provider ?? undefined}
                />
              </div>
            }
            title="Provider"
          />
          <Row
            control={
              <div className="w-[min(280px,42vw)]">
                <Select
                  label="Model"
                  onValueChange={model => {
                    // The same id can exist under several providers; keep the chosen one.
                    const found =
                      visible.find(item => item.id === model) ??
                      ordered.find(item => item.id === model)

                    void onSave({
                      model,
                      ...(found?.provider ? { provider: found.provider } : {})
                    })
                  }}
                  options={visible.map(item => ({ label: item.label, value: item.id }))}
                  placeholder="Choose a model"
                  value={bot.model ?? undefined}
                />
              </div>
            }
            title="Model"
          />
        </Group>
        {current && (current.input_cost || current.output_cost || current.context) ? (
          <Group title="About this model">
            {current.context ? (
              <Row control={detail(`${current.context.toLocaleString()} tokens`)} title="Context" />
            ) : null}
            {current.input_cost ? (
              <Row control={detail(`${current.input_cost} per million tokens`)} title="Input" />
            ) : null}
            {current.output_cost ? (
              <Row control={detail(`${current.output_cost} per million tokens`)} title="Output" />
            ) : null}
          </Group>
        ) : null}
        {error ? (
          <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
