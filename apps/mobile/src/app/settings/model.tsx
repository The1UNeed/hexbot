import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'

import { CheckRow, Group, ListScroll } from '../../components/list'
import { errorText, Lead, PageState } from '../../components/settings/kit'
import { modelsList } from '../../lib/api'
import type { ModelOption, Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'

interface ProviderModels {
  error?: string
  models: ModelOption[]
  provider: Provider
}

/**
 * Pick the default or the fallback model from the providers that have a
 * key. Saves on tap and goes back.
 */
export default function ModelPicker() {
  const { kind } = useLocalSearchParams<{ kind?: string }>()
  const fallback = kind === 'fallback'
  const settings = useSettings(state => state.settings)
  const patch = useSettings(state => state.patch)
  const [lists, setLists] = useState<null | ProviderModels[]>(null)
  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState<null | string>(null)

  useEffect(() => {
    let live = true

    void useSettings
      .getState()
      .refreshProviders()
      .then(() => {
        const configured = useSettings.getState().providers.filter(item => item.configured === true)

        return Promise.all(
          configured.map(provider =>
            modelsList(provider.id)
              .then(result => ({ error: result.error, models: result.curated.length ? result.curated : result.all, provider }))
              .catch(caught => ({ error: errorText(caught), models: [] as ModelOption[], provider }))
          )
        )
      })
      .then(next => live && setLists(next))
      .catch(caught => live && setError(errorText(caught)))

    return () => {
      live = false
    }
  }, [])

  const current = fallback ? (settings?.fallback_model ?? null) : (settings?.default_model ?? null)

  const choose = async (value: null | string) => {
    if (value === current) {
      router.back()

      return
    }

    setSaving(value ?? '')
    setError(null)

    try {
      await patch(fallback ? { fallback_model: value } : { default_model: value })
      router.back()
    } catch (caught) {
      setError(errorText(caught))
      setSaving(null)
    }
  }

  const selected = saving === null ? current : saving || null

  return (
    <>
      <Stack.Screen options={{ title: fallback ? 'Fallback' : 'Default model' }} />
      <ListScroll testID="model-picker">
        <Lead>{fallback ? 'Bots switch to this model when their own provider fails.' : 'New bots start on this model.'}</Lead>
        {error ? <Lead>{error}</Lead> : null}
        {!lists ? (
          <PageState error={error} />
        ) : (
          <>
            {fallback ? (
              <Group>
                <CheckRow checked={selected === null} onPress={() => void choose(null)} testID="model-none" title="None" />
              </Group>
            ) : null}
            {[...lists]
              .sort((a, b) => Number(current?.startsWith(`${b.provider.id}/`)) - Number(current?.startsWith(`${a.provider.id}/`)))
              .map(({ error: listError, models, provider }) => (
              <Group error={listError && !models.length ? listError : null} key={provider.id} label={provider.label}>
                {models
                  .filter(model => !fallback || `${provider.id}/${model.id}` !== settings?.default_model)
                  .map(model => {
                    const value = `${provider.id}/${model.id}`

                    return (
                      <CheckRow
                        checked={selected === value}
                        disabled={saving !== null}
                        key={value}
                        onPress={() => void choose(value)}
                        testID={`model-${value}`}
                        title={model.label}
                      />
                    )
                  })}
              </Group>
            ))}
            {!lists.length ? <Lead>Add a key to a provider first. Its models show up here.</Lead> : null}
          </>
        )}
      </ListScroll>
    </>
  )
}
