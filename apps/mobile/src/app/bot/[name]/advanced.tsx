import { router } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import { useBotSheet } from '../../../components/bot/nav'
import { BotPage } from '../../../components/bot/page'
import { errorText } from '../../../components/bot/use-bot'
import { Button } from '../../../components/button'
import { Group, Row, SwitchRow } from '../../../components/list'
import type { Bot } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { useTheme } from '../../../theme'

export default function Advanced() {
  return (
    <BotPage title="Advanced">
      {({ bot, quietly }) => (
        <>
          <Group label="Sharing">
            <SwitchRow
              onValueChange={on => quietly({ shareable: on })}
              subtitle="Other people on this daemon can talk to this bot."
              testID="bot-shareable"
              title="Shareable"
              value={bot.shareable ?? false}
            />
          </Group>
          <DeleteBot bot={bot} />
        </>
      )}
    </BotPage>
  )
}

function DeleteBot({ bot }: { bot: Bot }) {
  const { colors } = useTheme()
  const sheet = useBotSheet()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)

    try {
      await useBots.getState().remove(bot.name)
      // Whatever was open under the sheet belonged to this bot: go home.
      if (sheet.close() !== 'index') {
        router.dismissTo('/')
      }
    } catch (caught) {
      setError(errorText(caught))
      setBusy(false)
    }
  }

  return (
    <Group footer={confirming ? undefined : 'Removes the bot, every section, and its memory.'} label="Danger zone">
      <Row
        destructive
        onPress={confirming ? undefined : () => setConfirming(true)}
        testID="bot-delete"
        title="Delete bot"
      />
      {confirming ? (
        <View style={styles.confirm}>
          <Text style={[styles.text, { color: colors.text }]}>
            Type <Text style={{ fontWeight: '700' }}>{bot.name}</Text> to delete {bot.display_name} with every section and its memory. This cannot be undone.
          </Text>
          <TextInput
            accessibilityLabel="Bot name to confirm"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={setTyped}
            placeholder={bot.name}
            placeholderTextColor={colors.textFaint}
            style={[styles.input, { backgroundColor: colors.bg, color: colors.text }]}
            testID="bot-delete-confirm"
            value={typed}
          />
          {error ? <Text style={[styles.text, { color: colors.danger }]}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Button
              onPress={() => {
                setConfirming(false)
                setTyped('')
                setError(null)
              }}
              style={styles.button}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button disabled={typed.trim() !== bot.name} loading={busy} onPress={() => void remove()} style={styles.button} variant="danger">
              Delete
            </Button>
          </View>
        </View>
      ) : null}
    </Group>
  )
}

const styles = StyleSheet.create({
  button: { flex: 1, height: 46 },
  buttons: { flexDirection: 'row', gap: 10 },
  confirm: { gap: 12, padding: 16 },
  input: { borderRadius: 12, fontSize: 17, height: 46, paddingHorizontal: 14 },
  text: { fontSize: 15, lineHeight: 20 }
})
