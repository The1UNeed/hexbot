import { router } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'

import { Button } from '../../components/button'
import { BotFace } from '../../components/face'
import { GlassButton } from '../../components/glass'
import { Icon } from '../../components/icon'
import { errorText } from '../../components/settings/kit'
import { useBotList } from '../../stores/bots'
import { useRooms } from '../../stores/rooms'
import { useSettings } from '../../stores/settings'
import { useTheme } from '../../theme'

const FACE = 60

/**
 * New room: a name and the bots in it, picked by their faces. The first bot
 * picked leads (the main bot answers when nobody is mentioned); the Main bot
 * row picks another, or none. Approval mode and limits start
 * from the daemon's defaults and live in Room settings.
 */
export default function NewRoom() {
  const { colors } = useTheme()
  const bots = useBotList()
  const settings = useSettings(state => state.settings)
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [main, setMain] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const toggle = (bot: string) => {
    setError(null)
    setMembers(current => {
      const next = current.includes(bot) ? current.filter(item => item !== bot) : [...current, bot]

      setMain(lead => (lead && next.includes(lead) ? lead : (next[0] ?? null)))

      return next
    })
  }

  const create = async () => {
    setBusy(true)
    setError(null)

    try {
      const room = await useRooms.getState().create({
        approval_mode: settings?.approval_mode ?? 'smart',
        limits: {
          bot_turns_per_human_turn: settings?.room_bot_turns_per_human_turn ?? 8,
          budget_tokens_per_human_turn: settings?.room_budget_tokens_per_human_turn ?? null
        },
        ...(main ? { main_bot: main } : {}),
        members,
        name: name.trim()
      })

      router.replace({ params: { id: room.id }, pathname: '/room/[id]' })
    } catch (cause) {
      setError(errorText(cause))
      setBusy(false)
    }
  }

  const picked = bots.filter(bot => members.includes(bot.name))

  return (
    <View style={{ backgroundColor: colors.bg, flex: 1 }}>
      <View style={styles.bar}>
        <GlassButton accessibilityLabel="Cancel" icon="xmark" onPress={() => router.back()} />
        <Text style={[styles.title, { color: colors.text }]}>New room</Text>
        <View style={{ width: 44 }} />
      </View>
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={styles.content} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
        <View style={[styles.nameCard, { backgroundColor: colors.bubbleBot }]}>
          <TextInput
            accessibilityLabel="Room name"
            autoCapitalize="sentences"
            maxLength={80}
            onChangeText={setName}
            placeholder="Room name"
            placeholderTextColor={colors.textFaint}
            returnKeyType="done"
            style={[styles.name, { color: colors.text }]}
            testID="new-room-name"
            value={name}
          />
        </View>

        <View style={styles.section}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Bots</Text>
          <View style={styles.grid}>
            {bots.map(bot => {
              const on = members.includes(bot.name)

              return (
                <Pressable
                  accessibilityLabel={bot.display_name}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  key={bot.name}
                  onPress={() => toggle(bot.name)}
                  style={styles.cell}
                  testID={`new-room-bot-${bot.name}`}
                >
                  <View style={[styles.ring, { borderColor: on ? colors.text : 'transparent' }]}>
                    <View style={{ opacity: on || !members.length ? 1 : 0.55 }}>
                      <BotFace bot={bot} size={FACE} />
                    </View>
                    {on ? (
                      <View style={[styles.check, { backgroundColor: colors.text, borderColor: colors.bg }]}>
                        <Icon color={colors.bg} name="checkmark" size={10} weight="bold" />
                      </View>
                    ) : null}
                  </View>
                  <Text numberOfLines={1} style={[styles.cellName, { color: on ? colors.text : colors.textMuted }]}>
                    {bot.display_name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>

        {picked.length ? (
          <View style={styles.section}>
            <Text style={[styles.label, { color: colors.textMuted }]}>Main bot</Text>
            <View style={styles.chips}>
              {[...picked.map(bot => ({ id: bot.name, label: bot.display_name })), { id: '', label: 'None' }].map(choice => {
                const on = (main ?? '') === choice.id

                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    key={choice.id || 'none'}
                    onPress={() => setMain(choice.id || null)}
                    style={[styles.chip, { backgroundColor: on ? colors.primary : colors.bubbleBot }]}
                    testID={`new-room-main-${choice.id || 'none'}`}
                  >
                    <Text style={[styles.chipText, { color: on ? colors.primaryText : colors.text }]}>{choice.label}</Text>
                  </Pressable>
                )
              })}
            </View>
            <Text style={[styles.hint, { color: colors.textMuted }]}>
              {main ? 'The main bot answers when nobody is mentioned.' : 'Without a main bot, only mentioned bots answer.'}
            </Text>
          </View>
        ) : null}

        {error ? <Text style={[styles.hint, { color: colors.danger }]}>{error}</Text> : null}

        <Button disabled={!name.trim() || !members.length} loading={busy} onPress={() => void create()} style={styles.create}>
          Create room
        </Button>
      </KeyboardAwareScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 16 },
  cell: { alignItems: 'center', gap: 6, width: '25%' },
  cellName: { fontSize: 13, maxWidth: '92%' },
  check: { alignItems: 'center', borderRadius: 10, borderWidth: 2, bottom: -2, height: 20, justifyContent: 'center', position: 'absolute', right: -2, width: 20 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipText: { fontSize: 15, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  content: { gap: 24, paddingBottom: 40, paddingHorizontal: 20, paddingTop: 16 },
  create: { marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 },
  hint: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 13, fontWeight: '500', paddingHorizontal: 4 },
  name: { fontSize: 20, fontWeight: '500', height: 56, textAlign: 'center' },
  nameCard: { borderCurve: 'continuous', borderRadius: 24, paddingHorizontal: 16 },
  ring: { borderRadius: 18, borderWidth: 2, padding: 4 },
  section: { gap: 12 },
  title: { fontSize: 17, fontWeight: '600' }
})
