import { File } from 'expo-file-system'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Image as RNImage, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { Button } from '../../components/button'
import { Bubble } from '../../components/chat/bubble'
import { ApprovalCard, errorSentence, StoppedCard } from '../../components/chat/cards'
import { ChatList, type ChatListHandle } from '../../components/chat/chat-list'
import { DaySeparator, EdgeFade, EmptySection, PillFace, PinnedPill, TitlePill } from '../../components/chat/chrome'
import { ClarifyCard } from '../../components/chat/clarify-card'
import { Composer, type StagedFile } from '../../components/chat/composer'
import { buildRows, type Row } from '../../components/chat/timeline'
import { LiveStatus, MemoryMarks, WorkingFace, WorkSummary } from '../../components/chat/work'
import { BotFace } from '../../components/face'
import { fileAttach, imageAttachBytes, pdfAttach, sectionsMarkRead, sessionInterrupt } from '../../lib/api'
import { attachmentPrompt, submitChatPrompt } from '../../lib/chat-send'
import { freshSection, openSection } from '../../lib/navigation'
import type { Attachment, Bot } from '../../lib/types'
import { useBot } from '../../stores/bots'
import { connectorsActions } from '../../stores/connectors'
import { useConnection } from '../../stores/connection'
import { liveSectionsOf, sectionsActions, sectionStatusOf, useLiveSessionId, useSection } from '../../stores/sections'
import { setFocusedSection, transcriptActions, type TranscriptMessage, useTranscript } from '../../stores/transcripts'
import { uiActions } from '../../stores/ui'
import { useTheme } from '../../theme'

const NO_MESSAGES: TranscriptMessage[] = []

/**
 * A Stopped card from the bot's `status_detail`, for a section opened after
 * the failure (the live event only reaches open transcripts). Null once the
 * transcript has its own error row.
 */
function stoppedCardFor(bot: Bot | undefined, sectionId: string, messages: TranscriptMessage[]): null | TranscriptMessage {
  const detail = bot?.status === 'stopped' ? bot.status_detail : null

  if (!detail || detail.section_id !== sectionId || messages.some(message => message.error)) {
    return null
  }

  return {
    attachments: [],
    createdAt: detail.since,
    error: detail.text,
    errorDetail: { connector: detail.action?.kind === 'fix_connector' ? detail.action.connector : null },
    id: `status-${sectionId}`,
    role: 'system',
    streaming: false,
    text: '',
    toolCalls: []
  }
}

/** Stage each picked file on the session the way the web composer does. */
async function upload(sessionId: string, files: StagedFile[]): Promise<Attachment[]> {
  for (const file of files) {
    const limitMiB = file.kind === 'image' ? 25 : 45

    if (file.size > limitMiB * 1024 * 1024) {
      throw new Error(`${file.name} is larger than ${limitMiB} MB.`)
    }

    const base64 = await new File(file.uri).base64()

    if (file.kind === 'image') {
      await imageAttachBytes(sessionId, base64, file.name)
    } else if (file.kind === 'pdf') {
      await pdfAttach(sessionId, base64)
    } else {
      await fileAttach(sessionId, `data:${file.mime};base64,${base64}`, file.name)
    }
  }

  return files.map(file => ({
    dataUrl: file.kind === 'image' ? file.uri : undefined,
    id: file.id,
    kind: file.kind,
    mime: file.mime,
    name: file.name,
    size: file.size
  }))
}

/** Android has no text prompt; a small sheet stands in for Alert.prompt. */
function RenameSheet({ initial, onClose, onSave, visible }: { initial: string; onClose: () => void; onSave: (title: string) => void; visible: boolean }) {
  const { colors } = useTheme()
  const [title, setTitle] = useState(initial)

  useEffect(() => setTitle(initial), [initial, visible])

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.scrim}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.bg }]}>
          <Text style={[styles.sheetTitle, { color: colors.text }]}>Rename section</Text>
          <TextInput
            autoFocus
            onChangeText={setTitle}
            onSubmitEditing={() => onSave(title)}
            selectTextOnFocus
            style={[styles.sheetField, { backgroundColor: colors.surface, color: colors.text }]}
            value={title}
          />
          <View style={styles.sheetButtons}>
            <Button onPress={onClose} variant="plain">
              Cancel
            </Button>
            <Button disabled={!title.trim()} onPress={() => onSave(title)}>
              Save
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/** Full-screen image from an attachment. */
function Lightbox({ onClose, uri }: { onClose: () => void; uri: null | string }) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={Boolean(uri)}>
      <Pressable accessibilityLabel="Close image" onPress={onClose} style={styles.lightbox}>
        {uri ? <RNImage resizeMode="contain" source={{ uri }} style={styles.lightboxImage} /> : null}
      </Pressable>
    </Modal>
  )
}

/**
 * A bot's section: the transcript scrolling under a transparent header and
 * a floating glass composer. The title pill names the bot and the section
 * and opens the bot; the toolbar starts a new section or opens the menu.
 */
export default function ChatScreen() {
  const { section: sectionId = '' } = useLocalSearchParams<{ section: string }>()
  const { colors } = useTheme()
  const headerHeight = useHeaderHeight()
  const section = useSection(sectionId)
  const bot = useBot(section?.bot ?? null)
  const liveId = useLiveSessionId(sectionId)
  const transcript = useTranscript(liveId)
  const connection = useConnection(state => state.status)
  const daemonId = useConnection(state => state.daemon?.install_id)
  const [unavailable, setUnavailable] = useState(false)
  const [composerHeight, setComposerHeight] = useState(70)
  const [renaming, setRenaming] = useState(false)
  const [lightbox, setLightbox] = useState<null | string>(null)
  const opened = useRef({ at: Date.now(), id: liveId })
  const listRef = useRef<ChatListHandle>(null)

  if (opened.current.id !== liveId) {
    opened.current = { at: Date.now(), id: liveId }
  }

  const hasTranscript = Boolean(transcript)
  const messages = transcript?.messages ?? NO_MESSAGES
  const streaming = Boolean(transcript?.streamingMessageId)
  const name = bot?.display_name ?? section?.bot ?? ''
  const status = sectionStatusOf(bot, sectionId, transcript && liveId ? liveSectionsOf({ [liveId]: transcript }) : {})
  const stopped = useMemo(() => stoppedCardFor(bot, sectionId, messages), [bot, messages, sectionId])
  const archived = Boolean(section?.archived_at)

  // Open lazily: on first show (the list may know the live id before this
  // phone holds its history), and again after a restarted daemon clears it.
  useEffect(() => {
    if (sectionId && !(liveId && hasTranscript) && !unavailable && connection === 'connected') {
      sectionsActions()
        .open(sectionId)
        .catch(() => {
          setUnavailable(true)
          uiActions().setLastSection(null)
        })
    }
  }, [connection, hasTranscript, liveId, sectionId, unavailable])

  // Connector tools read as their service ("Connecting to GitHub").
  useEffect(() => {
    if (section?.bot) {
      void connectorsActions().load(section.bot)
    }
  }, [section?.bot])

  // On screen: remembered, read, and quiet about itself.
  useFocusEffect(
    useCallback(() => {
      setFocusedSection(sectionId)

      return () => setFocusedSection(null)
    }, [sectionId])
  )

  useEffect(() => {
    if (section?.bot && sectionId) {
      uiActions().setLastSection({ bot: section.bot, daemon: daemonId, section: sectionId })
    }
  }, [daemonId, section?.bot, sectionId])

  useEffect(() => {
    if (sectionId && liveId && !streaming) {
      void sectionsMarkRead(sectionId).catch(() => undefined)
    }
  }, [liveId, sectionId, streaming])

  const rows = useMemo(
    () =>
      buildRows({
        approvals: transcript?.approvals ?? [],
        clarifies: transcript?.clarifies ?? [],
        messages,
        openedAt: opened.current.at,
        startedAt: section?.created_at,
        stopped
      }),
    [messages, section?.created_at, stopped, transcript?.approvals, transcript?.clarifies]
  )

  const send = async (text: string, files: StagedFile[] = []): Promise<boolean> => {
    if (!liveId || !section) {
      return false
    }

    let attachments: Attachment[] = []

    try {
      attachments = files.length ? await upload(liveId, files) : []
    } catch (error) {
      Alert.alert('Could not attach', error instanceof Error ? error.message : String(error))

      return false
    }

    const prompt = attachmentPrompt(text, files.length > 0)
    transcriptActions().appendUserMessage(liveId, prompt, attachments)
    sectionsActions().markTouched(section.id, prompt)
    listRef.current?.toEnd()
    void submitChatPrompt(liveId, section.id, prompt, files.length ? id => upload(id, files) : undefined).finally(() => void sectionsActions().settleTitle(section.id))

    return true
  }

  const retry = () => {
    const last = messages.findLast(message => message.role === 'user')

    if (liveId && last) {
      void submitChatPrompt(liveId, sectionId, last.text)
    }
  }

  const newSection = async () => {
    if (!section) {
      return
    }

    const fresh = await freshSection(section.bot)

    if (fresh.id !== sectionId) {
      openSection(fresh.id, 'replace')
    }
  }

  const rename = (title: string) => {
    setRenaming(false)

    if (section && title.trim() && title.trim() !== section.title) {
      void sectionsActions()
        .rename(section.id, title.trim())
        .catch(error => Alert.alert('Could not rename', String(error?.message ?? error)))
    }
  }

  const askRename = () => {
    if (Platform.OS === 'ios') {
      Alert.prompt('Rename section', undefined, [{ style: 'cancel', text: 'Cancel' }, { onPress: (value?: string) => rename(value ?? ''), text: 'Save' }], 'plain-text', section?.title ?? '')
    } else {
      setRenaming(true)
    }
  }

  const toggleArchive = () => {
    if (!section) {
      return
    }

    const action = archived ? sectionsActions().unarchive(section.id) : sectionsActions().archive(section.id)
    void action.catch(error => Alert.alert('Could not change the section', String(error?.message ?? error)))
  }

  const remove = () => {
    if (!section) {
      return
    }

    Alert.alert(`Delete “${section.title}”?`, 'Its history goes with it. What the bot remembers stays.', [
      { style: 'cancel', text: 'Cancel' },
      {
        onPress: () => {
          void sectionsActions()
            .remove(section.id)
            .then(() => {
              uiActions().setLastSection(null)
              router.back()
            })
            .catch(error => Alert.alert('Could not delete', String(error?.message ?? error)))
        },
        style: 'destructive',
        text: 'Delete'
      }
    ])
  }

  const fixConnector = () => {
    if (section) {
      router.push({ params: { name: section.bot, page: 'connectors' }, pathname: '/bot/[name]/[page]' })
    }
  }

  const subtitle = section?.title && section.title !== 'New section' && section.title !== name ? section.title : null
  const pinned = status === 'needs_you' || archived

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'separator':
        return <DaySeparator time={row.time} />
      case 'bubble':
        return (
          <Bubble
            attachments={row.attachments}
            fresh={row.fresh}
            onImage={setLightbox}
            onRetry={row.last && !streaming ? retry : undefined}
            side={row.side}
            testID={row.side === 'bot' ? 'bot-message' : 'user-message'}
            text={row.text}
          />
        )
      case 'marks':
        return <MemoryMarks message={row.message} />
      case 'summary':
        return <WorkSummary fresh={row.fresh} message={row.message} name={name} />
      case 'live':
        return <LiveStatus face={<WorkingFace bot={bot} name={section?.bot} size={26} />} message={row.message} name={name} />
      case 'approval':
        return <ApprovalCard approval={row.approval} />
      case 'clarify':
        return <ClarifyCard clarify={row.clarify} />
      case 'stopped':
        return <StoppedCard message={row.message} name={name || 'The bot'} onFix={fixConnector} onRetry={retry} />
    }
  }

  const loaded = Boolean(transcript)

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          headerShadowVisible: false,
          headerTitle: () => (
            <TitlePill
              face={<PillFace bot={bot} name={section?.bot ?? name} status={status} />}
              name={name}
              onPress={() => section && router.push({ params: { name: section.bot }, pathname: '/bot/[name]' })}
              subtitle={subtitle}
              testID="chat-title"
            />
          ),
          headerTitleAlign: 'center',
          headerTransparent: true,
          // The page draws its own fade under the header; the native edge effect would copy the transcript into it.
          scrollEdgeEffects: { bottom: 'hidden', top: 'hidden' },
          title: name
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="New section" disabled={!section} icon="square.and.pencil" onPress={() => void newSection()} />
        <Stack.Toolbar.Menu accessibilityLabel="Section actions" icon="ellipsis">
          <Stack.Toolbar.MenuAction
            icon="list.bullet"
            onPress={() => section && router.push({ params: { name: section.bot, page: 'sections' }, pathname: '/bot/[name]/[page]' })}
          >
            Sections
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={askRename}>
            Rename
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={archived ? 'tray.and.arrow.up' : 'archivebox'} onPress={toggleArchive}>
            {archived ? 'Unarchive' : 'Archive'}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction destructive icon="trash" onPress={remove}>
            Delete
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      {unavailable && !liveId ? (
        <View style={[styles.gone, { paddingTop: headerHeight }]}>
          <BotFace bot={bot} name={section?.bot ?? '?'} size={72} />
          <Text style={[styles.goneTitle, { color: colors.text }]}>This section is no longer here</Text>
          <Text style={[styles.goneLead, { color: colors.textMuted }]}>It may have been deleted, or it lives on another daemon.</Text>
          {section?.bot ? (
            <Button onPress={() => void newSection()} style={{ marginTop: 12 }}>
              Start a new section
            </Button>
          ) : null}
        </View>
      ) : (
        <ChatList
          composerHeight={composerHeight}
          empty={
            <View style={[styles.emptyWrap, { paddingTop: headerHeight }]}>
              {loaded ? <EmptySection bot={bot} name={name} onPrompt={prompt => void send(prompt)} /> : null}
            </View>
          }
          headerSpace={headerHeight + (pinned ? 46 : 0)}
          ref={listRef}
          renderRow={renderRow}
          rows={rows}
          testID="chat-list"
        />
      )}

      <EdgeFade edge="top" height={headerHeight + 28} solid={(headerHeight - 4) / (headerHeight + 28)} />
      <View pointerEvents="box-none" style={[styles.pinned, { top: headerHeight + 4 }]}>
        {status === 'needs_you' ? <PinnedPill icon="questionmark.circle" label="Waiting on you" testID="waiting-pill" tone={colors.accent} /> : null}
        {archived && status !== 'needs_you' ? (
          <PinnedPill action="Unarchive" icon="archivebox" label="Archived" onPress={toggleArchive} testID="archived-pill" />
        ) : null}
      </View>

      {unavailable && !liveId ? null : (
        <Composer
          canAttach
          disabled={!liveId}
          draftKey={sectionId}
          key={sectionId}
          notice={status === 'stopped' ? errorSentence(bot?.status_detail?.text ?? messages.findLast(message => message.error)?.error) || null : null}
          onHeight={setComposerHeight}
          onSend={send}
          onStop={() => liveId && void sessionInterrupt(liveId)}
          placeholder={`Message ${name || 'bot'}`}
          status={status}
          streaming={streaming}
        />
      )}
      {renaming ? <RenameSheet initial={section?.title ?? ''} onClose={() => setRenaming(false)} onSave={rename} visible /> : null}
      {lightbox ? <Lightbox onClose={() => setLightbox(null)} uri={lightbox} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  emptyWrap: { flex: 1 },
  gone: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', paddingHorizontal: 32 },
  goneLead: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  goneTitle: { fontSize: 20, fontWeight: '600', marginTop: 12, textAlign: 'center' },
  lightbox: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.94)', flex: 1, justifyContent: 'center' },
  lightboxImage: { height: '80%', width: '100%' },
  pinned: { left: 0, position: 'absolute', right: 0 },
  scrim: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'center', padding: 24 },
  screen: { flex: 1 },
  sheet: { borderRadius: 24, gap: 14, padding: 20 },
  sheetButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  sheetField: { borderRadius: 12, fontSize: 17, paddingHorizontal: 14, paddingVertical: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '600' }
})
