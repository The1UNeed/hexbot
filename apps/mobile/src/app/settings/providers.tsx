import { router, Stack } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { Icon } from '../../components/icon'
import { Group, Row } from '../../components/list'
import { errorText, KeyboardListScroll, Lead, PageState, useOnReconnect } from '../../components/settings/kit'
import { ProviderRow } from '../../components/settings/provider-row'
import type { Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'

/** `provider/model` as the model's own name; the provider shows in the picker. */
export const modelName = (value?: null | string) => (value ? value.slice(value.indexOf('/') + 1) : null)

/**
 * Providers: the ones with a key first, then the rest, then the default and
 * fallback models. Hexbot includes no credits; that is the page's one line.
 */
export default function Providers() {
  const { colors } = useTheme()
  const providers = useSettings(state => state.providers)
  const settings = useSettings(state => state.settings)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<null | string>(null)
  const [loaded, setLoaded] = useState(providers.length > 0)
  // The groups are fixed when the page opens: a row that gets its first key
  // stays where it is, so its open editor and test result are not remounted.
  const [connectedIds, setConnectedIds] = useState<null | Set<string>>(null)

  const load = useCallback(() => {
    setError(null)
    void useSettings.getState().refresh()
    useSettings
      .getState()
      .refreshProviders()
      .then(() => setLoaded(true))
      .catch(caught => setError(errorText(caught)))
  }, [])

  useEffect(load, [load])
  useOnReconnect(load)

  useEffect(() => {
    if (!connectedIds && loaded && providers.length) {
      setConnectedIds(new Set(providers.filter(item => item.configured === true).map(item => item.id)))
    }
  }, [connectedIds, loaded, providers])

  const needle = query.trim().toLowerCase()
  const visible = providers.filter(provider => !needle || `${provider.label} ${provider.id}`.toLowerCase().includes(needle))
  const isConnected = (provider: Provider) => (connectedIds ? connectedIds.has(provider.id) : provider.configured === true)
  const connected = visible.filter(isConnected)
  const rest = visible.filter(provider => !isConnected(provider))

  return (
    <>
      <Stack.Screen options={{ title: 'Providers' }} />
      <KeyboardListScroll bottomOffset={120} testID="providers">
        <Lead>Hexbot does not include any model credits. Usage is billed by your providers.</Lead>

        {!loaded ? (
          <PageState error={error} onRetry={load} />
        ) : (
          <>
            <View style={[styles.search, { backgroundColor: colors.bubbleBot }]}>
              <Icon color={colors.textMuted} name="magnifyingglass" size={16} />
              <TextInput
                accessibilityLabel="Search providers"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                onChangeText={setQuery}
                placeholder="Search providers"
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.text }]}
                testID="providers-search"
                value={query}
              />
            </View>

            {connected.length ? (
              <Group label="Connected">
                {connected.map(provider => (
                  <ProviderRow key={provider.id} provider={provider} />
                ))}
              </Group>
            ) : null}
            {needle ? null : (
              <Group footer="New bots start on the default model. A bot falls back when its own provider fails." label="Defaults">
                <Row
                  chevron
                  onPress={() => router.push({ params: { kind: 'default' }, pathname: '/settings/model' })}
                  testID="providers-default-model"
                  title="Default model"
                  value={modelName(settings?.default_model) ?? 'Choose'}
                />
                <Row
                  chevron
                  onPress={() => router.push({ params: { kind: 'fallback' }, pathname: '/settings/model' })}
                  testID="providers-fallback-model"
                  title="Fallback"
                  value={modelName(settings?.fallback_model) ?? 'None'}
                />
              </Group>
            )}
            {rest.length ? (
              <Group label={connected.length ? 'More providers' : 'All providers'}>
                {rest.map(provider => (
                  <ProviderRow key={provider.id} provider={provider} />
                ))}
              </Group>
            ) : null}
            {!visible.length ? (
              <Pressable onPress={() => setQuery('')}>
                <Text style={[styles.none, { color: colors.textMuted }]}>No provider matches “{query.trim()}”.</Text>
              </Pressable>
            ) : null}

          </>
        )}
      </KeyboardListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  none: { fontSize: 15, paddingHorizontal: 16, textAlign: 'center' },
  search: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 8, height: 44, paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 17, height: 44 }
})
