import { Ionicons } from '@expo/vector-icons'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  View
} from 'react-native'

import { type OpenedFile, type Preview, previewOf, TABLE_COLUMNS } from '../core/files'
import { fileCopy, mediaUri } from '../core/media'
import { MarkdownText } from '../MarkdownText'
import { PdfFrame } from '../PdfFrame'
import { Layer, mono, Text, useTheme, withAlpha } from '../ui'
import { MediaAttachment } from './MediaAttachment'
import type { AttachmentView } from './types'

/** The share sheet takes files on iOS; Android's takes only text, and the web has none. */
const SHARES_FILES = Platform.OS === 'ios'
/** Android's WebView does not draw PDFs. */
const SHOWS_PDF = Platform.OS !== 'android'

/**
 * A file from the chat on its own card, as the desktop opens it beside the
 * chat: a CSV or TSV as a table, Markdown formatted, other text as it is, a
 * picture, video, audio file or PDF shown or played. Anything else says it
 * has no preview. On iPhone, Share saves or sends the file.
 */
export function FileSheet({
  botName,
  file,
  onClose,
  read
}: {
  botName: string
  /** The file to show; null closes the card. */
  file: AttachmentView | null
  onClose: () => void
  read: (path: string) => Promise<OpenedFile>
}) {
  const theme = useTheme()
  // The card slides away showing the file it had.
  const [shown, setShown] = useState(file)
  useEffect(() => {
    if (file) setShown(file)
  }, [file])
  const [opened, setOpened] = useState<{ id: string; file?: OpenedFile; error?: string }>()
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (!file?.path) return
    let live = true
    setOpened({ id: file.id })
    read(file.path).then(
      next => live && setOpened({ id: file.id, file: next }),
      (e: unknown) =>
        live && setOpened({ id: file.id, error: e instanceof Error ? e.message : String(e) })
    )
    return () => {
      live = false
    }
  }, [file?.id, file?.path, read])

  const current = opened?.id === shown?.id ? opened : undefined
  const preview = useMemo(() => (current?.file ? previewOf(current.file) : null), [current?.file])
  const share = async () => {
    if (!current?.file) return
    setSharing(true)
    try {
      // Under the name the card shows, not the daemon's stored name.
      const copy = await fileCopy({ ...current.file, name: shown?.name ?? current.file.name })
      await Share.share({ url: copy.uri })
    } catch {
      // Closing the share sheet, or a copy the phone cannot make, leaves the card as it was.
    } finally {
      setSharing(false)
    }
  }

  return (
    <Layer
      action={
        SHARES_FILES && current?.file
          ? { busy: sharing, label: 'Share', onPress: () => void share() }
          : undefined
      }
      onClose={onClose}
      scroll={preview?.kind !== 'pdf'}
      testID="file-sheet"
      title={shown?.name ?? 'File'}
      visible={!!file}
    >
      {!shown ? null : current?.error ? (
        <View
          accessibilityRole="alert"
          style={[styles.message, { backgroundColor: withAlpha(theme.danger, 0.1) }]}
        >
          <Text tone="danger" variant="callout">
            {current.error}
          </Text>
        </View>
      ) : !current?.file || !preview ? (
        <View style={styles.opening} testID="file-opening">
          <ActivityIndicator />
          <Text tone="muted" variant="footnote">
            Opening {shown.name}…
          </Text>
        </View>
      ) : (
        <PreviewBody botName={botName} file={current.file} id={shown.id} preview={preview} />
      )}
    </Layer>
  )
}

function PreviewBody({
  botName,
  file,
  id,
  preview
}: {
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
        <View style={[styles.page, { backgroundColor: theme.surface }]} testID="file-markdown">
          <MarkdownText text={preview.text} />
        </View>
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
        <Media botName={botName} file={file} id={id} kind={preview.kind} />
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
  kind
}: {
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
    mediaUri(`preview:${id}:${file.version ?? ''}`, async () => file).then(
      next => live && setUri(next),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [file, id])
  if (failed) return <NoPreview botName={botName} />
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
      card={null}
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
  cell: { paddingHorizontal: 10, paddingVertical: 9 },
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
