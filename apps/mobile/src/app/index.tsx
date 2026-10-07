import { router, Stack } from 'expo-router'
import { useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

import { Button } from '../components/button'
import { BotFace, type DotStatus, PersonAvatar, RoomCluster } from '../components/face'
import { ConnectionPill } from '../components/connection-pill'
import { rowTime } from '../lib/format'
import { openBot } from '../lib/navigation'
import type { Bot, Room } from '../lib/types'
import { useBotList, useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { roomStatus, roomUnread, useRoomList, useRooms } from '../stores/rooms'
import { useUsers } from '../stores/users'
import { type Palette, useTheme } from '../theme'

type Row = { at: number; bot: Bot; kind: 'bot' } | { at: number; kind: 'room'; room: Room }

const FACE = 52

/**
 * Home: every bot and room in one list, newest activity first. A row is the
 * face (with its status dot), the name, the bot's label, and when it was
 * last active. The header is native glass: you on the left, search and new on
 * the right.
 */
export default function Home() {
  const { colors } = useTheme()
  const bots = useBotList()
  const byName = useBots(state => state.byName)
  const botsLoaded = useBots(state => state.loaded)
  const rooms = useRoomList()
  const me = useUsers(state => state.current)
  const status = useConnection(state => state.status)
  const s = styles(colors)

  const rows = useMemo<Row[]>(
    () =>
      [
        ...bots.map(bot => ({ at: bot.last_activity_at ?? bot.created_at ?? 0, bot, kind: 'bot' as const })),
        ...rooms.filter(room => !room.archived_at).map(room => ({ at: room.last_activity_at, kind: 'room' as const, room }))
      ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    [bots, rooms]
  )

  const dot = status === 'connected' ? colors.success : status === 'offline' ? colors.danger : colors.warning

  return (
    <>
      <Stack.Screen options={{ headerTransparent: true, title: '' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <Pressable accessibilityLabel="Settings" accessibilityRole="button" onPress={() => router.push('/settings')} testID="home-me">
            <View>
              <PersonAvatar name={me?.display_name ?? 'You'} size={40} />
              <View style={[s.connDot, { backgroundColor: dot, borderColor: colors.bg }]} />
            </View>
          </Pressable>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="Search" icon="magnifyingglass" onPress={() => router.push('/search')} separateBackground />
        <Stack.Toolbar.Menu accessibilityLabel="New" icon="plus" separateBackground>
          <Stack.Toolbar.MenuAction icon="face.smiling" onPress={() => router.push('/bot/new')}>
            New bot
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="person.2" onPress={() => router.push('/room/new')}>
            New room
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <FlatList
        contentContainerStyle={s.list}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={row => (row.kind === 'bot' ? `bot:${row.bot.name}` : `room:${row.room.id}`)}
        ListEmptyComponent={botsLoaded ? <Empty colors={colors} /> : null}
        ListHeaderComponent={<ConnectionPill />}
        renderItem={({ item }) =>
          item.kind === 'bot' ? <BotRow bot={item.bot} colors={colors} /> : <RoomRow bots={byName} colors={colors} room={item.room} />
        }
        testID="home-list"
      />
    </>
  )
}

function StatusWord({ colors, status }: { colors: Palette; status: DotStatus }) {
  if (status === 'needs_you') {
    return <Text style={[styles(colors).time, { color: colors.accent, fontWeight: '600' }]}>Waiting</Text>
  }

  if (status === 'working') {
    return <Text style={[styles(colors).time, { color: colors.working, fontWeight: '600' }]}>Working</Text>
  }

  return null
}

function BotRow({ bot, colors }: { bot: Bot; colors: Palette }) {
  const s = styles(colors)
  const status: DotStatus = bot.status ?? 'idle'
  const done = bot.sections_recent?.some(section => section.done_at && !section.archived_at)

  return (
    <Pressable
      accessibilityLabel={bot.display_name}
      accessibilityRole="button"
      onPress={() => void openBot(bot.name)}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}
      testID={`home-bot-${bot.name}`}
    >
      <BotFace bot={bot} size={FACE} status={status === 'idle' && done ? 'done' : status} />
      <View style={s.body}>
        <View style={s.line}>
          <Text numberOfLines={1} style={s.name}>
            {bot.display_name}
          </Text>
          {bot.title ? (
            <View style={s.chip}>
              <Text numberOfLines={1} style={s.chipText}>
                {bot.title}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {status === 'working' || status === 'needs_you' ? (
        <StatusWord colors={colors} status={status} />
      ) : (
        <Text style={s.time}>{rowTime(bot.last_activity_at ?? bot.created_at)}</Text>
      )}
    </Pressable>
  )
}

function RoomRow({ bots, colors, room }: { bots: Record<string, Bot>; colors: Palette; room: Room }) {
  const s = styles(colors)
  const events = useRooms(state => state.eventsByRoom[room.id])
  const turns = useRooms(state => state.liveTurnsByRoom[room.id])
  const me = useUsers(state => state.current)
  const status = roomStatus(events ?? [], turns)
  const unread = roomUnread(room, events ?? [], me?.id)

  return (
    <Pressable
      accessibilityLabel={room.name}
      accessibilityRole="button"
      onPress={() => router.push({ params: { id: room.id }, pathname: '/room/[id]' })}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}
      testID={`home-room-${room.id}`}
    >
      <RoomCluster bots={bots} room={room} size={FACE} status={status === 'idle' && unread ? 'done' : status} />
      <View style={s.body}>
        <View style={s.line}>
          <Text numberOfLines={1} style={s.name}>
            {room.name}
          </Text>
          <View style={s.chip}>
            <Text style={s.chipText}>Room</Text>
          </View>
        </View>
      </View>
      {status === 'working' || status === 'needs_you' ? (
        <StatusWord colors={colors} status={status} />
      ) : (
        <Text style={s.time}>{rowTime(room.last_activity_at)}</Text>
      )}
    </Pressable>
  )
}

function Empty({ colors }: { colors: Palette }) {
  const s = styles(colors)

  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>No bots yet</Text>
      <Text style={s.emptyLead}>A bot has a face, a name, and a memory of its own.</Text>
      <Button onPress={() => router.push('/bot/new')} style={{ alignSelf: 'center', marginTop: 20 }}>
        Create a bot
      </Button>
    </View>
  )
}

const styles = (colors: Palette) =>
  StyleSheet.create({
    body: { flex: 1, minWidth: 0 },
    chip: { backgroundColor: colors.surface, borderRadius: 10, maxWidth: '42%', paddingHorizontal: 9, paddingVertical: 3 },
    chipText: { color: colors.textMuted, fontSize: 15 },
    connDot: { borderRadius: 7, borderWidth: 2, bottom: -1, height: 14, position: 'absolute', right: -1, width: 14 },
    empty: { paddingHorizontal: 32, paddingTop: 120 },
    emptyLead: { color: colors.textMuted, fontSize: 16, lineHeight: 22, marginTop: 8, textAlign: 'center' },
    emptyTitle: { color: colors.text, fontSize: 22, fontWeight: '600', textAlign: 'center' },
    line: { alignItems: 'center', flexDirection: 'row', gap: 10 },
    list: { paddingBottom: 40, paddingTop: 8 },
    name: { color: colors.text, flexShrink: 1, fontSize: 19, fontWeight: '500' },
    row: { alignItems: 'center', flexDirection: 'row', gap: 16, minHeight: 84, paddingHorizontal: 20 },
    time: { color: colors.textFaint, fontSize: 15 }
  })
