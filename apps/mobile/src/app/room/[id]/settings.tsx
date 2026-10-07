import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'

import { activeBots, BotFace, RoomCluster } from '../../../components/face'
import { GlassButton } from '../../../components/glass'
import { Group, Row, TextFieldRow } from '../../../components/list'
import { ChoiceRow, closeSheet, errorText, KeyboardListScroll, PillButton } from '../../../components/settings/kit'
import { useApprovalModes } from '../../../lib/approval-modes'
import type { Bot, BotApprovalMode, Room } from '../../../lib/types'
import { useBotList, useBots } from '../../../stores/bots'
import { useRooms } from '../../../stores/rooms'
import { useUsers } from '../../../stores/users'
import { useTheme } from '../../../theme'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** "2 bots and you." alone, "2 bots and 3 people." with others in the room. */
function roomSummary(bots: number, people: number): string {
  return people > 1 ? `${plural(bots, 'bot')} and ${people} people.` : `${plural(bots, 'bot')} and you.`
}

/** Leave the room screen and the sheet together, landing on the home list. */
function leaveToHome() {
  router.dismissAll()
}

function MemberRow({
  bot,
  isMain,
  last,
  name,
  onMakeMain,
  onRemove,
  readOnly
}: {
  bot?: Bot
  isMain: boolean
  last: boolean
  name: string
  onMakeMain: () => void
  onRemove: () => void
  readOnly: boolean
}) {
  const { colors } = useTheme()

  const confirm = () =>
    Alert.alert(
      last ? `Remove ${name} and delete the room?` : `Remove ${name}?`,
      last
        ? `${name} is the last bot here. Removing it deletes this room, its transcript and the memory made from it. The bot itself stays.`
        : `Its memory of the room stays with the bot.`,
      [
        { style: 'cancel', text: 'Cancel' },
        { onPress: onRemove, style: 'destructive', text: last ? 'Remove and delete room' : 'Remove' }
      ]
    )

  return (
    <View style={styles.member} testID={`room-member-${bot?.name ?? name}`}>
      <BotFace bot={bot} name={bot?.name ?? name} size={34} />
      <View style={styles.memberBody}>
        <View style={styles.memberLine}>
          <Text numberOfLines={1} style={[styles.memberName, { color: colors.text }]}>
            {name}
          </Text>
          {isMain ? <Text style={[styles.main, { backgroundColor: colors.surface3, color: colors.textMuted }]}>Main</Text> : null}
        </View>
        {bot?.title ? (
          <Text numberOfLines={1} style={[styles.memberTitle, { color: colors.textMuted }]}>
            {bot.title}
          </Text>
        ) : null}
      </View>
      {readOnly ? null : (
        <View style={styles.memberActions}>
          {isMain ? null : (
            <PillButton onPress={onMakeMain} testID={`make-main-${bot?.name ?? name}`}>
              Make main
            </PillButton>
          )}
          <PillButton onPress={confirm} testID={`remove-${bot?.name ?? name}`} tone="danger">
            Remove
          </PillButton>
        </View>
      )}
    </View>
  )
}

function Body({ room }: { room: Room }) {
  const { colors } = useTheme()
  const bots = useBots(state => state.byName)
  const allBots = useBotList()
  const current = useUsers(state => state.current)
  const supported = useUsers(state => state.supported)
  const owner = current ? current.id === room.owner_id : supported === false
  const modes = useApprovalModes(room.approval_mode)
  const [error, setError] = useState<null | string>(null)
  const members = activeBots(room)
  const people = room.members.filter(member => member.member_kind === 'human' && !member.left_at)
  const addable = allBots.filter(bot => !members.some(member => member.member_id === bot.name))
  const rooms = () => useRooms.getState()

  const run = async (action: () => Promise<unknown>) => {
    setError(null)

    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const remove = (bot: string) =>
    run(async () => {
      if (await rooms().removeMember(room.id, bot)) {
        leaveToHome()
      }
    })

  const limit = (raw: string) => {
    const value = raw.trim() === '' ? null : Number(raw)

    if (value !== null && (!Number.isFinite(value) || value < 1)) {
      throw new Error('Use a whole number, or leave it empty for no limit.')
    }

    return value
  }

  const deleteRoom = () =>
    Alert.alert(`Delete “${room.name}”?`, 'Removes the room, its transcript and the memory made from it. The bots are kept.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: () => void run(async () => rooms().remove(room.id).then(leaveToHome)), style: 'destructive', text: 'Delete room' }
    ])

  const leave = () =>
    Alert.alert(`Leave “${room.name}”?`, 'You can no longer read or post in it.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => void run(async () => current && rooms().removePerson(room.id, current.id, true).then(leaveToHome)),
        style: 'destructive',
        text: 'Leave room'
      }
    ])

  return (
    <KeyboardListScroll testID="room-settings">
      <View style={styles.hero}>
        <RoomCluster bots={bots} room={room} size={76} />
        <Text style={[styles.heroName, { color: colors.text }]}>{room.name}</Text>
        <Text style={[styles.heroLead, { color: colors.textMuted }]}>{roomSummary(members.length, people.length)}</Text>
      </View>

      {owner ? null : (
        <Text style={[styles.note, { color: colors.textMuted }]}>Only the person who created this room can change its name, members and settings.</Text>
      )}

      {owner ? (
        <Group>
          <TextFieldRow
            label="Name"
            onCommit={value => {
              if (!value.trim()) {
                throw new Error('A room needs a name.')
              }

              return rooms().update(room.id, { name: value.trim() })
            }}
            testID="room-name"
            value={room.name}
          />
        </Group>
      ) : null}

      <Group
        error={error}
        footer={room.main_bot ? 'The main bot answers when nobody is mentioned.' : 'Without a main bot, only mentioned bots answer.'}
        label="Bots"
      >
        {members.map(member => (
          <MemberRow
            bot={bots[member.member_id]}
            isMain={room.main_bot === member.member_id}
            key={member.member_id}
            last={members.length === 1}
            name={bots[member.member_id]?.display_name ?? member.display_name ?? member.member_id}
            onMakeMain={() => void run(() => rooms().update(room.id, { main_bot: member.member_id }))}
            onRemove={() => void remove(member.member_id)}
            readOnly={!owner}
          />
        ))}
      </Group>

      {owner && addable.length ? (
        <Group label="Add a bot">
          {addable.map(bot => (
            <Pressable
              accessibilityLabel={`Add ${bot.display_name}`}
              accessibilityRole="button"
              key={bot.name}
              onPress={() => void run(() => rooms().addMember(room.id, bot.name))}
              style={({ pressed }) => [styles.member, pressed && { backgroundColor: colors.surface3 }]}
              testID={`add-${bot.name}`}
            >
              <BotFace bot={bot} name={bot.name} size={34} />
              <Text numberOfLines={1} style={[styles.memberName, styles.memberBody, { color: colors.text }]}>
                {bot.display_name}
              </Text>
              <Text style={[styles.add, { color: colors.accent }]}>Add</Text>
            </Pressable>
          ))}
        </Group>
      ) : null}

      {owner ? (
        <Group footer="How tool actions in this room get approved. Inherit uses each bot's own mode." label="Approval mode">
          <ChoiceRow
            checked={!room.approval_mode || room.approval_mode === 'inherit'}
            description="Each bot keeps its own mode."
            onPress={() => void run(() => rooms().update(room.id, { approval_mode: 'inherit' }))}
            testID="room-mode-inherit"
            title="Inherit"
          />
          {modes.map(mode => (
            <ChoiceRow
              checked={room.approval_mode === mode.value}
              description={mode.description}
              key={mode.value}
              onPress={() => void run(() => rooms().update(room.id, { approval_mode: mode.value as BotApprovalMode }))}
              testID={`room-mode-${mode.value}`}
              title={mode.label}
            />
          ))}
        </Group>
      ) : null}

      {owner ? (
        <Group footer="Bot turns caps how many replies one of your messages can set off. The token budget caps what they spend on it." label="Limits">
          <TextFieldRow
            keyboardType="number-pad"
            label="Bot turns"
            onCommit={value =>
              rooms().update(room.id, { limits: { ...room.limits, bot_turns_per_human_turn: limit(value) } })
            }
            placeholder="No limit"
            testID="room-turns"
            value={room.limits.bot_turns_per_human_turn == null ? '' : String(room.limits.bot_turns_per_human_turn)}
          />
          <TextFieldRow
            keyboardType="number-pad"
            label="Token budget"
            onCommit={value =>
              rooms().update(room.id, { limits: { ...room.limits, budget_tokens_per_human_turn: limit(value) } })
            }
            placeholder="No limit"
            testID="room-budget"
            value={room.limits.budget_tokens_per_human_turn == null ? '' : String(room.limits.budget_tokens_per_human_turn)}
          />
        </Group>
      ) : null}

      {owner ? (
        <Group footer="Removes the room, its transcript and the memory made from it. The bots are kept.">
          <Row destructive onPress={deleteRoom} testID="room-delete" title="Delete room" />
        </Group>
      ) : current ? (
        <Group footer="Takes the room off your list. Its bots and the other people stay.">
          <Row destructive onPress={leave} testID="room-leave" title="Leave room" />
        </Group>
      ) : null}
    </KeyboardListScroll>
  )
}

/**
 * Everything about one room, as a modal grouped list: its name, who is in it
 * and who leads, how tool calls get approved, the per-turn limits, and the
 * way out. Only the owner changes it; others see it read-only and can leave.
 */
export default function RoomSettings() {
  const { id = '' } = useLocalSearchParams<{ id: string }>()
  const { colors } = useTheme()
  const room = useRooms(state => state.byId[id])

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <View style={styles.bar}>
        <View style={styles.side} />
        <Text style={[styles.title, { color: colors.text }]}>Room settings</Text>
        <View style={styles.side}>
          <GlassButton accessibilityLabel="Done" icon="checkmark" onPress={closeSheet} />
        </View>
      </View>
      {room ? (
        <Body room={room} />
      ) : (
        <Text style={[styles.note, { color: colors.textMuted, marginTop: 40 }]}>This room is no longer here.</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  add: { fontSize: 16, fontWeight: '600' },
  bar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14 },
  hero: { alignItems: 'center', gap: 6, paddingTop: 4 },
  heroLead: { fontSize: 15 },
  heroName: { fontSize: 22, fontWeight: '700', marginTop: 8 },
  main: { borderRadius: 6, fontSize: 12, fontWeight: '600', overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 },
  member: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 60, paddingHorizontal: 16, paddingVertical: 8 },
  memberActions: { flexDirection: 'row', gap: 6 },
  memberBody: { flex: 1, minWidth: 0 },
  memberLine: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  memberName: { flexShrink: 1, fontSize: 17 },
  memberTitle: { fontSize: 14, marginTop: 1 },
  note: { fontSize: 14, lineHeight: 19, paddingHorizontal: 16, textAlign: 'center' },
  screen: { flex: 1 },
  side: { alignItems: 'flex-end', width: 44 },
  title: { fontSize: 17, fontWeight: '600' }
})
