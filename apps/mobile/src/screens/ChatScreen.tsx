import { Ionicons } from '@expo/vector-icons'
import { type ReactNode, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  Banner,
  BotFace,
  type BotStatus,
  Button,
  type FaceSource,
  formatDayDivider,
  Glass,
  IconButton,
  type IconName,
  mono,
  radius,
  RoomFace,
  Screen,
  Text,
  TopBar,
  useKeyboardVisible,
  useTheme,
  withAlpha
} from '../ui'
import type {
  ApprovalChoice,
  ApprovalRequestView,
  AttachmentView,
  ChatItem,
  ToolActivity
} from './types'

type MessageItem = Extract<ChatItem, { kind: 'message' }>

export interface ChatScreenProps {
  /** The bot's or the room's name. */
  title: string
  /** The bot's face. Rooms pass `members` instead. */
  face?: FaceSource
  members?: FaceSource[]
  status?: BotStatus
  /** The open conversation's title, under the name. */
  sectionTitle?: string | null

  /** The transcript, oldest first. */
  items: ChatItem[]
  /** A bot is working but has not written anything yet. */
  waiting?: { label?: string | null; who?: FaceSource | null } | null
  /** A turn is running; the composer offers Stop. */
  busy?: boolean

  onSend: (text: string) => void
  onStop?: () => void
  /** Leave out to hide the attach button. */
  onAttach?: () => void
  attachments?: AttachmentView[]
  onRemoveAttachment?: (id: string) => void
  /** Controlled draft; leave both out to let the screen keep it. */
  draft?: string
  onDraftChange?: (text: string) => void
  /** Turn off sending while offline; the composer says why. */
  sendDisabledReason?: string | null

  onBack: () => void
  /** Opens the conversation picker from the title. */
  onOpenSections?: () => void
  onNewSection?: () => void
  onOpenSettings?: () => void

  onApprove: (requestId: string, choice: ApprovalChoice) => void
  onMessageLongPress?: (id: string) => void

  archived?: boolean
  onUnarchive?: () => void

  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void

  error?: string | null
  onRetry?: () => void

  /** Draw a message's text yourself, such as with a Markdown renderer. */
  renderMessageText?: (item: MessageItem) => ReactNode
  /** Opens one tool call on its own card. */
  onOpenTool?: (tool: ToolActivity) => void
  /** Opens a visual item from the transcript. */
  onOpenVisual?: (id: string) => void
  /** Under the empty state of a new thread, such as the model it will use. */
  intro?: ReactNode
}

type Entry = ChatItem | { id: string; kind: 'waiting' }

/**
 * One conversation: a bot section or a room. Bot messages sit on soft grey
 * bubbles on the left, yours on ink bubbles on the right. Tool use folds into
 * one quiet line per run, and approvals stop the transcript with a card.
 */
export function ChatScreen(props: ChatScreenProps) {
  const {
    face,
    members,
    onBack,
    onNewSection,
    onOpenSections,
    onOpenSettings,
    sectionTitle,
    status,
    title
  } = props
  const theme = useTheme()
  const room = !!members

  const header = (
    <Pressable
      accessibilityHint={onOpenSections ? 'Switch to another thread' : undefined}
      accessibilityLabel={sectionTitle ? `${title}, ${sectionTitle}` : title}
      accessibilityRole={onOpenSections ? 'button' : 'header'}
      disabled={!onOpenSections}
      onPress={onOpenSections}
      style={({ pressed }) => [styles.titleButton, { opacity: pressed ? 0.6 : 1 }]}
      testID="chat-title"
    >
      <Glass interactive={!!onOpenSections} radius={24} style={styles.titlePill}>
        {room ? (
          <RoomFace members={members} name={title} size={30} status={status} />
        ) : (
          <BotFace {...(face ?? { name: title })} name={title} size={30} status={status} />
        )}
        <View style={styles.titleText}>
          <Text numberOfLines={1} variant="subhead">
            {title}
          </Text>
          {sectionTitle ? (
            <Text maxFontSizeMultiplier={1.2} numberOfLines={1} tone="muted" variant="caption">
              {sectionTitle}
            </Text>
          ) : null}
        </View>
        {onOpenSections ? <Ionicons color={theme.muted} name="chevron-down" size={14} /> : null}
      </Glass>
    </Pressable>
  )

  return (
    <Screen avoidKeyboard testID="chat-screen">
      <TopBar
        center={header}
        onBack={onBack}
        testID="chat-bar"
        trailing={
          <>
            {onNewSection ? (
              <IconButton
                accessibilityLabel="New conversation"
                icon="create-outline"
                iconSize={21}
                onPress={onNewSection}
                testID="chat-new-section"
                variant="glass"
              />
            ) : null}
            {onOpenSettings ? (
              <IconButton
                accessibilityLabel={room ? 'Group settings' : `Edit ${title}`}
                icon="ellipsis-horizontal"
                iconSize={21}
                onPress={onOpenSettings}
                testID="chat-settings"
                variant="glass"
              />
            ) : null}
          </>
        }
      />
      <ChatBody {...props} />
    </Screen>
  )
}

/**
 * The transcript and the composer without a screen around them, so a tab
 * can host a conversation. `bottomInset` lifts the composer above a tab bar.
 */
export function ChatBody(
  props: Omit<ChatScreenProps, 'onBack'> & { onBack?: () => void; bottomInset?: number }
) {
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
    onRetry,
    title,
    waiting
  } = props
  const room = !!members
  const keyboard = useKeyboardVisible()
  const insets = useSafeAreaInsets()
  const bottom = keyboard ? 8 : Math.max(props.bottomInset ?? insets.bottom, 8)

  // Inverted list: newest first, so the view starts at the bottom and stays there.
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [...items].reverse()

    return waiting ? [{ id: 'waiting', kind: 'waiting' }, ...list] : list
  }, [items, waiting])

  return (
    <>
      {items.length === 0 && !waiting ? (
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
            {room ? `Say hello to ${title}` : `New thread with ${title}`}
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
          keyExtractor={entry => entry.id}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={({ index, item }) => (
            <TranscriptEntry
              entry={item}
              // Inverted, so the chronologically previous entry is the next index.
              previous={entries[index + 1]}
              props={props}
              room={room}
            />
          )}
          testID="chat-transcript"
        />
      )}

      {error ? (
        <View style={styles.error}>
          <Banner
            actionLabel={onRetry ? 'Try again' : undefined}
            message={error}
            onAction={onRetry}
            testID="chat-error"
          />
        </View>
      ) : null}

      {archived ? (
        <View style={[styles.archived, { paddingBottom: bottom }]} testID="chat-archived">
          <Text style={styles.archivedText} tone="muted" variant="callout">
            {room ? 'This group is archived.' : 'This thread is archived.'}
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
        <Composer {...props} bottom={bottom} busy={busy} />
      )}
    </>
  )
}

function TranscriptEntry({
  entry,
  previous,
  props,
  room
}: {
  entry: Entry
  previous?: Entry
  props: Omit<ChatScreenProps, 'onBack'>
  room: boolean
}) {
  switch (entry.kind) {
    case 'waiting':
      return (
        <WaitingRow
          label={props.waiting?.label}
          who={props.waiting?.who ?? (room ? null : (props.face ?? { name: props.title }))}
        />
      )
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
    case 'tools':
      return <ToolsCard id={entry.id} onOpen={props.onOpenTool} tools={entry.tools} />
    case 'visual':
      return (
        <View style={styles.visualItem}>
          <VisualCard
            onOpen={() => props.onOpenVisual?.(entry.id)}
            testID={`visual-open-${entry.index}`}
            title={entry.title}
          />
        </View>
      )
    case 'approval':
      return <ApprovalCard onAnswer={props.onApprove} request={entry.request} />
    case 'message': {
      const run =
        previous?.kind === 'message' &&
        previous.role === entry.role &&
        previous.author?.name === entry.author?.name

      return (
        <MessageBubble
          continued={run}
          item={entry}
          onLongPress={props.onMessageLongPress}
          renderText={props.renderMessageText}
          showAuthor={room && entry.role === 'bot' && !run}
        />
      )
    }
  }
}

function MessageBubble({
  continued,
  item,
  onLongPress,
  renderText,
  showAuthor
}: {
  item: MessageItem
  continued: boolean
  showAuthor: boolean
  onLongPress?: (id: string) => void
  renderText?: (item: MessageItem) => ReactNode
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
          <BotFace {...item.author} size={20} />
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
          style={[
            styles.bubble,
            mine ? { backgroundColor: theme.ink } : { backgroundColor: theme.fill }
          ]}
          testID={`chat-message-${item.id}`}
        >
          {rendered ? (
            rendered
          ) : (
            <Text selectable style={mine ? { color: theme.onInk } : null} variant="body">
              {item.text}
            </Text>
          )}
        </Pressable>
      ) : null}
      {item.attachments?.length ? (
        <View style={[styles.attachments, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
          {item.attachments.map(file =>
            file.kind === 'image' && file.uri ? (
              <Image
                accessibilityLabel={file.name}
                key={file.id}
                source={{ uri: file.uri }}
                style={[styles.image, { backgroundColor: theme.fill }]}
              />
            ) : (
              <View key={file.id} style={[styles.file, { borderColor: theme.hairline }]}>
                <Ionicons color={theme.muted} name="document-outline" size={16} />
                <Text numberOfLines={1} style={styles.fileName} variant="footnote">
                  {file.name}
                </Text>
              </View>
            )
          )}
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

function WaitingRow({ label, who }: { label?: string | null; who?: FaceSource | null }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.waiting} testID="chat-waiting">
      {who ? <BotFace {...who} mood="working" size={26} /> : null}
      <Text tone="muted" variant="footnote">
        {label || 'Thinking…'}
      </Text>
    </View>
  )
}

const TOOL_GLYPHS: Record<string, IconName> = {
  browser: 'compass-outline',
  clarify: 'help-circle-outline',
  delegate: 'git-branch-outline',
  edit: 'create-outline',
  edit_file: 'create-outline',
  read_file: 'document-text-outline',
  write_file: 'create-outline',
  web_fetch: 'globe-outline',
  message_bot: 'chatbubbles-outline',
  memory: 'bookmark-outline',
  hexbot_show_html: 'bar-chart-outline',
  ls: 'folder-open-outline',
  read: 'document-text-outline',
  terminal: 'terminal-outline',
  bash: 'terminal-outline',
  web_search: 'search-outline',
  write: 'create-outline'
}

const glyphFor = (name = ''): IconName => TOOL_GLYPHS[name] ?? 'construct-outline'

/** How many tool lines show before the rest fold away. */
const TOOL_LINES = 3

/**
 * A run of tool calls as quiet lines under the bot's message, one per call,
 * like a log you can skim. Tap a line to see the call on its own card.
 */
function ToolsCard({
  id,
  onOpen,
  tools
}: {
  id: string
  tools: ToolActivity[]
  onOpen?: (tool: ToolActivity) => void
}) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const shown = open ? tools : tools.slice(-TOOL_LINES)
  const hidden = tools.length - shown.length
  const color = { error: theme.danger, ok: theme.muted, running: theme.info }

  return (
    <View style={styles.tools} testID={`chat-tools-${id}`}>
      {hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={styles.toolLine}
          testID={`chat-tools-${id}-more`}
        >
          <Ionicons color={theme.faint} name="chevron-up" size={15} />
          <Text tone="muted" variant="footnote">
            {hidden === 1 ? '1 earlier step' : `${hidden} earlier steps`}
          </Text>
        </Pressable>
      ) : null}
      {shown.map(tool => (
        <Pressable
          accessibilityHint={onOpen ? 'Shows what this step did' : undefined}
          accessibilityLabel={`${tool.label}, ${tool.status === 'running' ? 'running' : tool.status === 'error' ? 'failed' : 'done'}`}
          accessibilityRole={onOpen ? 'button' : undefined}
          disabled={!onOpen}
          key={tool.id}
          onPress={() => onOpen?.(tool)}
          style={({ pressed }) => [styles.toolLine, { opacity: pressed ? 0.6 : 1 }]}
          testID={`chat-tool-${tool.id}`}
        >
          {tool.status === 'running' ? (
            <ActivityIndicator color={theme.info} size="small" style={styles.toolSpinner} />
          ) : (
            <Ionicons
              color={color[tool.status]}
              name={tool.status === 'error' ? 'alert-circle-outline' : glyphFor(tool.name)}
              size={16}
            />
          )}
          <Text
            numberOfLines={1}
            style={[styles.toolLabel, tool.status === 'error' && { color: theme.danger }]}
            tone="muted"
            variant="footnote"
          >
            {tool.label}
          </Text>
          {tool.detail ? (
            <Text numberOfLines={1} style={styles.toolDetail} tone="faint" variant="caption">
              {tool.detail.replace(/\s+/g, ' ')}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}

/** A bot's visual as a post in the transcript; Open shows it on its own card. */
export function VisualCard({
  onOpen,
  testID,
  title
}: {
  title: string
  onOpen: () => void
  testID: string
}) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityHint="Opens the visual"
      accessibilityLabel={`${title}, visual`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.visual,
        { backgroundColor: theme.surface, borderColor: theme.hairline, opacity: pressed ? 0.7 : 1 }
      ]}
      testID={testID}
    >
      <View style={[styles.visualIcon, { backgroundColor: withAlpha(theme.accent, 0.12) }]}>
        <Ionicons color={theme.accent} name="bar-chart" size={22} />
      </View>
      <View style={styles.visualText}>
        <Text numberOfLines={2} variant="subhead">
          {title}
        </Text>
        <Text tone="muted" variant="footnote">
          Interactive visual
        </Text>
      </View>
      <View style={[styles.visualOpen, { backgroundColor: theme.fill }]}>
        <Text variant="subhead">Open</Text>
      </View>
    </Pressable>
  )
}

const CHOICE_LABELS: Record<ApprovalChoice, string> = {
  deny: 'Deny',
  once: 'Allow once',
  session: 'Allow in this conversation'
}

const DECISION_LABELS: Record<ApprovalChoice, string> = {
  deny: 'Denied',
  once: 'Allowed once',
  session: 'Allowed in this conversation'
}

/** A bot asking before it acts: what it wants to run, why, and the answers. */
export function ApprovalCard({
  onAnswer,
  request
}: {
  request: ApprovalRequestView
  onAnswer: (requestId: string, choice: ApprovalChoice) => void
}) {
  const theme = useTheme()
  const decided = request.decision
  const allow = request.choices.filter(choice => choice !== 'deny')

  return (
    <View
      accessibilityLabel={decided ? undefined : 'Approval needed'}
      style={[styles.approval, { backgroundColor: theme.fill }]}
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
}: Omit<ChatScreenProps, 'onBack'> & { bottom: number }) {
  const theme = useTheme()
  const [own, setOwn] = useState('')
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
                name={file.kind === 'image' ? 'image-outline' : 'document-outline'}
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
          <IconButton
            accessibilityLabel="Attach a file"
            icon="add"
            iconSize={24}
            onPress={onAttach}
            testID="chat-attach"
            variant="glass"
          />
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
            style={[styles.input, { color: theme.text }]}
            submitBehavior="newline"
            testID="chat-input"
            value={text}
          />
          {busy && onStop ? (
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
          {!busy || text.trim() ? (
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
  file: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    maxWidth: 240,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  fileName: { flexShrink: 1 },
  image: { borderRadius: 16, height: 140, width: 180 },
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
  toolDetail: { flexShrink: 2, marginLeft: 'auto', maxWidth: '45%' },
  toolLabel: { flexShrink: 1 },
  toolLine: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 30 },
  toolSpinner: { height: 16, transform: [{ scale: 0.7 }], width: 16 },
  tools: { alignSelf: 'stretch', marginTop: 10, paddingHorizontal: 4 },
  transcript: { paddingBottom: 8, paddingHorizontal: 14, paddingTop: 12 },
  visual: {
    alignItems: 'center',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
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
