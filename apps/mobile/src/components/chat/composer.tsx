/**
 * The floating glass composer: a round "+" on the left (photos and files,
 * staged as chips above the field), the field growing to six lines, and a
 * round send arrow that becomes Stop while a turn runs. It rides the
 * keyboard; the transcript scrolls under it. The pill takes the status
 * colour (accent when the bot waits on you, red when it stopped).
 */

import * as DocumentPicker from 'expo-document-picker'
import * as Haptics from 'expo-haptics'
import { Image } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import { type ReactNode, useState } from 'react'
import { ActionSheetIOS, ActivityIndicator, Alert, type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { KeyboardStickyView } from 'react-native-keyboard-controller'
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { attachmentKind } from '../../lib/api'
import type { AttachmentKind, BotStatus } from '../../lib/types'
import { draftsActions } from '../../stores/drafts'
import { useTheme } from '../../theme'
import { Glass } from '../glass'
import { Icon } from '../icon'

import { fileIcon } from './attachments'

/** A picked file waiting for the next send. */
export interface StagedFile {
  id: string
  kind: AttachmentKind
  mime: string
  name: string
  size: number
  uri: string
}

const LINE = 22
const MAX_LINES = 6
const MIN_FIELD = 34
const MAX_FIELD = LINE * MAX_LINES + 13

/** How far the composer sits above the screen's bottom edge with the keyboard down. */
export function useComposerInset(): number {
  const insets = useSafeAreaInsets()

  return insets.bottom > 0 ? Math.max(8, insets.bottom - 8) : 12
}

let fileCounter = 0

async function pickPhotos(): Promise<StagedFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsMultipleSelection: true,
    mediaTypes: ['images'],
    quality: 0.85,
    selectionLimit: 6
  })

  if (result.canceled) {
    return []
  }

  return result.assets.map(asset => {
    const mime = asset.mimeType ?? 'image/jpeg'
    const name = asset.fileName ?? `Photo ${++fileCounter}.${mime.split('/')[1] ?? 'jpg'}`

    return { id: `${asset.uri}-${++fileCounter}`, kind: 'image', mime, name, size: asset.fileSize ?? 0, uri: asset.uri }
  })
}

async function pickFiles(): Promise<StagedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true })

  if (result.canceled) {
    return []
  }

  return result.assets.map(asset => {
    const mime = asset.mimeType ?? 'application/octet-stream'

    return { id: `${asset.uri}-${++fileCounter}`, kind: attachmentKind(mime, asset.name), mime, name: asset.name, size: asset.size ?? 0, uri: asset.uri }
  })
}

function chooseSource(): Promise<'files' | 'photos' | null> {
  return new Promise(resolve => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ cancelButtonIndex: 2, options: ['Photo library', 'Files', 'Cancel'] }, index =>
        resolve(index === 0 ? 'photos' : index === 1 ? 'files' : null)
      )
    } else {
      Alert.alert('Attach', undefined, [
        { onPress: () => resolve('photos'), text: 'Photo library' },
        { onPress: () => resolve('files'), text: 'Files' },
        { onPress: () => resolve(null), style: 'cancel', text: 'Cancel' }
      ])
    }
  })
}

export interface ComposerProps {
  /** Something floating just above the pill, such as the @-mention list. */
  above?: ReactNode
  /** Photos and files; rooms send text only. */
  canAttach?: boolean
  disabled?: boolean
  /** Key for the persisted draft. */
  draftKey: string
  /** One line above the pill, in the status colour (a stopped bot's error). */
  notice?: null | string
  onHeight?: (height: number) => void
  /** Resolves true once sent; the field and chips then clear. */
  onSend: (text: string, files: StagedFile[]) => Promise<boolean>
  onStop?: () => void
  onTextChange?: (text: string) => void
  placeholder: string
  status?: BotStatus
  streaming: boolean
  /** Replaces the field's text from outside, such as a picked mention. */
  text?: string
}

export function Composer({
  above,
  canAttach = false,
  disabled = false,
  draftKey,
  notice,
  onHeight,
  onSend,
  onStop,
  onTextChange,
  placeholder,
  status = 'idle',
  streaming,
  text: controlled
}: ComposerProps) {
  const { colors } = useTheme()
  const inset = useComposerInset()
  const [own, setOwn] = useState(() => draftsActions().byId[draftKey] ?? '')
  const [files, setFiles] = useState<StagedFile[]>([])
  const [sending, setSending] = useState(false)
  const text = controlled ?? own

  const tone = status === 'needs_you' ? colors.accent : status === 'stopped' ? colors.danger : null
  const canSend = !disabled && !sending && (Boolean(text.trim()) || files.length > 0)

  const change = (value: string) => {
    setOwn(value)
    onTextChange?.(value)
    draftsActions().set(draftKey, value)
  }

  const send = async () => {
    if (!canSend) {
      return
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    setSending(true)

    try {
      if (await onSend(text.trim(), files)) {
        change('')
        setFiles([])
        draftsActions().clear(draftKey)
      }
    } finally {
      setSending(false)
    }
  }

  const attach = async () => {
    const source = await chooseSource()
    const picked = source === 'photos' ? await pickPhotos() : source === 'files' ? await pickFiles() : []

    if (picked.length) {
      setFiles(current => [...current, ...picked])
    }
  }

  return (
    <KeyboardStickyView offset={{ closed: 0, opened: inset - 8 }} style={styles.sticky}>
      <View
        onLayout={(event: LayoutChangeEvent) => onHeight?.(event.nativeEvent.layout.height)}
        pointerEvents="box-none"
        style={[styles.wrap, { paddingBottom: inset }]}
      >
        {above}
        {notice ? (
          <Animated.View entering={ZoomIn.duration(180)} exiting={ZoomOut.duration(140)} style={styles.noticeWrap}>
            <Glass style={styles.notice}>
              <View style={[styles.noticeDot, { backgroundColor: tone ?? colors.textMuted }]} />
              <Text numberOfLines={1} style={[styles.noticeText, { color: tone ?? colors.textMuted }]}>
                {notice}
              </Text>
            </Glass>
          </Animated.View>
        ) : null}
        {files.length ? (
          <View style={styles.chips}>
            {files.map(file => (
              <Glass key={file.id} style={styles.chip}>
                {file.kind === 'image' ? (
                  <Image source={{ uri: file.uri }} style={styles.thumb} />
                ) : (
                  <Icon color={colors.text} name={fileIcon(file.kind)} size={14} />
                )}
                <Text numberOfLines={1} style={[styles.chipText, { color: colors.text }]}>
                  {file.name}
                </Text>
                <Pressable
                  accessibilityLabel={`Remove ${file.name}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setFiles(current => current.filter(item => item.id !== file.id))}
                  style={[styles.chipRemove, { backgroundColor: colors.surface2 }]}
                >
                  <Icon color={colors.textMuted} name="xmark" size={9} weight="bold" />
                </Pressable>
              </Glass>
            ))}
          </View>
        ) : null}
        <Glass interactive style={styles.pill}>
          {tone ? <View pointerEvents="none" style={[styles.ring, { borderColor: tone }]} /> : null}
          {canAttach ? (
            <Pressable
              accessibilityLabel="Attach photos or files"
              accessibilityRole="button"
              disabled={disabled}
              hitSlop={6}
              onPress={() => void attach()}
              style={({ pressed }) => [styles.round, { backgroundColor: colors.hairline, opacity: pressed ? 0.6 : 1 }]}
              testID="composer-attach"
            >
              <Icon color={colors.text} name="plus" size={16} weight="semibold" />
            </Pressable>
          ) : (
            <View style={styles.gap} />
          )}
          <TextInput
            accessibilityLabel="Message"
            editable={!disabled}
            multiline
            onChangeText={change}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            style={[styles.field, { color: colors.text }]}
            testID="composer-input"
            value={text}
          />
          {streaming ? (
            <Pressable
              accessibilityLabel="Stop"
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
                onStop?.()
              }}
              style={({ pressed }) => [styles.round, { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 }]}
              testID="composer-stop"
            >
              <View style={[styles.stop, { backgroundColor: colors.primaryText }]} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel="Send"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              hitSlop={6}
              onPress={() => void send()}
              style={({ pressed }) => [styles.round, { backgroundColor: canSend ? colors.primary : colors.hairline, opacity: pressed ? 0.7 : 1 }]}
              testID="composer-send"
            >
              {sending ? (
                <ActivityIndicator color={colors.primaryText} size="small" />
              ) : (
                <Icon color={canSend ? colors.primaryText : colors.textFaint} name="arrow.up" size={15} weight="bold" />
              )}
            </Pressable>
          )}
        </Glass>
      </View>
    </KeyboardStickyView>
  )
}

const styles = StyleSheet.create({
  chip: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 7, maxWidth: 220, overflow: 'hidden', paddingLeft: 6, paddingRight: 6, paddingVertical: 5 },
  chipRemove: { alignItems: 'center', borderRadius: 9, height: 18, justifyContent: 'center', width: 18 },
  chipText: { flexShrink: 1, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  field: {
    flex: 1,
    fontSize: 17,
    lineHeight: LINE,
    maxHeight: MAX_FIELD,
    minHeight: MIN_FIELD,
    paddingBottom: 6,
    paddingHorizontal: 6,
    paddingTop: Platform.OS === 'ios' ? 7 : 6
  },
  gap: { width: 8 },
  notice: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 8, maxWidth: '100%', overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 7 },
  noticeDot: { borderRadius: 4, height: 8, width: 8 },
  noticeText: { flexShrink: 1, fontSize: 14, fontWeight: '500' },
  noticeWrap: { alignItems: 'center', marginBottom: 8 },
  pill: { alignItems: 'flex-end', borderRadius: 24, flexDirection: 'row', minHeight: 48, overflow: 'hidden', padding: 7 },
  ring: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0, borderRadius: 24, borderWidth: 1.5, opacity: 0.75 },
  round: { alignItems: 'center', borderRadius: 17, height: 34, justifyContent: 'center', width: 34 },
  sticky: { bottom: 0, left: 0, position: 'absolute', right: 0 },
  stop: { borderRadius: 3, height: 11, width: 11 },
  thumb: { borderRadius: 999, height: 22, width: 22 },
  wrap: { paddingHorizontal: 12 }
})
