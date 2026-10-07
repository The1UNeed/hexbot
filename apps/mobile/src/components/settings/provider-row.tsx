import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { modelsList } from '../../lib/api'
import type { Provider } from '../../lib/types'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'
import { Icon } from '../icon'

import { Chip, errorText, MONO, PillButton } from './kit'

/** Subscription providers sign in through a browser on the daemon's computer; the rest take a key. */
export const isSubscription = (provider: Pick<Provider, 'auth_type'>) => provider.auth_type.startsWith('oauth')
export const supportsApiKey = (provider: Pick<Provider, 'key_supported'>) => provider.key_supported !== false

function stateLine(provider: Provider): string {
  if (isSubscription(provider)) {
    return provider.configured ? 'Subscription, signed in' : 'Subscription'
  }

  if (!supportsApiKey(provider)) {
    return 'Set up on the daemon'
  }

  return provider.configured ? 'API key saved' : ''
}

/**
 * One provider: its name and state, one control, and on tap the key field
 * with Save and Test (or how to sign in, for subscriptions).
 */
export function ProviderRow({ provider }: { provider: Provider }) {
  const { colors } = useTheme()
  const setKey = useSettings(state => state.setProviderKey)
  const clearKey = useSettings(state => state.clearProviderKey)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'clear' | 'save' | 'test' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const subscription = isSubscription(provider)
  const keyed = !subscription && supportsApiKey(provider)
  const id = provider.id

  const run = async (kind: 'clear' | 'save' | 'test', work: () => Promise<string>) => {
    setBusy(kind)
    setResult(null)

    try {
      setResult({ ok: true, text: await work() })
    } catch (error) {
      setResult({ ok: false, text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run('save', async () => {
      await setKey(id, draft.trim())
      setDraft('')

      return 'Key saved.'
    })

  const test = () =>
    run('test', async () => {
      if (draft.trim()) {
        await setKey(id, draft.trim())
        setDraft('')
      }

      const models = await modelsList(id)

      if (models.error) {
        throw new Error(models.error)
      }

      return models.all.length === 1 ? '1 model available.' : `${models.all.length} models available.`
    })

  const remove = () =>
    run('clear', async () => {
      await clearKey(id)

      return subscription ? 'Signed out.' : 'Key removed.'
    })

  const control = provider.configured ? (
    <Chip tone="success">{subscription ? 'Signed in' : 'Connected'}</Chip>
  ) : keyed && !open ? (
    <PillButton onPress={() => setOpen(true)} testID={`provider-add-${id}`}>
      Add key
    </PillButton>
  ) : null

  return (
    <View testID={`provider-${id}`}>
      <Pressable
        accessibilityHint={open ? 'Collapses' : 'Expands'}
        accessibilityLabel={[provider.label, stateLine(provider) || 'needs an API key'].join(', ')}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(value => !value)}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: colors.surface3 }]}
        testID={`provider-row-${id}`}
      >
        <View style={styles.body}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
            {provider.label}
          </Text>
          {stateLine(provider) ? (
            <Text numberOfLines={1} style={[styles.subtitle, { color: colors.textMuted }]}>
              {stateLine(provider)}
            </Text>
          ) : null}
        </View>
        {control}
        <Icon color={colors.textFaint} name={open ? 'chevron.up' : 'chevron.down'} size={13} weight="semibold" />
      </Pressable>

      {open ? (
        <View style={styles.panel}>
          {keyed ? (
            <>
              <View style={[styles.field, { backgroundColor: colors.bg }]}>
                <TextInput
                  accessibilityLabel={`${provider.label} API key`}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  autoFocus
                  onChangeText={setDraft}
                  onSubmitEditing={() => draft.trim() && void save()}
                  placeholder={provider.configured ? 'Replace the saved key' : 'API key'}
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="done"
                  secureTextEntry
                  style={[styles.input, draft ? styles.mono : null, { color: colors.text }]}
                  testID={`provider-key-${id}`}
                  textContentType="password"
                  value={draft}
                />
              </View>
              <View style={styles.actions}>
                <PillButton
                  disabled={!draft.trim() || busy !== null}
                  loading={busy === 'save'}
                  onPress={() => void save()}
                  testID={`provider-save-${id}`}
                  tone="primary"
                >
                  Save
                </PillButton>
                <PillButton
                  disabled={(!draft.trim() && !provider.configured) || busy !== null}
                  loading={busy === 'test'}
                  onPress={() => void test()}
                  testID={`provider-test-${id}`}
                >
                  Test
                </PillButton>
                <View style={styles.spacer} />
                {provider.configured ? (
                  <PillButton disabled={busy !== null} loading={busy === 'clear'} onPress={() => void remove()} tone="danger">
                    Remove key
                  </PillButton>
                ) : null}
              </View>
            </>
          ) : subscription ? (
            <View style={styles.actions}>
              <Text style={[styles.note, styles.spacer, { color: colors.textMuted }]}>
                {provider.configured
                  ? 'Signed in with your subscription.'
                  : `Sign in to ${provider.label} on the computer running Hexbot, in Settings, Providers.`}
              </Text>
              {provider.configured ? (
                <PillButton disabled={busy !== null} loading={busy === 'clear'} onPress={() => void remove()} tone="danger">
                  Sign out
                </PillButton>
              ) : null}
            </View>
          ) : (
            <Text style={[styles.note, { color: colors.textMuted }]}>
              {id === 'custom'
                ? "Set model.base_url in the daemon's config.yaml on the computer running Hexbot."
                : 'This provider uses credentials managed outside Hexbot. Set them up on the computer running Hexbot.'}
            </Text>
          )}
          {result ? (
            <Text accessibilityRole={result.ok ? 'text' : 'alert'} style={[styles.note, { color: result.ok ? colors.success : colors.danger }]} testID={`provider-result-${id}`}>
              {result.text}
            </Text>
          ) : keyed ? (
            <Text style={[styles.note, { color: colors.textFaint }]}>Paste a key from your {provider.label} account. Usage is billed by them.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  body: { flex: 1, gap: 2, minWidth: 0, paddingVertical: 12 },
  field: { borderCurve: 'continuous', borderRadius: 14, paddingHorizontal: 14 },
  head: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  input: { fontSize: 16, height: 44 },
  mono: { fontFamily: MONO, fontSize: 15 },
  note: { fontSize: 14, lineHeight: 19 },
  panel: { gap: 12, paddingBottom: 16, paddingHorizontal: 16 },
  spacer: { flex: 1 },
  subtitle: { fontSize: 14, lineHeight: 19 },
  title: { fontSize: 17, lineHeight: 22 }
})
