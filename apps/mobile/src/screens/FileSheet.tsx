import { Ionicons } from '@expo/vector-icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  View
} from 'react-native'

import type { FileComment } from '../../../web/src/lib/file-comments'
import {
  asSaved,
  editorOf,
  saveFailure,
  type SavedContents,
  savesPicture
} from '../core/file-edit'
import { type OpenedFile, type Preview, previewOf, TABLE_COLUMNS } from '../core/files'
import { fileCopy, mediaUri } from '../core/media'
import { MarkdownText } from '../MarkdownText'
import { PdfFrame } from '../PdfFrame'
import { Button, confirm, Layer, mono, Text, useTheme, withAlpha } from '../ui'
import {
  type CommentAsk,
  CommentBar,
  EDIT_CHARS,
  type EditorHandle,
  TableEditor,
  TextEditor,
  type WriteFile
} from './FileEditors'
import { ImageMarkup } from './ImageMarkup'
import { MediaAttachment } from './MediaAttachment'
import type { AttachmentView } from './types'

/** The share sheet takes files on iOS; Android's takes only text, and the web has none. */
const SHARES_FILES = Platform.OS === 'ios'
/** Android's WebView does not draw PDFs. */
const SHOWS_PDF = Platform.OS !== 'android'

/** Writes a file through the chat: `hexbot.files.write`, answering the file's new version. */
export type WriteThrough = (
  path: string,
  contents: { text: string } | { data_url: string },
  version: string | undefined
) => Promise<{ version: string }>

/**
 * A file from the chat on its own card, in front of the chat, as the desktop
 * opens it beside the chat. Text, Markdown, CSV and TSV are edited in place
 * and pictures marked up; Save, or closing the card, writes the edit back.
 * Selecting words, cells or an area of a picture offers Comment: the comment
 * waits above the composer and goes with the next message. A PDF, video or
 * audio file is shown or played, and Word, Excel and PowerPoint files say
 * they have no preview. On iPhone, Share saves or sends the file.
 */
export function FileSheet({
  botName,
  comments = [],
  file,
  onAddImage,
  onClose,
  onComment,
  read,
  write
}: {
  botName: string
  /** The file to show; null closes the card. */
  file: AttachmentView | null
  onClose: () => void
  /** `stream` asks for a link the player streams instead of the bytes. */
  read: (path: string, stream?: boolean) => Promise<OpenedFile>
  /** Absent where files can't be saved, as in a room. */
  write?: WriteThrough
  /** Comments waiting above the composer; a picture's are outlined on it. */
  comments?: FileComment[]
  /** Absent where the chat takes no messages. */
  onComment?: (comment: Omit<FileComment, 'id'>) => void
  /** Adds a marked-up picture to the composer. */
  onAddImage?: (dataUrl: string, name: string) => void
}) {
  const theme = useTheme()
  // The card slides away showing the file it had.
  const [shown, setShown] = useState(file)
  useEffect(() => {
    if (file) setShown(file)
  }, [file])
  const [opened, setOpened] = useState<{ id: string; file?: OpenedFile; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const reload = () => setAttempt(n => n + 1)
  const [sharing, setSharing] = useState(false)
  // Bumped to read the file again, as "Load {bot}'s version" does.
  const [edition, setEdition] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [asking, setAsking] = useState<CommentAsk | null>(null)
  const handle = useRef<EditorHandle | null>(null)
  const version = useRef<string | undefined>(undefined)
  // What the last save wrote, so Share sends the file as it is now.
  const saved = useRef<SavedContents | null>(null)
  // The editor holds an edit not written yet, as the closing save reads it.
  const edited = useRef(false)

  // The file and read that opened the card; another read alone means the chat reconnected.
  const opening = useRef('')
  // The last read failed, as one does while the chat is away.
  const readFailed = useRef(false)

  useEffect(() => {
    const key = JSON.stringify([attempt, edition, file?.id, file?.path])
    const reconnected = opening.current === key
    opening.current = key
    // A reconnect reads again only for a fresh stream link (video, audio) or after a
    // failed read; a file read whole stays as it is, with any edit or comment under way.
    const streamed = file?.kind === 'video' || file?.kind === 'audio'
    if (reconnected && (edited.current || (!streamed && !readFailed.current))) return
    setDirty(false)
    edited.current = false
    setConflict(false)
    setSaveError('')
    setAsking(null)
    handle.current = null
    saved.current = null
    if (file?.local) {
      setOpened({ id: file.id, file: file.local })
      return
    }
    if (!file?.path) return
    let live = true
    setOpened({ id: file.id })
    // Video and audio stream; a picture comes whole, to be marked up and saved.
    read(file.path, file.kind === 'video' || file.kind === 'audio').then(
      next => {
        if (!live) return
        readFailed.current = false
        version.current = next.version
        setOpened({ id: file.id, file: next })
      },
      (e: unknown) => {
        if (!live) return
        readFailed.current = true
        setOpened({ id: file.id, error: e instanceof Error ? e.message : String(e) })
      }
    )
    return () => {
      live = false
    }
  }, [attempt, edition, file?.id, file?.kind, file?.local, file?.path, read])

  const current = opened?.id === shown?.id ? opened : undefined
  const preview = useMemo(() => (current?.file ? previewOf(current.file) : null), [current?.file])
  const editor = useMemo(() => {
    const kind = current?.file ? editorOf(current.file) : null
    // A text longer than the phone edits shows its start, as before.
    return kind && kind !== 'image' && (current?.file?.text?.length ?? 0) > EDIT_CHARS ? null : kind
  }, [current?.file])
  const path = shown?.local ? undefined : shown?.path

  const writeFile: WriteFile | undefined =
    // A GIF or other picture the daemon won't take back is marked up only to send.
    write && path && (editor !== 'image' || savesPicture(current?.file?.mime ?? ''))
      ? async contents => {
          try {
            const reply = await write(path, contents, version.current)
            version.current = reply.version
            saved.current = contents
            setConflict(false)
            setSaveError('')
            return true
          } catch (e) {
            const failure = saveFailure(e)
            setConflict(failure.conflict)
            setSaveError(failure.message)
            return false
          }
        }
      : undefined

  // One save at a time: a second one waits, then writes only what is newer.
  const writing = useRef<Promise<boolean> | null>(null)
  const save = async (): Promise<boolean> => {
    while (writing.current) await writing.current.catch(() => false)
    setSaving(true)
    const run = (async () => (await handle.current?.save()) ?? true)()
    writing.current = run
    try {
      return await run
    } finally {
      writing.current = null
      setSaving(false)
    }
  }

  // An edit is written back as the card closes; one that was refused keeps it open.
  const close = () => {
    if (!dirty || !writeFile) return onClose()
    void (async () => {
      // An edit made while the closing save wrote is saved too before the card goes;
      // one that keeps coming, or a refused save, keeps it open.
      for (let round = 0; round < 3; round++) {
        if (!(await save())) return
        if (!edited.current) return onClose()
      }
    })()
  }

  const discard = () =>
    confirm('Discard edit', `Your change to ${shown?.name ?? 'this file'} is not saved.`, onClose)

  const share = async () => {
    if (!current?.file) return
    setSharing(true)
    try {
      // Under the name the card shows, not the daemon's stored name.
      const file = asSaved(current.file, saved.current)
      const copy = await fileCopy({ ...file, name: shown?.name ?? file.name })
      await Share.share({ url: copy.uri })
    } catch {
      // Closing the share sheet, or a copy the phone cannot make, leaves the card as it was.
    } finally {
      setSharing(false)
    }
  }

  const comment = useCallback(
    (ask: CommentAsk) => (onComment ? setAsking(ask) : undefined),
    [onComment]
  )
  const onDirty = useCallback((next: boolean) => {
    edited.current = next
    setDirty(next)
  }, [])
  const editorProps = {
    handle,
    onComment: onComment ? comment : undefined,
    onDirty,
    write: writeFile
  }
  const areas = comments
    .filter(item => item.area && item.name === shown?.name && item.path === path)
    .map(item => item.area!)

  return (
    <Layer
      action={
        dirty && writeFile
          ? { busy: saving, busyLabel: 'Saving', label: 'Save', onPress: () => void save() }
          : SHARES_FILES && current?.file
            ? { busy: sharing, label: 'Share', onPress: () => void share() }
            : undefined
      }
      onClose={close}
      scroll={!editor && preview?.kind !== 'pdf'}
      testID="file-sheet"
      title={shown?.name ?? 'File'}
      visible={!!file}
    >
      {conflict || saveError ? (
        <View
          accessibilityRole="alert"
          style={[styles.banner, { backgroundColor: withAlpha(conflict ? theme.warning : theme.danger, 0.12) }]}
          testID="file-save-problem"
        >
          <Text variant="footnote">
            {conflict
              ? `${botName} changed this file since it opened. Your edit is not saved.`
              : `Not saved: ${saveError}`}
          </Text>
          <View style={styles.bannerActions}>
            <Button label="Discard edit" onPress={discard} size="small" testID="file-discard" variant="plain" />
            {conflict ? (
              <Button
                label={`Load ${botName}’s version`}
                onPress={() => setEdition(n => n + 1)}
                size="small"
                testID="file-load-theirs"
                variant="secondary"
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {!shown ? null : current?.error ? (
        <View
          accessibilityRole="alert"
          style={[styles.message, { backgroundColor: withAlpha(theme.danger, 0.1) }]}
        >
          <Text tone="danger" variant="callout">
            {current.error}
          </Text>
          <Button testID="file-reload" label={`Reload ${shown.name}`} onPress={reload} variant="secondary" />
        </View>
      ) : !current?.file || !preview ? (
        <View style={styles.opening} testID="file-opening">
          <ActivityIndicator />
          <Text tone="muted" variant="footnote">
            Opening {shown.name}…
          </Text>
        </View>
      ) : editor === 'image' && current.file.data_url ? (
        <ImageMarkup
          {...editorProps}
          asking={!!asking}
          botName={botName}
          comments={areas}
          file={{ ...current.file, data_url: current.file.data_url }}
          key={`${shown.id}:${edition}`}
          onAdd={onAddImage}
          pictureKey={`${shown.id}:${current.file.version ?? ''}:${edition}`}
        />
      ) : editor === 'table' && current.file.text !== undefined ? (
        <TableEditor
          {...editorProps}
          key={`${shown.id}:${edition}`}
          name={shown.name}
          text={current.file.text}
        />
      ) : (editor === 'text' || editor === 'markdown') && current.file.text !== undefined ? (
        <TextEditor
          {...editorProps}
          key={`${shown.id}:${edition}`}
          markdown={editor === 'markdown'}
          text={current.file.text}
        />
      ) : (
        <PreviewBody botName={botName} file={current.file} id={shown.id} preview={preview} onReload={reload} />
      )}
      {asking && onComment && shown ? (
        <View style={styles.commentBar}>
          <CommentBar
            ask={asking}
            botName={botName}
            onAdd={note => {
              onComment({
                area: asking.area,
                name: shown.name,
                note,
                path,
                quote: asking.quote,
                where: asking.where
              })
              setAsking(null)
            }}
            onCancel={() => setAsking(null)}
          />
        </View>
      ) : null}
    </Layer>
  )
}

function PreviewBody({
  botName,
  file,
  id,
  preview,
  onReload
}: {
  onReload: () => void
  botName: string
  file: OpenedFile
  id: string
  preview: Preview
}) {
  const theme = useTheme()
  switch (preview.kind) {
    case 'table':
      return (
        <>
          <Table rows={preview.rows} />
          {preview.rows.length < preview.total || preview.columns > TABLE_COLUMNS ? (
            <Text style={styles.more} tone="muted" variant="footnote">
              Showing {preview.rows.length} of {preview.total} rows and{' '}
              {Math.min(preview.columns, TABLE_COLUMNS)} of {preview.columns} columns. {botName}{' '}
              can read all of it.
            </Text>
          ) : null}
        </>
      )
    case 'markdown':
      return (
        <>
          <View style={[styles.page, { backgroundColor: theme.surface }]} testID="file-markdown">
            <MarkdownText text={preview.text} />
          </View>
          {preview.more ? (
            <Text style={styles.more} tone="muted" variant="footnote">
              Showing the start of the file. {botName} can read all of it.
            </Text>
          ) : null}
        </>
      )
    case 'text':
      return (
        <>
          <View style={[styles.page, { backgroundColor: theme.surface }]} testID="file-text">
            <Text selectable style={styles.code} variant="footnote">
              {preview.text}
            </Text>
          </View>
          {preview.more ? (
            <Text style={styles.more} tone="muted" variant="footnote">
              Showing the start of the file. {botName} can read all of it.
            </Text>
          ) : null}
        </>
      )
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
      return preview.kind === 'pdf' && !SHOWS_PDF ? (
        <NoPreview botName={botName} />
      ) : (
        <Media botName={botName} file={file} id={id} kind={preview.kind} onReload={onReload} />
      )
    case 'none':
      return <NoPreview botName={botName} />
  }
}

/** A picture, video, audio file or PDF, played from the phone's own copy. */
function Media({
  botName,
  file,
  id,
  kind,
  onReload
}: {
  onReload: () => void
  botName: string
  file: OpenedFile
  id: string
  kind: 'audio' | 'image' | 'pdf' | 'video'
}) {
  const theme = useTheme()
  const [uri, setUri] = useState<string>()
  const [ratio, setRatio] = useState(1)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    // Keyed by contents too, so a file changed since it was last opened shows as it is now.
    setFailed(false)
    mediaUri(`preview:${id}:${file.version ?? ''}`, async () => file).then(
      next => live && setUri(next),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [file, id])
  if (failed) return file.mediaUrl
    ? <Button testID="file-reload" label={`Reload ${file.name}`} onPress={onReload} variant="secondary" />
    : <NoPreview botName={botName} />
  if (!uri) return <ActivityIndicator style={styles.opening} />
  if (kind === 'pdf')
    return (
      <View style={[styles.pdf, { backgroundColor: theme.surface }]}>
        <PdfFrame title={file.name} uri={uri} />
      </View>
    )
  if (kind === 'image')
    return (
      <Image
        accessibilityLabel={file.name}
        onError={() => setFailed(true)}
        onLoad={e => {
          const { width, height } = e.nativeEvent.source
          if (width && height) setRatio(width / height)
        }}
        resizeMode="contain"
        source={{ uri }}
        style={[styles.image, { aspectRatio: ratio, backgroundColor: theme.fill }]}
        testID="file-image"
      />
    )
  return (
    <MediaAttachment
      card={<NoPreview botName={botName} />}
      onReload={file.mediaUrl ? onReload : undefined}
      file={{ id, kind, name: file.name, uri }}
    />
  )
}

function NoPreview({ botName }: { botName: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.none, { backgroundColor: theme.surface }]} testID="file-no-preview">
      <Ionicons color={theme.muted} name="document-text-outline" size={24} />
      <Text align="center" tone="muted" variant="callout">
        No preview for this file. {botName} can still read it.
        {SHARES_FILES ? ' Share saves or sends it.' : ''}
      </Text>
    </View>
  )
}

/** Characters' width in a cell, as a column's width; long values wrap inside it. */
const columnWidth = (cells: string[]) =>
  Math.round(Math.min(220, Math.max(56, Math.max(...cells.map(c => c.length)) * 7.5 + 24)))

/** A CSV or TSV file's rows; the first is the header. Wide tables scroll sideways. */
function Table({ rows }: { rows: string[][] }) {
  const theme = useTheme()
  const columns = Math.max(...rows.map(row => row.length))
  const widths = Array.from({ length: columns }, (_, i) =>
    columnWidth(rows.slice(0, 200).map(row => row[i] ?? ''))
  )
  return (
    <View style={[styles.table, { backgroundColor: theme.surface }]} testID="file-table">
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {rows.map((row, r) => (
            <View
              key={r}
              style={[
                styles.row,
                r > 0 && { borderTopColor: theme.hairline, borderTopWidth: StyleSheet.hairlineWidth },
                r === 0 && { backgroundColor: theme.fill }
              ]}
            >
              {widths.map((width, c) => (
                <Text
                  key={c}
                  selectable
                  style={[styles.cell, { width }]}
                  tone={r === 0 ? 'muted' : 'text'}
                  variant={r === 0 ? 'caption' : 'footnote'}
                >
                  {row[c] ?? ''}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: { borderRadius: 14, gap: 6, marginBottom: 10, marginHorizontal: 12, padding: 12 },
  bannerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  cell: { paddingHorizontal: 10, paddingVertical: 9 },
  commentBar: { bottom: 0, left: 0, position: 'absolute', right: 0 },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 18 },
  image: { borderRadius: 16, width: '100%' },
  message: { borderRadius: 14, padding: 14 },
  more: { marginTop: 10, paddingHorizontal: 4 },
  none: { alignItems: 'center', borderRadius: 16, gap: 10, paddingHorizontal: 20, paddingVertical: 36 },
  opening: { alignItems: 'center', gap: 10, paddingVertical: 48 },
  page: { borderRadius: 16, padding: 16 },
  pdf: { borderRadius: 16, flex: 1, marginBottom: 12, marginHorizontal: 12, overflow: 'hidden' },
  row: { flexDirection: 'row' },
  table: { borderRadius: 16, overflow: 'hidden' }
})
