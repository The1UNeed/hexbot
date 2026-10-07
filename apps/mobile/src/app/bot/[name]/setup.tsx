import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'

import { connectorFieldsFor, connectorGlyph, connectorValues } from '../../../components/bot/connector-fields'
import { Note } from '../../../components/bot/page'
import { errorText, useBotRoute } from '../../../components/bot/use-bot'
import { Button } from '../../../components/button'
import { Icon } from '../../../components/icon'
import { CheckRow, Group, SwitchRow } from '../../../components/list'
import type { Bot, Connector, ConnectorTest } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { useConnectors, useConnectorsForBot } from '../../../stores/connectors'
import { useTheme } from '../../../theme'

/**
 * The set-up sheet: the connector's fields from the catalog, saved once for
 * the daemon (or for this bot only) and tested before the sheet closes. A
 * failed test keeps it open with the message under the fields.
 */
export default function Setup() {
  const { bot } = useBotRoute()
  const { id } = useLocalSearchParams<{ id: string }>()
  const connector = useConnectorsForBot(bot?.name ?? null).find(item => item.id === id)

  useEffect(() => {
    if (bot && !connector) {
      void useConnectors.getState().refresh(bot.name)
    }
  }, [bot, connector])

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {bot && connector ? <SetupForm bot={bot} connector={connector} /> : <Note text="Loading" />}
    </>
  )
}

function SetupForm({ bot, connector }: { bot: Bot; connector: Connector }) {
  const { colors } = useTheme()
  const [values, setValues] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState<string | undefined>(connector.provider ?? connector.providers?.[0]?.id)
  const [enable, setEnable] = useState(connector.state === 'ready' ? Boolean(connector.enabled_for_bot) : true)
  const [botOnly, setBotOnly] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectorTest | null>(null)
  const [error, setError] = useState<null | string>(null)

  const forProvider = connectorFieldsFor(connector, provider)
  const fields = forProvider.filter(field => advanced || !field.advanced)
  const changed = forProvider.some(field => values[field.key]?.trim())
  const alreadySet = forProvider.some(field => field.set)
  const providerChanged = Boolean(provider && provider !== connector.provider)
  const byName = useBots(state => state.byName)
  const others = connector.enabled_bots.filter(name => name !== bot.name).map(name => byName[name]?.display_name ?? name)
  const failed = result && !result.ok

  const submit = async () => {
    setBusy(true)
    setError(null)
    setResult(null)

    try {
      const test = await useConnectors.getState().setup({
        bot: bot.name,
        bot_only: botOnly,
        enable_for_bot: enable,
        id: connector.id,
        ...(provider ? { provider } : {}),
        values: connectorValues(connector, provider, values)
      })

      setResult(test)

      if (test.ok) {
        router.back()
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.head}>
        <View style={[styles.tile, { backgroundColor: colors.surface3 }]}>
          <Icon color={colors.text} name={connectorGlyph(connector.icon)} size={22} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>
          {connector.state === 'error' ? 'Fix' : 'Set up'} {connector.name}
        </Text>
        <Text style={[styles.lead, { color: colors.textMuted }]}>
          {botOnly
            ? `Stored for ${bot.display_name} only. Other bots keep the shared value.`
            : 'Stored once on the daemon. Every bot you turn it on for uses it.'}
        </Text>
      </View>

      {connector.providers?.length ? (
        <Group label="Provider">
          {connector.providers.map(item => (
            <CheckRow
              checked={provider === item.id}
              key={item.id}
              onPress={() => setProvider(item.id)}
              subtitle={item.configured ? 'Connected' : null}
              title={item.label}
            />
          ))}
        </Group>
      ) : null}

      {fields.map(field => (
        <View key={field.key} style={styles.fieldBlock}>
          <Text style={[styles.label, { color: colors.textMuted }]}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            onChangeText={text => setValues(current => ({ ...current, [field.key]: text }))}
            placeholder={field.set && field.hint ? `Saved ${field.hint}` : field.set ? 'Saved' : undefined}
            placeholderTextColor={colors.textFaint}
            secureTextEntry={field.secret}
            style={[styles.input, { backgroundColor: colors.bubbleBot, borderColor: failed ? colors.danger : 'transparent', color: colors.text }]}
            testID={`setup-field-${field.key}`}
            value={values[field.key] ?? ''}
          />
          {field.help || field.url ? (
            <Text style={[styles.help, { color: colors.textMuted }]}>
              {field.help.replace(/`/g, '')}
              {field.url ? (
                <Text onPress={() => void Linking.openURL(field.url!)} style={{ color: colors.text, fontWeight: '600' }}>
                  {field.help ? ' ' : ''}Where to get it
                </Text>
              ) : null}
            </Text>
          ) : null}
        </View>
      ))}
      {forProvider.some(field => field.advanced) ? (
        <Pressable accessibilityRole="button" onPress={() => setAdvanced(value => !value)} style={styles.more}>
          <Text style={[styles.help, { color: colors.text, fontWeight: '600' }]}>{advanced ? 'Hide advanced' : 'Show advanced'}</Text>
        </Pressable>
      ) : null}

      <Group>
        <SwitchRow
          onValueChange={setEnable}
          subtitle={others.length ? `Also on for ${others.join(', ')}.` : null}
          testID="setup-enable"
          title={`Turn on for ${bot.display_name}`}
          value={enable}
        />
        {connector.scope === 'daemon' ? (
          <SwitchRow
            onValueChange={setBotOnly}
            subtitle="For a second account. Other bots keep the shared one."
            title={`Use a different value for ${bot.display_name} only`}
            value={botOnly}
          />
        ) : null}
      </Group>

      {failed ? <Text style={[styles.help, { color: colors.danger, textAlign: 'center' }]}>{result.message}</Text> : null}
      {error ? <Text style={[styles.help, { color: colors.danger, textAlign: 'center' }]}>{error}</Text> : null}

      <View style={styles.buttons}>
        <Button onPress={() => router.back()} style={styles.button} variant="secondary">
          Cancel
        </Button>
        <Button
          disabled={!changed && !alreadySet && !providerChanged}
          loading={busy}
          onPress={() => void submit()}
          style={styles.button}
        >
          Connect and test
        </Button>
      </View>
    </KeyboardAwareScrollView>
  )
}

const styles = StyleSheet.create({
  button: { flex: 1 },
  buttons: { flexDirection: 'row', gap: 10 },
  content: { gap: 22, paddingBottom: 40, paddingHorizontal: 20, paddingTop: 28 },
  fieldBlock: { gap: 6 },
  head: { alignItems: 'center', gap: 8 },
  help: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  input: { borderRadius: 14, borderWidth: 1, fontSize: 17, height: 50, paddingHorizontal: 16 },
  label: { fontSize: 13, fontWeight: '500', paddingHorizontal: 4 },
  lead: { fontSize: 15, lineHeight: 20, textAlign: 'center' },
  more: { alignSelf: 'flex-start', marginTop: -10 },
  tile: { alignItems: 'center', borderCurve: 'continuous', borderRadius: 14, height: 52, justifyContent: 'center', width: 52 },
  title: { fontSize: 22, fontWeight: '600' }
})
