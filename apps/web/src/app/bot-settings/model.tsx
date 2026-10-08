import { useEffect, useRef, useState } from 'react'

import { Select } from '../../components/ui/select'
import { providerModels } from '../../lib/api'
import { reasoningOptions, runningLevel } from '../../lib/reasoning'
import type { Bot, ModelOption, ReasoningEffort } from '../../lib/types'
import { useSettings } from '../../stores/settings'

import { errorText, Group, Heading, Row, type SaveBot } from './shared'

export function ModelTab({ bot, onSave }: { bot: Bot; onSave: SaveBot }) {
  const [loaded, setLoaded] = useState<{ list: ModelOption[]; provider: string }>({
    list: [],
    provider: ''
  })

  const [error, setError] = useState<string | null>(null)
  const providerRows = useSettings(state => state.providers)
  const refreshProviders = useSettings(state => state.refreshProviders)

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  // Each provider is asked for its current list; the daemon falls back to its catalog.
  useEffect(() => {
    const provider = bot.provider

    if (!provider || provider === loaded.provider) {
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
  }, [bot.provider, loaded.provider])

  const models = bot.provider === loaded.provider ? loaded.list : []

  // Only providers with a key or sign-in; the bot's own stays listed so it reads correctly.
  const providers = providerRows.filter(row => row.configured || row.id === bot.provider)

  // Only the latest provider choice may save; an earlier, slower one is dropped.
  const latestSwitch = useRef(0)

  const switchProvider = async (provider: string) => {
    const request = ++latestSwitch.current

    try {
      const list = await providerModels(provider)

      if (request !== latestSwitch.current) {
        return
      }

      const model = list.find(item => item.id === bot.model) ?? list[0]
      const label = providerRows.find(row => row.id === provider)?.label ?? provider

      // A provider without a model to run would leave the bot on another provider's model.
      if (!model) {
        setError(`${label} lists no models right now. The bot stays where it is.`)

        return
      }

      setLoaded({ list, provider })
      await onSave({ model: model.id, provider })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const current = models.find(item => item.id === bot.model)
  const level = runningLevel(bot.reasoning_effort ?? 'medium', current)

  const detail = (text: string) => (
    <span className="text-[length:var(--text-secondary)] text-muted">{text}</span>
  )

  return (
    <div>
      <Heading description="Which provider and model this bot thinks with, and how hard. Keys live in Settings, Providers.">
        Model
      </Heading>
      <div className="space-y-8">
        <Group footer="Changes apply from the next message, in every section still on this model.">
          <Row
            control={
              <div className="w-[min(280px,42vw)]">
                <Select
                  label="Provider"
                  onValueChange={provider => void switchProvider(provider)}
                  options={providers.map(row => ({ label: row.label, value: row.id }))}
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
                  onValueChange={model => void onSave({ model, provider: bot.provider ?? undefined })}
                  options={models.map(item => ({ label: item.label, value: item.id }))}
                  placeholder="Choose a model"
                  value={current ? current.id : undefined}
                />
              </div>
            }
            title="Model"
          />
        </Group>
        <Group footer="Higher levels think longer and use more tokens. The list shows the levels this model supports.">
          <Row
            control={
              <div className="w-[min(280px,42vw)]">
                <Select
                  label="Reasoning"
                  onValueChange={value =>
                    void onSave({ reasoning_effort: value as ReasoningEffort })
                  }
                  options={reasoningOptions(current)}
                  value={level}
                />
              </div>
            }
            title="Reasoning"
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
