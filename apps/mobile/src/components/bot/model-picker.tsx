/**
 * Provider and model as two grouped lists of check rows. The curated models
 * sit on top as "Recommended"; context and price show when the daemon knows
 * them. Used by the new bot sheet and the Model page.
 */

import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native'

import { modelsList } from '../../lib/api'
import type { ModelOption, Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'
import { Icon } from '../icon'
import { CheckRow, Group } from '../list'

export interface ModelChoice {
  model: string
  provider: string
}

const SEARCH_FROM = 20

export function formatContext(tokens?: number): null | string {
  if (!tokens) {
    return null
  }

  return tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M context`
    : `${Math.round(tokens / 1000)}K context`
}

export function modelDetail(model?: ModelOption): null | string {
  if (!model) {
    return null
  }

  const parts = [formatContext(model.context)]

  if (model.input_cost || model.output_cost) {
    parts.push(`${model.input_cost ?? 0} in, ${model.output_cost ?? 0} out per 1M tokens`)
  }

  return parts.filter(Boolean).join(' · ') || null
}

/** Providers worth offering: the configured ones, plus whatever is chosen now. */
export function useProviderChoices(current?: null | string): Provider[] {
  const providers = useSettings(state => state.providers)

  useEffect(() => {
    void useSettings
      .getState()
      .refreshProviders()
      .catch(() => undefined)
  }, [])

  return useMemo(() => providers.filter(item => item.configured !== false || item.id === current), [current, providers])
}

export function useModels(provider: null | string) {
  const [state, setState] = useState<{ all: ModelOption[]; curated: ModelOption[]; error: null | string; loading: boolean }>({
    all: [],
    curated: [],
    error: null,
    loading: true
  })

  useEffect(() => {
    if (!provider) {
      setState({ all: [], curated: [], error: null, loading: false })

      return
    }

    let live = true

    setState(current => ({ ...current, error: null, loading: true }))
    void modelsList(provider)
      .then(result => {
        if (live) {
          setState({
            all: (result.all ?? []).filter(item => !item.provider || item.provider === provider),
            curated: (result.curated ?? []).filter(item => !item.provider || item.provider === provider),
            error: null,
            loading: false
          })
        }
      })
      .catch(error => live && setState({ all: [], curated: [], error: error instanceof Error ? error.message : String(error), loading: false }))

    return () => {
      live = false
    }
  }, [provider])

  return state
}

export function ModelPicker({ onChange, value }: { onChange: (choice: ModelChoice) => void; value: ModelChoice }) {
  const { colors } = useTheme()
  const providers = useProviderChoices(value.provider)
  const models = useModels(value.provider || null)
  const [query, setQuery] = useState('')

  const curatedIds = new Set(models.curated.map(item => item.id))
  const rest = models.all.filter(item => !curatedIds.has(item.id))
  const total = models.curated.length + rest.length
  const needle = query.trim().toLowerCase()
  const match = (item: ModelOption) => !needle || `${item.label} ${item.id}`.toLowerCase().includes(needle)

  const row = (item: ModelOption) => (
    <CheckRow
      checked={value.model === item.id}
      key={item.id}
      onPress={() => onChange({ model: item.id, provider: value.provider })}
      subtitle={modelDetail(item) ?? (item.label !== item.id ? item.id : null)}
      testID={`model-${item.id}`}
      title={item.label}
    />
  )

  return (
    <>
      <Group footer={value.provider && !value.model ? 'Pick one of its models to switch.' : undefined} label="Provider">
        {providers.map(item => (
          <CheckRow
            checked={value.provider === item.id}
            key={item.id}
            onPress={() => {
              if (item.id !== value.provider) {
                setQuery('')
                onChange({ model: '', provider: item.id })
              }
            }}
            testID={`provider-${item.id}`}
            title={item.label}
          />
        ))}
      </Group>
      {total > SEARCH_FROM ? (
        <View style={[styles.search, { backgroundColor: colors.bubbleBot }]}>
          <Icon color={colors.textMuted} name="magnifyingglass" size={16} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder={`Search ${total} models`}
            placeholderTextColor={colors.textFaint}
            style={[styles.searchField, { color: colors.text }]}
            value={query}
          />
        </View>
      ) : null}
      {models.loading ? (
        <ActivityIndicator color={colors.textMuted} style={{ paddingVertical: 24 }} />
      ) : models.error ? (
        <Text style={[styles.note, { color: colors.danger }]}>{models.error}</Text>
      ) : !value.provider ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>Choose a provider to see its models.</Text>
      ) : total === 0 ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>This provider lists no models.</Text>
      ) : (
        <>
          {models.curated.filter(match).length ? <Group label="Recommended">{models.curated.filter(match).map(row)}</Group> : null}
          {rest.filter(match).length ? (
            <Group label={models.curated.length ? 'All models' : 'Model'}>{rest.filter(match).map(row)}</Group>
          ) : null}
          {needle && !models.curated.filter(match).length && !rest.filter(match).length ? (
            <Text style={[styles.note, { color: colors.textMuted }]}>No model matches “{query.trim()}”.</Text>
          ) : null}
        </>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  note: { fontSize: 15, paddingHorizontal: 16, textAlign: 'center' },
  search: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 8, height: 44, paddingHorizontal: 14 },
  searchField: { flex: 1, fontSize: 17, height: 44 }
})
