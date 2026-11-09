import { Ionicons } from '@expo/vector-icons'
import {
  type ComponentRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import * as Clipboard from 'expo-clipboard'
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  type ListRenderItemInfo,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { messageText } from '../core/message-text'

import {
  Banner,
  BotFace,
  LoadingFace,
  type BotStatus,
  bubbleFill,
  Button,
  faceColor,
  faceWash,
  dividesChat,
  type FaceMood,
  type FaceSource,
  formatDayDivider,
  Glass,
  IconButton,
  mono,
  radius,
  RoomFace,
  Screen,
  Text,
  useKeyboardVisible,
  useTheme,
  withAlpha
} from '../ui'
import type { AttachSource } from '../core/pickFile'
import { AttachMenu } from './AttachMenu'
import { FileCard } from './FileCard'
import { MediaAttachment } from './MediaAttachment'
import { PluginCard } from './PluginCard'
import { SelectTextSheet } from './SelectTextSheet'
import { SignInCard } from './SignInCard'
import type {
  ApprovalChoice,
  ApprovalRequestView,
  AttachmentView,
  CardAnswer,
  ChatItem
} from './types'

type MessageItem = Extract<ChatItem, { kind: 'message' }>

export interface ChatScreenProps {
  /** The bot's or the room's name. */
  title: string
  /** A line under the name, such as a room's members. */
  subtitle?: string | null
  /** The bot's face. Rooms pass `members` instead. */
  face?: FaceSource
  members?: FaceSource[]
  status?: BotStatus
  /** What the bot feels right now, worn over its status for a moment. */
  emotion?: FaceMood

  /** The transcript, oldest first. */
  items: ChatItem[]
  /** A bot is working but has not written anything yet. */
  /** `computer`: the bot acts on the bots' computer, so its face is a moving pointer. */
  waiting?: { computer?: boolean; label?: string | null; who?: FaceSource | null } | null
  /** A turn is running; the composer offers Stop, which becomes Send once there is text. */
  busy?: boolean

  onSend: (text: string) => void
  onStop?: () => void
  /** Leave out to hide the attach button. Its menu offers photos, the camera and files. */
  onAttach?: (source: AttachSource) => void
  attachments?: AttachmentView[]
  onRemoveAttachment?: (id: string) => void
  /** Controlled draft; leave both out to let the screen keep it. */
  draft?: string
  onDraftChange?: (text: string) => void
  /** Turn off sending while offline; the composer says why. */
  sendDisabledReason?: string | null

  onOpenSettings?: () => void

  onApprove: (
    requestId: string,
    choice: ApprovalChoice,
    answer?: CardAnswer
  ) => Promise<unknown> | void
  /** Your message Recall can take back; a long press on it offers Recall. */
  recallId?: string | null
  onRecall?: (id: string) => void

  archived?: boolean
  onUnarchive?: () => void

  /** The history is still on its way: show the face loading, not an empty chat. */
  opening?: boolean
  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void

  error?: string | null
  onRetry?: () => void
  onDismissError?: () => void

  /** Draw a message's text yourself, such as with a Markdown renderer. */
  renderMessageText?: (item: MessageItem) => ReactNode
  /**
   * A file the daemon keeps, as a URI to play; a bot's own chat only. `id` is
   * the message's file, so a file shared again after a change is read again.
   */
  loadMedia?: (path: string, id: string) => Promise<string>
  /** Opens the bots' computer on its own card; the button shows only with this. */
  onOpenComputer?: () => void
  /** A bot is acting on the computer, or you paused them: the button shows a dot. */
  computerLive?: boolean
  /** Opens a visual item from the transcript. */
  onOpenVisual?: (id: string) => void
  /** Previews a file the daemon keeps; its card opens it only with this. */
  onOpenFile?: (file: AttachmentView) => void
  /** Opens search in this conversation; the button shows only with this. */
  onOpenSearch?: () => void
  /** A message search found: the transcript scrolls to it and marks it. A new nonce shows it again. */
  focus?: { id: string; nonce: number } | null
  /** Under the empty state of a new chat, such as the model it will use. */
  intro?: ReactNode
  /** A card above the composer the chat needs answered before the next message, such as a new model. */
  notice?: ReactNode
}

type Entry = ChatItem | { id: string; kind: 'waiting' }
type ListEntry = { id: string; entry: Entry; continued: boolean }
const waitingEntry: Entry = { id: 'waiting', kind: 'waiting' }
const entryKey = (item: ListEntry) => item.id

/** One button in a chat's native bar. */
export interface BarAction {
  key: string
  label: string
  accessibilityLabel: string
  /** An SF Symbol on iOS. */
  systemImage:
    | 'desktopcomputer'
    | 'desktopcomputer.and.arrow.down'
    | 'gearshape'
    | 'magnifyingglass'
    | 'person.crop.circle'
  /** Drawn in the info colour, such as while a bot uses the computer. */
  live?: boolean
  onPress: () => void
}

/**
 * The buttons a chat puts in the system's bar, in reading order: Search, the
 * bots' computer, and the profile or room settings. iOS moves them into the
 * side rail on the closed iPhone Duo, top to bottom in the same order. Each
 * shows only when the screen offers it.
 */
export function chatActions(props: ChatScreenProps): BarAction[] {
  const room = !!props.members
  const actions: BarAction[] = []

  if (props.onOpenSearch) {
    actions.push({
      accessibilityLabel: room ? 'Search this room' : 'Search this chat',
      key: 'search',
      label: 'Search',
      onPress: props.onOpenSearch,
      systemImage: 'magnifyingglass'
    })
  }

  if (props.onOpenComputer) {
    actions.push({
      accessibilityLabel: "Your bots' computer",
      key: 'computer',
      label: 'Computer',
      live: props.computerLive,
      onPress: props.onOpenComputer,
      systemImage: props.computerLive ? 'desktopcomputer.and.arrow.down' : 'desktopcomputer'
    })
  }

  if (props.onOpenSettings) {
    actions.push({
      accessibilityLabel: room ? 'Room settings' : `Edit ${props.title}`,
      key: 'settings',
      label: room ? 'Room settings' : 'Profile',
      onPress: props.onOpenSettings,
      systemImage: room ? 'gearshape' : 'person.crop.circle'
    })
  }

  return actions
}

/** The chat's face and name for the system's bar; a press opens the profile or room settings. */
export function ChatTitle(props: ChatScreenProps) {
  const { face, members, onOpenSettings, status, subtitle, title } = props
  const room = !!members

  return (
    <Pressable
      accessibilityHint={
        onOpenSettings ? (room ? 'Opens the room settings' : 'Opens the profile') : undefined
      }
      accessibilityLabel={title}
      accessibilityRole={onOpenSettings ? 'button' : 'header'}
      disabled={!onOpenSettings}
      onPress={onOpenSettings}
      style={({ pressed }) => [styles.titleButton, { opacity: pressed ? 0.7 : 1 }]}
      testID="chat-title"
    >
      <Glass interactive={!!onOpenSettings} radius={24} style={styles.titlePill}>
        {room ? (
          <RoomFace members={members} name={title} size={30} status={status} />
        ) : (
          <BotFace
            {...(face ?? { name: title })}
            mood={props.emotion}
            name={title}
            size={30}
            status={status}
          />
        )}
        <View style={styles.titleText}>
          <Text numberOfLines={1} variant="subhead">
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} tone="muted" variant="caption">
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Glass>
    </Pressable>
  )
}

/**
 * One conversation: a bot's chat or a room. Bot messages sit on soft grey
 * bubbles on the left, yours on ink bubbles on the right. Tool use folds into
 * one quiet line per run, and approvals stop the transcript with a card.
 *
 * The screen is the transcript and the composer. Its bar belongs to the
 * system: `ChatTitle` and `chatActions` give the route what to put there.
 */
export function ChatScreen(props: ChatScreenProps) {
  return (
    <Screen avoidKeyboard edges={['left', 'right']} testID="chat-screen">
      <ChatBody {...props} />
    </Screen>
  )
}

/** The transcript and the composer. */
function ChatBody(props: ChatScreenProps) {
  const {
    archived,
    busy,
    error,
    face,
    hasEarlier,
    items,
    loadingEarlier,
    members,
    onLoadEarlier,
    onDismissError,
    onRetry,
    opening,
    title,
    waiting
  } = props
  const room = !!members
  const theme = useTheme()
  const keyboard = useKeyboardVisible()
  const insets = useSafeAreaInsets()
  const bottom = keyboard ? 8 : Math.max(insets.bottom, 8)

  // Inverted list: newest first, so the view starts at the bottom and stays there.
  const entries = useMemo<ListEntry[]>(() => {
    const list: ListEntry[] = []
    // The last message with something to show; a step with no words or files draws nothing.
    let said: MessageItem | undefined
    // Whether the last thing drawn is the bot's own bubble or card, which a card joins.
    let botLast = false
    for (const [index, entry] of items.entries()) {
      const previous = items[index - 1]
      const shown =
        entry.kind === 'message' && Boolean(entry.text || entry.attachments?.length || entry.error)
      // Between days and after a quiet spell, a divider says when.
      const at = shown ? (entry.createdAt ?? 0) : 0
      const divided = dividesChat(said ? (said.createdAt ?? 0) : undefined, at)
      if (divided)
        list.push({
          id: `day-${entry.id}`,
          entry: { kind: 'day', id: `day-${entry.id}`, at },
          continued: false
        })
      if (shown) said = entry
      list.push({
        id: entry.id,
        entry,
        continued:
          !divided &&
          (entry.kind === 'approval'
            ? botLast
            : entry.kind === 'message' &&
              previous?.kind === 'message' &&
              previous.role === entry.role &&
              previous.author?.name === entry.author?.name)
      })
      if (shown) botLast = entry.role === 'bot' && !entry.error
      else if (entry.kind !== 'message') botLast = entry.kind === 'approval'
    }
    list.reverse()

    return waiting ? [{ id: 'waiting', entry: waitingEntry, continued: false }, ...list] : list
  }, [items, !!waiting])
  const fallbackFace = useMemo(() => face ?? { name: title }, [face, title])
  const list = useRef<FlatList<ListEntry>>(null)
  const [flash, setFlash] = useState<null | { id: string; nonce: number }>(null)
  const { focus } = props
  // The request itself, not its nonce: a new conversation starts nonces over.
  const shown = useRef<typeof focus>(null)
  // Scroll to what search found once per request, not on every new message.
  useEffect(() => {
    if (!focus || shown.current === focus) return
    const index = entries.findIndex(item => item.id === focus.id)
    if (index < 0) return
    shown.current = focus
    list.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 })
    setFlash(focus)
  }, [entries, focus])
  // Its own timer, so new messages arriving meanwhile cannot leave the mark on.
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(timer)
  }, [flash])
  const {
    emotion,
    onApprove,
    onOpenFile,
    onOpenVisual,
    onRecall,
    recallId,
    renderMessageText,
    loadMedia
  } = props
  // The text a long press chose to select from; the sheet shows while it is set.
  const [selecting, setSelecting] = useState<string | null>(null)
  // Read at the press, so a message streaming in does not draw every row again.
  const latest = useRef(items)
  latest.current = items
  const pressMessage = useCallback(
    (id: string) => {
      const recall = id === recallId && onRecall ? () => onRecall(id) : undefined
      const item = latest.current.find(
        (entry): entry is MessageItem => entry.kind === 'message' && entry.id === id
      )
      // The browser preview selects with the mouse; a press there only recalls.
      if (Platform.OS === 'web' || !item?.text) return recall?.()
      // What the bubble shows: a bot's Markdown marks are drawn, not written.
      const text =
        item.role === 'user' || !renderMessageText ? item.text : messageText(item.text)
      messageMenu({
        copy: () => void Clipboard.setStringAsync(text),
        select: () => setSelecting(text),
        recall
      })
    },
    [onRecall, recallId, renderMessageText]
  )
  const waitingLabel = waiting?.label
  const waitingComputer = !!waiting?.computer
  const waitingWho = waiting?.who ?? (room ? null : fallbackFace)
  const renderItem = useCallback(
    ({ item: { entry, continued } }: ListRenderItemInfo<ListEntry>) => {
      const row = (
        <TranscriptEntry
          entry={entry}
          continued={continued}
          face={(entry.kind === 'message' || entry.kind === 'visual') && !room ? fallbackFace : undefined}
          room={room}
          onLongPress={entry.kind === 'message' ? pressMessage : undefined}
          renderText={entry.kind === 'message' ? renderMessageText : undefined}
          loadMedia={entry.kind === 'message' ? loadMedia : undefined}
          onOpenFile={entry.kind === 'message' ? onOpenFile : undefined}
          onApprove={entry.kind === 'approval' ? onApprove : undefined}
          onOpenVisual={entry.kind === 'visual' ? onOpenVisual : undefined}
          waitingLabel={entry.kind === 'waiting' ? waitingLabel : undefined}
          waitingWho={entry.kind === 'waiting' ? waitingWho : undefined}
          mood={
            entry.kind === 'waiting'
              ? (emotion ?? (waitingComputer ? 'computer' : undefined))
              : undefined
          }
        />
      )
      return entry.id === flash?.id ? (
        <View style={[styles.flash, { backgroundColor: withAlpha(theme.accent, 0.12) }]}>
          {row}
        </View>
      ) : (
        row
      )
    },
    [
      flash,
      theme.accent,
      room,
      fallbackFace,
      pressMessage,
      renderMessageText,
      loadMedia,
      onApprove,
      onOpenFile,
      onOpenVisual,
      waitingLabel,
      waitingWho,
      waitingComputer,
      emotion
    ]
  )

  return (
    <>
      <SelectTextSheet onClose={() => setSelecting(null)} text={selecting} />
      {items.length === 0 && !waiting && opening ? (
        <View style={styles.empty} testID="chat-opening">
          <LoadingFace {...(face ?? { name: title })} name={title} />
        </View>
      ) : items.length === 0 && !waiting ? (
        <ScrollView
          contentContainerStyle={styles.empty}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          testID="chat-empty"
        >
          {room ? (
            <RoomFace members={members} name={title} size={88} />
          ) : (
            <BotFace {...(face ?? { name: title })} mood="happy" name={title} size={88} />
          )}
          <Text align="center" variant="headline">
            {`Say hello to ${title}`}
          </Text>
          {room ? (
            <Text align="center" tone="muted" variant="callout">
              Mention a bot with @ to ask it directly. Otherwise the main bot answers.
            </Text>
          ) : null}
          {props.intro}
        </ScrollView>
      ) : (
        <FlatList
          ListFooterComponent={
            hasEarlier && onLoadEarlier ? (
              <View style={styles.earlier}>
                <Button
                  busy={loadingEarlier}
                  busyLabel="Loading…"
                  label="Show earlier messages"
                  onPress={onLoadEarlier}
                  testID="chat-load-earlier"
                  variant="plain"
                />
              </View>
            ) : undefined
          }
          contentContainerStyle={styles.transcript}
          data={entries}
          inverted
          keyExtractor={entryKey}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={info => {
            // Rows far up are not measured yet: get near, then try again.
            list.current?.scrollToOffset({
              animated: false,
              offset: info.averageItemLength * info.index
            })
            setTimeout(
              () =>
                list.current?.scrollToIndex({
                  animated: true,
                  index: info.index,
                  viewPosition: 0.5
                }),
              100
            )
          }}
          ref={list}
          renderItem={renderItem}
          testID="chat-transcript"
        />
      )}

      {error ? (
        <View style={styles.error}>
          <Banner
            actionLabel={onRetry ? 'Try again' : undefined}
            message={error}
            onAction={onRetry}
            onDismiss={onDismissError}
            testID="chat-error"
          />
        </View>
      ) : null}

      {archived ? (
        <View style={[styles.archived, { paddingBottom: bottom }]} testID="chat-archived">
          <Text style={styles.archivedText} tone="muted" variant="callout">
            {room ? 'This room is archived.' : 'This chat is archived.'}
          </Text>
          {props.onUnarchive ? (
            <Button
              label="Restore"
              onPress={props.onUnarchive}
              testID="chat-unarchive"
              variant="secondary"
            />
          ) : null}
        </View>
      ) : (
        <>
          {props.notice ? <View style={styles.modelNotice}>{props.notice}</View> : null}
          <Composer {...props} bottom={bottom} busy={busy} />
        </>
      )}
    </>
  )
}

const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  continued,
  face,
  room,
  onLongPress,
  renderText,
  loadMedia,
  onApprove,
  onOpenFile,
  onOpenVisual,
  waitingLabel,
  waitingWho,
  mood
}: {
  entry: Entry
  continued: boolean
  face?: FaceSource
  room: boolean
  onLongPress?: (id: string) => void
  renderText?: ChatScreenProps['renderMessageText']
  loadMedia?: ChatScreenProps['loadMedia']
  onApprove?: ChatScreenProps['onApprove']
  onOpenFile?: ChatScreenProps['onOpenFile']
  onOpenVisual?: ChatScreenProps['onOpenVisual']
  waitingLabel?: string | null
  waitingWho?: FaceSource | null
  mood?: FaceMood
}) {
  switch (entry.kind) {
    case 'waiting':
      return <WaitingRow label={waitingLabel} mood={mood} who={waitingWho} />
    case 'day':
      return (
        <Text align="center" style={styles.day} tone="muted" variant="caption">
          {formatDayDivider(entry.at)}
        </Text>
      )
    case 'notice':
      return (
        <Text
          align="center"
          style={styles.notice}
          tone={entry.tone === 'danger' ? 'danger' : 'muted'}
          variant="footnote"
        >
          {entry.text}
        </Text>
      )
    case 'visual':
      return (
        <View style={styles.visualItem}>
          <VisualCard
            face={face}
            onOpen={() => onOpenVisual?.(entry.id)}
            testID={`visual-open-${entry.index}`}
            title={entry.title}
          />
        </View>
      )
    case 'approval':
      return entry.request.form?.kind === 'plugin' ? (
        <PluginCard
          form={entry.request.form}
          joined={continued}
          onAnswer={onApprove!}
          request={entry.request}
        />
      ) : entry.request.form ? (
        <SignInCard
          form={entry.request.form}
          joined={continued}
          onAnswer={onApprove!}
          request={entry.request}
        />
      ) : (
        <ApprovalCard joined={continued} onAnswer={onApprove!} request={entry.request} />
      )
    case 'message': {
      return (
        <MessageBubble
          chat={{ face: face ?? null, room }}
          continued={continued}
          item={entry}
          onLongPress={onLongPress}
          renderText={renderText}
          loadMedia={loadMedia}
          onOpenFile={onOpenFile}
          showAuthor={room && entry.role !== 'user' && !continued}
        />
      )
    }
  }
})

function MessageBubble({
  chat,
  continued,
  item,
  onLongPress,
  renderText,
  loadMedia,
  onOpenFile,
  showAuthor
}: {
  /** The thread's bot, for replies that do not name one. */
  chat: { face: FaceSource | null; room: boolean }
  item: MessageItem
  continued: boolean
  showAuthor: boolean
  onLongPress?: (id: string) => void
  renderText?: (item: MessageItem) => ReactNode
  loadMedia?: ChatScreenProps['loadMedia']
  onOpenFile?: ChatScreenProps['onOpenFile']
}) {
  const theme = useTheme()
  const mine = item.role === 'user'
  const rendered = renderText && !mine ? renderText(item) : null

  return (
    <View
      style={[
        styles.message,
        { alignItems: mine ? 'flex-end' : 'flex-start', marginTop: continued ? 4 : 14 }
      ]}
    >
      {showAuthor && item.author ? (
        <View style={styles.author}>
          {item.role === 'bot' ? <BotFace {...item.author} size={20} /> : null}
          <Text tone="muted" variant="caption">
            {item.author.name}
          </Text>
        </View>
      ) : null}
      {item.text || rendered ? (
        <Pressable
          accessibilityHint={onLongPress ? 'Long press for options' : undefined}
          delayLongPress={350}
          onLongPress={onLongPress ? () => onLongPress(item.id) : undefined}
          style={[styles.bubble, { backgroundColor: bubbleFill(item, chat, theme) }]}
          testID={`chat-message-${item.id}`}
        >
          {rendered ? (
            rendered
          ) : (
            <Text
              selectable={Platform.OS === 'web'}
              style={mine ? { color: theme.onInk } : null}
              variant="body"
            >
              {item.text}
            </Text>
          )}
        </Pressable>
      ) : null}
      {item.attachments?.length ? (
        <View style={[styles.attachments, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
          {item.attachments.map(file => {
            const card = (
              <FileCard
                key={file.id}
                name={file.name}
                onOpen={file.path && onOpenFile ? () => onOpenFile(file) : undefined}
                testID={`chat-file-${file.id}`}
              />
            )
            return file.kind === 'image' || file.kind === 'video' || file.kind === 'audio' ? (
              <MediaAttachment card={card} file={file} key={file.id} load={loadMedia} />
            ) : (
              card
            )
          })}
        </View>
      ) : null}
      {item.error ? (
        <View accessibilityRole="alert" style={styles.messageError}>
          <Ionicons color={theme.danger} name="alert-circle" size={14} />
          <Text tone="danger" variant="footnote">
            {item.error}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/**
 * What a long press on a message offers: the system's action sheet on iOS,
 * a dialog on Android, which holds three choices and closes with Back.
 */
function messageMenu(actions: { copy: () => void; select: () => void; recall?: () => void }) {
  const { copy, select, recall } = actions
  if (Platform.OS === 'ios') {
    const options = ['Copy', 'Select text', ...(recall ? ['Recall'] : []), 'Cancel']
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: recall ? 2 : undefined,
        options
      },
      index => [copy, select, recall][index]?.()
    )
    return
  }
  Alert.alert(
    'Message',
    undefined,
    [
      ...(recall ? [{ onPress: recall, style: 'destructive' as const, text: 'Recall' }] : []),
      { onPress: select, text: 'Select text' },
      { onPress: copy, text: 'Copy' }
    ],
    { cancelable: true }
  )
}

function WaitingRow({
  label,
  mood,
  who
}: {
  label?: string | null
  mood?: FaceMood
  who?: FaceSource | null
}) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.waiting} testID="chat-waiting">
      {who ? <BotFace {...who} mood={mood ?? 'working'} size={26} /> : null}
      <Text tone="muted" variant="footnote">
        {label || 'Thinking…'}
      </Text>
    </View>
  )
}

/** A bot's visual as a post in the transcript; Open shows it on its own card. */
export function VisualCard({
  face,
  onOpen,
  testID,
  title
}: {
  /** The bot that drew it: the card takes its bubbles' wash and its face colour. */
  face?: FaceSource | null
  title: string
  onOpen: () => void
  testID: string
}) {
  const theme = useTheme()
  const paint = face ? faceColor(face) : null
  const wash = face ? faceWash(face, theme.fill, theme.scheme) : theme.fill

  return (
    <Pressable
      accessibilityHint="Opens the visual"
      accessibilityLabel={`${title}, visual`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.visual,
        { backgroundColor: wash, opacity: pressed ? 0.7 : 1 }
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.visualIcon,
          { backgroundColor: paint?.color ?? withAlpha(theme.text, 0.08) }
        ]}
        testID={`${testID}-icon`}
      >
        <Ionicons color={paint?.on ?? theme.muted} name="bar-chart" size={22} />
      </View>
      <View style={styles.visualText}>
        <Text numberOfLines={2} variant="subhead">
          {title}
        </Text>
        <Text tone="muted" variant="footnote">
          Interactive visual
        </Text>
      </View>
      <View style={[styles.visualOpen, { backgroundColor: withAlpha(theme.text, 0.08) }]}>
        <Text variant="subhead">Open</Text>
      </View>
    </Pressable>
  )
}

const CHOICE_LABELS: Record<ApprovalChoice, string> = {
  deny: 'Deny',
  once: 'Allow once',
  session: 'Allow for now'
}

const DECISION_LABELS: Record<ApprovalChoice, string> = {
  deny: 'Denied',
  once: 'Allowed once',
  session: 'Allowed for now'
}

/** A bot asking before it acts: what it wants to run, why, and the answers. */
export function ApprovalCard({
  joined,
  onAnswer,
  request
}: {
  /** Right under the bot's own bubble or card: it sits 4 pt below, one stack. */
  joined?: boolean
  request: ApprovalRequestView
  onAnswer: (requestId: string, choice: ApprovalChoice) => void
}) {
  const theme = useTheme()
  const decided = request.decision
  const allow = request.choices.filter(choice => choice !== 'deny')

  return (
    <View
      accessibilityLabel={decided ? undefined : 'Approval needed'}
      style={[styles.approval, joined && styles.joined, { backgroundColor: theme.fill }]}
      testID={`approval-${request.requestId}`}
    >
      <View style={styles.approvalHead}>
        <Ionicons color={decided ? theme.muted : theme.accent} name="hand-left-outline" size={18} />
        <Text variant="subhead">{request.toolLabel || 'Wants to run a command'}</Text>
      </View>
      {request.reason ? <Text variant="callout">{request.reason}</Text> : null}
      {request.command ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.command, { backgroundColor: theme.inset }]}
        >
          <Text selectable style={styles.commandText} variant="footnote">
            {request.command}
          </Text>
        </ScrollView>
      ) : null}
      {decided ? (
        <View style={styles.decision}>
          <Ionicons
            color={decided === 'deny' ? theme.danger : theme.success}
            name={decided === 'deny' ? 'close-circle' : 'checkmark-circle'}
            size={16}
          />
          <Text tone="muted" variant="footnote">
            {DECISION_LABELS[decided]}
          </Text>
        </View>
      ) : (
        <View style={styles.approvalActions}>
          {allow.map((choice, index) => (
            <Button
              key={choice}
              label={CHOICE_LABELS[choice]}
              onPress={() => onAnswer(request.requestId, choice)}
              style={[styles.approvalButton, index > 0 && { backgroundColor: theme.inset }]}
              testID={`approval-${request.requestId}-${choice}`}
              variant={index === 0 ? 'primary' : 'secondary'}
            />
          ))}
          {request.choices.includes('deny') ? (
            <Button
              label="Deny"
              onPress={() => onAnswer(request.requestId, 'deny')}
              style={[styles.approvalButton, { backgroundColor: theme.inset }]}
              testID={`approval-${request.requestId}-deny`}
              variant="secondary"
            />
          ) : null}
        </View>
      )}
    </View>
  )
}

function Composer({
  attachments,
  bottom,
  busy,
  draft,
  onAttach,
  onDraftChange,
  onRemoveAttachment,
  onSend,
  onStop,
  sendDisabledReason,
  title
}: ChatScreenProps & { bottom: number }) {
  const theme = useTheme()
  // A phone held sideways is short: the field grows to a third of it at most.
  const { height } = useWindowDimensions()
  const [own, setOwn] = useState('')
  const plus = useRef<ComponentRef<typeof View>>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const text = draft ?? own
  const setText = onDraftChange ?? setOwn
  const canSend = (text.trim() !== '' || !!attachments?.length) && !sendDisabledReason

  const send = () => {
    if (!canSend) {
      return
    }

    onSend(text.trim())

    if (draft === undefined) {
      setOwn('')
    }
  }

  return (
    <View style={[styles.composer, { paddingBottom: bottom }]} testID="chat-composer">
      {sendDisabledReason ? (
        <Text align="center" tone="muted" variant="footnote">
          {sendDisabledReason}
        </Text>
      ) : null}
      {attachments?.length ? (
        <ScrollView
          contentContainerStyle={styles.pending}
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {attachments.map(file => (
            <View key={file.id} style={[styles.pendingFile, { backgroundColor: theme.fill }]}>
              <Ionicons
                color={theme.muted}
                name={
                  file.kind === 'image'
                    ? 'image-outline'
                    : file.kind === 'video'
                      ? 'videocam-outline'
                      : 'document-outline'
                }
                size={16}
              />
              <Text numberOfLines={1} style={styles.fileName} variant="footnote">
                {file.name}
              </Text>
              {onRemoveAttachment ? (
                <IconButton
                  accessibilityLabel={`Remove ${file.name}`}
                  color={theme.muted}
                  icon="close"
                  iconSize={16}
                  onPress={() => onRemoveAttachment(file.id)}
                  size={28}
                  testID={`chat-attachment-remove-${file.id}`}
                />
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.composerRow}>
        {onAttach ? (
          <View collapsable={false} ref={plus}>
            <IconButton
              accessibilityLabel="Attach a photo, video or file"
              icon="add"
              iconSize={24}
              onPress={() => plus.current?.measureInWindow((x, y, w, h) => setMenu({ h, w, x, y }))}
              testID="chat-attach"
              variant="glass"
            />
            <AttachMenu anchor={menu} onChoose={onAttach} onClose={() => setMenu(null)} />
          </View>
        ) : null}
        <Glass radius={24} style={styles.inputWell}>
          <TextInput
            accessibilityLabel={`Message ${title}`}
            maxFontSizeMultiplier={1.6}
            multiline
            onChangeText={setText}
            placeholder={`Message ${title}`}
            placeholderTextColor={theme.faint}
            selectionColor={theme.accent}
            style={[
              styles.input,
              { color: theme.text, maxHeight: Math.min(140, Math.round(height / 3)) }
            ]}
            submitBehavior="newline"
            testID="chat-input"
            value={text}
          />
          {busy && onStop && !canSend ? (
            <IconButton
              accessibilityLabel="Stop"
              icon="stop"
              iconSize={14}
              onPress={onStop}
              size={36}
              style={styles.wellButton}
              testID="chat-stop"
              variant="filled"
            />
          ) : null}
          {!busy || canSend || !onStop ? (
            <IconButton
              accessibilityLabel="Send"
              disabled={!canSend}
              icon="arrow-up"
              iconSize={20}
              onPress={send}
              size={36}
              style={styles.wellButton}
              testID="chat-send"
              variant="filled"
            />
          ) : null}
        </Glass>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  approval: { borderRadius: radius.bubble, gap: 10, marginTop: 14, maxWidth: '92%', padding: 14 },
  approvalActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  approvalButton: { minHeight: 44, paddingHorizontal: 18 },
  approvalHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  archived: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  archivedText: { textAlign: 'center' },
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, maxWidth: '82%' },
  author: { alignItems: 'center', flexDirection: 'row', gap: 6, marginBottom: 4, marginLeft: 4 },
  bubble: {
    borderRadius: radius.bubble,
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  command: { borderRadius: 12, flexGrow: 0 },
  commandText: { fontFamily: mono, padding: 12 },
  composer: { gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 8 },
  day: { marginBottom: 2, marginTop: 18 },
  decision: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  earlier: { alignItems: 'center', paddingVertical: 8 },
  empty: {
    alignItems: 'center',
    flexGrow: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 24
  },
  error: { paddingHorizontal: 12, paddingTop: 6 },
  modelNotice: { paddingHorizontal: 12, paddingTop: 6 },
  fileName: { flexShrink: 1 },
  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 22,
    maxHeight: 140,
    minHeight: 44,
    paddingBottom: 11,
    paddingHorizontal: 16,
    paddingTop: 11
  },
  inputWell: { alignItems: 'flex-end', flex: 1, flexDirection: 'row', minHeight: 48 },
  message: { width: '100%' },
  messageError: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 4
  },
  joined: { marginTop: 4 },
  notice: { marginTop: 14, paddingHorizontal: 24 },
  pending: { gap: 8 },
  pendingFile: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    maxWidth: 220,
    paddingLeft: 12,
    paddingRight: 4
  },
  titleButton: { maxWidth: '100%' },
  titlePill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minHeight: 44,
    paddingLeft: 7,
    paddingRight: 14
  },
  titleText: { flexShrink: 1 },
  flash: { borderRadius: 16 },
  transcript: { paddingBottom: 8, paddingHorizontal: 14, paddingTop: 12 },
  visual: {
    alignItems: 'center',
    borderRadius: radius.bubble,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    padding: 12
  },
  visualItem: { marginTop: 10, maxWidth: '88%' },
  visualIcon: {
    alignItems: 'center',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    width: 44
  },
  visualOpen: { borderRadius: 999, justifyContent: 'center', minHeight: 36, paddingHorizontal: 14 },
  visualText: { flex: 1, gap: 2 },
  waiting: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 14 },
  wellButton: { marginBottom: 6, marginRight: 6 }
})
