import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'

import { Bubble } from '../../../components/chat/bubble'
import { ApprovalCard, errorSentence } from '../../../components/chat/cards'
import { ChatList, type ChatListHandle } from '../../../components/chat/chat-list'
import { DaySeparator, EdgeFade, PinnedPill, TitlePill } from '../../../components/chat/chrome'
import { ClarifyCard } from '../../../components/chat/clarify-card'
import { Composer } from '../../../components/chat/composer'
import { buildRoomRows, type RoomRow } from '../../../components/chat/room-timeline'
import { LiveStatus, MemoryMarks, WorkingFace } from '../../../components/chat/work'
import { activeBots, BotFace, RoomCluster } from '../../../components/face'
import { Glass } from '../../../components/glass'
import { roomsSend, roomsStop } from '../../../lib/api'
import { rpcCall } from '../../../lib/rpc'
import type { Bot, Room, RoomEvent, RoomTurn } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { useConnection } from '../../../stores/connection'
import { connectorsActions } from '../../../stores/connectors'
import { roomFailure, roomStatus, useRooms } from '../../../stores/rooms'
import { setFocusedSection, useTranscripts } from '../../../stores/transcripts'
import { useUsers } from '../../../stores/users'
import { radii, useTheme } from '../../../theme'

// Stable empty values: a fresh [] or {} per render re-renders forever.
const NO_EVENTS: RoomEvent[] = []
const NO_TURNS: Record<string, RoomTurn> = {}

const FACE = 28
const FACE_GAP = 8

/** The bot behind the latest "waiting on a human" event, for the pill. */
function waitingBot(events: RoomEvent[], nameOf: (id: string) => string): string | undefined {
  const actor = events.findLast(event => event.kind === 'waiting.human')?.actor_id

  return actor ? nameOf(actor) : undefined
}

/** `@na` at the end of the field: the part of a name typed so far. */
const mentionQuery = (text: string) => /(?:^|\s)@([\w-]*)$/.exec(text)?.[1]

function MentionList({ bots, members, onPick, query }: { bots: Record<string, Bot>; members: Room['members']; onPick: (name: string) => void; query: string }) {
  const { colors } = useTheme()
  const matches = members.filter(member => {
    const name = `${member.member_id} ${bots[member.member_id]?.display_name ?? member.display_name ?? ''}`.toLowerCase()

    return name.includes(query.toLowerCase())
  })

  if (!matches.length) {
    return null
  }

  return (
    <Glass style={styles.mentions}>
      {matches.map(member => {
        const bot = bots[member.member_id]

        return (
          <Pressable
            accessibilityRole="button"
            key={member.member_id}
            onPress={() => onPick(member.member_id)}
            style={({ pressed }) => [styles.mention, pressed && { backgroundColor: colors.hairline }]}
            testID={`mention-${member.member_id}`}
          >
            <BotFace bot={bot} name={member.member_id} size={26} />
            <Text style={[styles.mentionName, { color: colors.text }]}>{bot?.display_name ?? member.display_name ?? member.member_id}</Text>
            <Text style={[styles.mentionHandle, { color: colors.textMuted }]}>@{member.member_id}</Text>
          </Pressable>
        )
      })}
    </Glass>
  )
}

/** A bot's face column beside its bubbles: the face on a run's first bubble, space under it after. */
function FaceColumn({ bot, lead, name }: { bot?: Bot; lead: boolean; name: string }) {
  return <View style={styles.faceColumn}>{lead ? <BotFace bot={bot} name={name} size={FACE} /> : null}</View>
}

/**
 * A room: the same chat as a bot's section, with every bot's face and name
 * beside its bubbles. Messages go to the room; the main bot answers unless
 * someone is @-mentioned. Stop halts every running turn.
 */
export default function RoomScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>()
  const { colors } = useTheme()
  const headerHeight = useHeaderHeight()
  const room = useRooms(state => state.byId[id])
  const events = useRooms(state => state.eventsByRoom[id] ?? NO_EVENTS)
  const turns = useRooms(state => state.liveTurnsByRoom[id] ?? NO_TURNS)
  const transcripts = useTranscripts(state => state.bySession)
  const bots = useBots(state => state.byName)
  const me = useUsers(state => state.current)
  const supported = useUsers(state => state.supported)
  const connection = useConnection(state => state.status)
  const [text, setText] = useState('')
  const [composerHeight, setComposerHeight] = useState(70)
  const [missing, setMissing] = useState(false)
  const listRef = useRef<ChatListHandle>(null)
  const opened = useRef({ at: Date.now(), id })

  if (opened.current.id !== id) {
    opened.current = { at: Date.now(), id }
  }

  const owner = me ? me.id === room?.owner_id : supported === false

  const nameOf = useCallback(
    (member: string, kind: 'bot' | 'human' | null = 'bot') => {
      if (kind !== 'human' && bots[member]) {
        return bots[member].display_name
      }

      const listed = room?.members.find(item => item.member_id === member)?.display_name

      if (listed) {
        return listed
      }

      if (me?.id === member) {
        return me.display_name
      }

      return member
    },
    [bots, me, room?.members]
  )

  // Load the log (and mark it read) when the room opens, and again after a reconnect.
  useEffect(() => {
    if (id && connection === 'connected') {
      useRooms
        .getState()
        .open(id)
        .then(() => {
          if (!useRooms.getState().byId[id]) {
            setMissing(true)
          }
        })
        .catch(() => setMissing(true))
    }
  }, [connection, id])

  useFocusEffect(
    useCallback(() => {
      setFocusedSection(`room:${id}`)

      return () => setFocusedSection(null)
    }, [id])
  )

  // Read marks follow what arrives while the room is on screen.
  const lastSeq = events.at(-1)?.seq
  const present = Boolean(room)

  useEffect(() => {
    if (lastSeq && present) {
      void useRooms.getState().markRead(id, lastSeq)
    }
  }, [id, lastSeq, present])

  const members = useMemo(() => (room ? activeBots(room) : []), [room])

  // Connector tools read as their service ("Connecting to GitHub").
  useEffect(() => {
    for (const member of members) {
      void connectorsActions().load(member.member_id)
    }
  }, [members])

  const rows = useMemo(
    () => buildRoomRows({ currentId: me?.id, events, nameOf, openedAt: opened.current.at, transcripts, turns }),
    [events, me?.id, nameOf, transcripts, turns]
  )

  const status = roomStatus(events, turns)
  const failure = roomFailure(events)
  const streaming = Object.keys(turns).length > 0
  const archived = Boolean(room?.archived_at)
  const waiting = status === 'needs_you' ? waitingBot(events, member => nameOf(member)) : undefined
  const mention = mentionQuery(text)

  const send = async (message: string) => {
    try {
      await roomsSend(id, message)
      setText('')
      listRef.current?.toEnd()

      return true
    } catch (error) {
      Alert.alert('Could not send', error instanceof Error ? error.message : String(error))

      return false
    }
  }

  const setArchived = (value: boolean) => {
    void rpcCall<{ room: Room }>(value ? 'hexbot.rooms.archive' : 'hexbot.rooms.unarchive', { id })
      .then(() => useRooms.getState().refreshOne(id))
      .catch(error => Alert.alert('Could not change the room', String(error?.message ?? error)))
  }

  const remove = () => {
    if (!room) {
      return
    }

    Alert.alert(`Delete “${room.name}”?`, 'Removes the room, its transcript and the memory made from it. The bots are kept.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => {
          void useRooms
            .getState()
            .remove(id)
            .then(() => router.back())
            .catch(error => Alert.alert('Could not delete', String(error?.message ?? error)))
        },
        style: 'destructive',
        text: 'Delete'
      }
    ])
  }

  const leave = () => {
    if (!room || !me) {
      return
    }

    Alert.alert(`Leave “${room.name}”?`, 'You can no longer read or post in it.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => {
          void useRooms
            .getState()
            .removePerson(id, me.id, true)
            .then(() => router.back())
            .catch(error => Alert.alert('Could not leave', String(error?.message ?? error)))
        },
        style: 'destructive',
        text: 'Leave'
      }
    ])
  }

  const openSettings = () => router.push({ params: { id }, pathname: '/room/[id]/settings' })

  const renderRow = (row: RoomRow) => {
    switch (row.kind) {
      case 'separator':
        return <DaySeparator time={row.time} />
      case 'note':
        return <Text style={[styles.note, { color: colors.textMuted }]}>{row.text}</Text>
      case 'limit':
        return <Text style={[styles.note, { color: colors.warning }]}>{row.text}</Text>
      case 'failed':
        return (
          <View accessibilityRole="alert" style={[styles.failed, { backgroundColor: colors.surface }]} testID="room-failed">
            <View style={[styles.failedDot, { backgroundColor: colors.danger }]} />
            <Text numberOfLines={2} style={[styles.failedText, { color: colors.danger }]}>
              <Text style={styles.failedName}>{row.who} stopped</Text>
              {row.error ? ` · ${errorSentence(row.error)}` : ''}
            </Text>
          </View>
        )
      case 'bubble':
        if (row.side === 'user') {
          return <Bubble fresh={row.fresh} side="user" testID="user-message" text={row.text} />
        }

        return (
          <View style={styles.botRow}>
            <FaceColumn bot={row.bot ? bots[row.bot] : undefined} lead={row.lead} name={row.bot ?? row.who} />
            <View style={styles.botColumn}>
              {row.lead ? <Text style={[styles.who, { color: colors.textMuted }]}>{row.who}</Text> : null}
              <Bubble fresh={row.fresh} inset={FACE + FACE_GAP} side="bot" testID="bot-message" text={row.text} />
            </View>
          </View>
        )
      case 'turn': {
        const message = row.transcript?.messages.at(-1)
        // Members see the bot wait while the owner answers; the daemon writes the words.
        const wait = row.transcript?.status?.kind === 'waiting' ? row.transcript.status.text : ''

        return (
          <View style={styles.botRow} testID="room-turn">
            <View style={styles.faceColumn}>
              <WorkingFace bot={bots[row.bot]} name={row.bot} size={FACE} />
            </View>
            <View style={styles.botColumn}>
              {wait ? <Text style={[styles.liveWords, { color: colors.textMuted }]}>{wait}</Text> : null}
              {message ? <MemoryMarks message={message} /> : null}
              {/* The bot's words arrive whole, as its room message when the turn ends. */}
              {message ? (
                <LiveStatus face={null} message={message} name={row.who} />
              ) : (
                <Text style={[styles.liveWords, { color: colors.textMuted }]}>{row.who} is thinking</Text>
              )}
            </View>
          </View>
        )
      }
      case 'clarify':
        return (
          <View style={styles.botRow}>
            <FaceColumn bot={bots[row.bot]} lead name={row.bot} />
            <ClarifyCard clarify={row.clarify} />
          </View>
        )
      case 'approval':
        return (
          <View style={styles.botRow}>
            <FaceColumn bot={bots[row.bot]} lead name={row.bot} />
            <ApprovalCard approval={row.approval} />
          </View>
        )
    }
  }

  const pinned = status === 'needs_you' || archived

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          headerShadowVisible: false,
          headerTitle: () =>
            room ? (
              <TitlePill
                face={<RoomCluster bots={bots} room={room} size={28} status={status === 'idle' ? undefined : status} />}
                name={room.name}
                onPress={openSettings}
                subtitle={`${members.length} bot${members.length === 1 ? '' : 's'}`}
                testID="room-title"
              />
            ) : null,
          headerTitleAlign: 'center',
          headerTransparent: true,
          // The page draws its own fade under the header; the native edge effect would copy the transcript into it.
          scrollEdgeEffects: { bottom: 'hidden', top: 'hidden' },
          title: room?.name ?? 'Room'
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu accessibilityLabel="Room actions" icon="ellipsis">
          <Stack.Toolbar.MenuAction icon="gearshape" onPress={openSettings}>
            Room settings
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={archived ? 'tray.and.arrow.up' : 'archivebox'} onPress={() => setArchived(!archived)}>
            {archived ? 'Unarchive' : 'Archive'}
          </Stack.Toolbar.MenuAction>
          {owner ? (
            <Stack.Toolbar.MenuAction destructive icon="trash" onPress={remove}>
              Delete room
            </Stack.Toolbar.MenuAction>
          ) : (
            <Stack.Toolbar.MenuAction destructive icon="rectangle.portrait.and.arrow.right" onPress={leave}>
              Leave room
            </Stack.Toolbar.MenuAction>
          )}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      {missing && !room ? (
        <View style={[styles.gone, { paddingTop: headerHeight }]}>
          <Text style={[styles.goneTitle, { color: colors.text }]}>This room is no longer here</Text>
          <Text style={[styles.goneLead, { color: colors.textMuted }]}>It was deleted, or you are no longer a member.</Text>
        </View>
      ) : (
        <ChatList
          composerHeight={composerHeight}
          empty={
            <View style={[styles.empty, { paddingTop: headerHeight }]}>
              {room ? (
                <>
                  <RoomCluster bots={bots} room={room} size={88} />
                  <Text style={[styles.emptyName, { color: colors.text }]}>{room.name}</Text>
                  <Text style={[styles.emptyLead, { color: colors.textMuted }]}>
                    {room.main_bot
                      ? `${nameOf(room.main_bot)} answers when nobody is mentioned. Type @ to ask someone else.`
                      : 'Mention a bot with @ to ask it.'}
                  </Text>
                </>
              ) : null}
            </View>
          }
          headerSpace={headerHeight + (pinned ? 46 : 0)}
          ref={listRef}
          renderRow={renderRow}
          rows={rows}
          testID="room-list"
        />
      )}

      <EdgeFade edge="top" height={headerHeight + 28} solid={(headerHeight - 4) / (headerHeight + 28)} />
      <View pointerEvents="box-none" style={[styles.pinned, { top: headerHeight + 4 }]}>
        {status === 'needs_you' ? (
          <PinnedPill icon="questionmark.circle" label={waiting ? `${waiting} is waiting on you` : 'Waiting on you'} testID="waiting-pill" tone={colors.accent} />
        ) : archived ? (
          <PinnedPill action="Unarchive" icon="archivebox" label="Archived" onPress={() => setArchived(false)} testID="archived-pill" />
        ) : null}
      </View>

      {missing && !room ? null : (
        <Composer
          above={
            mention !== undefined && room ? (
              <MentionList bots={bots} members={members} onPick={name => setText(value => value.replace(/@([\w-]*)$/, `@${name} `))} query={mention} />
            ) : null
          }
          disabled={!room}
          draftKey={`room:${id}`}
          key={id}
          notice={status === 'stopped' && failure ? errorSentence(failure) : null}
          onHeight={setComposerHeight}
          onSend={message => send(message)}
          onStop={() => void roomsStop(id)}
          onTextChange={setText}
          placeholder={`Message ${room?.name ?? 'the room'}`}
          status={status}
          streaming={streaming}
          text={text}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  botColumn: { alignItems: 'flex-start', flex: 1, minWidth: 0 },
  botRow: { alignItems: 'flex-start', flexDirection: 'row', gap: FACE_GAP },
  empty: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', paddingHorizontal: 32 },
  emptyLead: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  emptyName: { fontSize: 24, fontWeight: '700', letterSpacing: -0.3, marginTop: 10 },
  faceColumn: { paddingTop: 2, width: FACE },
  failed: { alignItems: 'center', borderRadius: radii.bubble, flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  failedDot: { borderRadius: 4, height: 8, width: 8 },
  failedName: { fontWeight: '600' },
  failedText: { flex: 1, fontSize: 15, lineHeight: 20 },
  gone: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', paddingHorizontal: 32 },
  goneLead: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  goneTitle: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  liveWords: { fontSize: 15, lineHeight: 20, paddingVertical: 5 },
  mention: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44, paddingHorizontal: 12 },
  mentionHandle: { fontSize: 14 },
  mentionName: { flex: 1, fontSize: 16 },
  mentions: { borderRadius: 20, marginBottom: 8, overflow: 'hidden', paddingVertical: 4 },
  note: { fontSize: 14, paddingVertical: 4, textAlign: 'center' },
  pinned: { left: 0, position: 'absolute', right: 0 },
  screen: { flex: 1 },
  who: { fontSize: 13, fontWeight: '600', marginBottom: 3, marginLeft: 4 }
})
