import { Ionicons } from '@expo/vector-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { areaWhere } from '../../../web/src/lib/file-comments'
import { type Area, type Mark, moved, nextStep, type Tool } from '../../../web/src/lib/markup'
import {
  cropWithin,
  freshSteps,
  markSizes,
  pictureMime,
  pictureName,
  redo,
  step,
  undo
} from '../core/file-edit'
import type { OpenedFile } from '../core/files'
import MarkupCanvas from '../MarkupCanvas'
import { Button, type IconName, IconButton, Text, useTheme, withAlpha } from '../ui'
import type { EditorProps } from './FileEditors'

/** The desktop's seven colours. */
const COLORS = [
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Black', value: '#111111' },
  { label: 'White', value: '#ffffff' }
]

const TOOLS: { tool: Tool; label: string; icon?: IconName }[] = [
  { icon: 'hand-left-outline', label: 'Move', tool: 'select' },
  { icon: 'pencil', label: 'Pen', tool: 'pen' },
  { icon: 'brush-outline', label: 'Highlighter', tool: 'highlighter' },
  { icon: 'arrow-forward', label: 'Arrow', tool: 'arrow' },
  { icon: 'remove', label: 'Line', tool: 'line' },
  { icon: 'square-outline', label: 'Rectangle', tool: 'rect' },
  { icon: 'ellipse-outline', label: 'Ellipse', tool: 'ellipse' },
  { icon: 'text-outline', label: 'Text', tool: 'text' },
  { label: 'Numbered step', tool: 'step' },
  { icon: 'grid-outline', label: 'Pixelate', tool: 'pixelate' },
  { icon: 'crop-outline', label: 'Crop', tool: 'crop' }
]

const COMMENT: (typeof TOOLS)[number] = {
  icon: 'chatbox-ellipses-outline',
  label: 'Comment',
  tool: 'comment'
}

/**
 * A picture on the phone's file card, marked up as the desktop does it: move,
 * pen, highlighter, arrow, line, rectangle, ellipse, text, numbered steps,
 * pixelate and crop, seven colours, three sizes, undo and redo. Save in the
 * card's corner writes it back over a PNG, JPEG or WebP file; Add to message
 * puts it, as marked up, in the composer. Comment marks an area for the bot.
 */
export function ImageMarkup({
  asking,
  botName,
  comments,
  file,
  handle,
  onAdd,
  onComment,
  onDirty,
  pictureKey,
  write
}: EditorProps & {
  /** A comment's note is being written. */
  asking: boolean
  botName: string
  /** Areas of comments waiting on this picture. */
  comments: Area[]
  file: OpenedFile & { data_url: string }
  /** Adds the picture, as marked up, to the chat's next message. */
  onAdd?: (dataUrl: string, name: string) => void
  pictureKey: string
}) {
  const theme = useTheme()
  const [steps, setSteps] = useState(freshSteps)
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState(COLORS[0]!.value)
  const [size, setSize] = useState(1)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // A crop or comment area dragged out, waiting for Crop or the comment.
  const [pending, setPending] = useState<Area | null>(null)
  const [typing, setTyping] = useState<{ x: number; y: number } | null>(null)
  const [typed, setTyped] = useState('')
  const [added, setAdded] = useState(false)
  const [exportId, setExportId] = useState(0)
  const exports = useRef(new Map<number, (url: string) => void>())
  const asked = useRef(0)
  const saved = useRef(steps.now)
  const latest = useRef(steps)
  latest.current = steps
  const sizes = markSizes(natural?.w ?? 800, natural?.h ?? 800, size)
  const mime = pictureMime(file.mime)

  useEffect(() => onDirty(steps.now !== saved.current), [onDirty, steps.now])

  // The comment's note was added or let go: its area no longer waits.
  useEffect(() => {
    if (!asking) setPending(current => (tool === 'comment' ? null : current))
  }, [asking, tool])

  /** The picture as marked up now, as a data URL of its own format (or PNG). */
  const exportNow = useCallback(
    () =>
      new Promise<string>(resolve => {
        const id = ++asked.current
        exports.current.set(id, resolve)
        setExportId(id)
      }),
    []
  )

  handle.current = {
    save: async () => {
      const now = latest.current.now
      if (now === saved.current) return true
      if (!write || !(await write({ data_url: await exportNow() }))) return false
      saved.current = now
      onDirty(latest.current.now !== now)
      return true
    }
  }

  const commit = (next: typeof steps.now) => setSteps(current => step(current, next))
  const now = steps.now

  const pickTool = (next: Tool) => {
    setTool(next)
    setSelected(null)
    setPending(null)
    setTyping(null)
  }

  const addText = () => {
    const text = typed.trim()
    if (typing && text) {
      commit({
        ...now,
        marks: [
          ...now.marks,
          {
            color,
            id: `phone-text-${Date.now().toString(36)}`,
            kind: 'text',
            size: sizes.text,
            text,
            x: typing.x,
            y: typing.y
          }
        ]
      })
    }
    setTyping(null)
    setTyped('')
  }

  const applyCrop = () => {
    const crop = pending && natural ? cropWithin(pending, natural.w, natural.h) : null
    if (crop) commit({ ...now, crop })
    setPending(null)
    setTool('arrow')
  }

  const tools = onComment ? [...TOOLS, COMMENT] : TOOLS
  return (
    <View style={styles.fill}>
      <View style={[styles.canvas, { backgroundColor: theme.fill }]}>
        {failed ? (
          <Text align="center" style={styles.failed} tone="muted" variant="callout">
            This picture can’t be drawn on the phone. {botName} can still read it.
          </Text>
        ) : (
          <MarkupCanvas
            accent={theme.accent}
            background={theme.fill}
            color={color}
            comments={comments}
            dom={{
              bounces: false,
              // Like a visual's frame: no cookies, storage or cache of its own.
              incognito: true,
              scrollEnabled: false,
              style: { flex: 1 },
              useExpoDOMWebView: false
            }}
            exportId={exportId}
            exportMime={mime}
            getPicture={async () => file.data_url}
            line={sizes.line}
            markup={now}
            next={nextStep(now.marks)}
            onArea={area => {
              setPending(area)
              if (tool === 'comment' && onComment)
                onComment({ area, where: areaWhere(area, now.crop) })
            }}
            onExported={(id, url) => {
              exports.current.get(id)?.(url)
              exports.current.delete(id)
            }}
            onFailed={() => setFailed(true)}
            onMark={(mark: Mark) =>
              commit({ ...latest.current.now, marks: [...latest.current.now.marks, mark] })
            }
            onMove={(id, dx, dy) => {
              const current = latest.current.now
              commit({
                ...current,
                marks: current.marks.map(mark => (mark.id === id ? moved(mark, dx, dy) : mark))
              })
            }}
            onReady={(w, h) => setNatural({ h, w })}
            onSelect={setSelected}
            onTap={(x, y) => {
              setTyping({ x, y })
              setTyped('')
            }}
            pending={pending}
            pictureKey={pictureKey}
            selected={selected}
            text={sizes.text}
            tool={tool}
          />
        )}
      </View>
      {typing ? (
        <View style={[styles.inline, { borderTopColor: theme.hairline }]}>
          <TextInput
            accessibilityLabel="Text on the picture"
            autoFocus
            onChangeText={setTyped}
            onSubmitEditing={addText}
            placeholder="Text"
            placeholderTextColor={theme.faint}
            returnKeyType="done"
            selectionColor={theme.accent}
            style={[styles.textField, { backgroundColor: theme.fill, color: theme.text }]}
            testID="markup-text-input"
            value={typed}
          />
          <Button
            label="Cancel"
            onPress={() => setTyping(null)}
            size="small"
            testID="markup-text-cancel"
            variant="plain"
          />
          <Button
            disabled={!typed.trim()}
            label="Add"
            onPress={addText}
            size="small"
            testID="markup-text-add"
          />
        </View>
      ) : tool === 'crop' && pending ? (
        <View style={[styles.inline, { borderTopColor: theme.hairline }]}>
          <Text style={styles.fill} tone="muted" variant="footnote">
            Keep the marked part
          </Text>
          <Button
            label="Cancel"
            onPress={() => setPending(null)}
            size="small"
            testID="markup-crop-cancel"
            variant="plain"
          />
          <Button label="Crop" onPress={applyCrop} size="small" testID="markup-crop-apply" />
        </View>
      ) : selected ? (
        <View style={[styles.inline, { borderTopColor: theme.hairline }]}>
          <Text style={styles.fill} tone="muted" variant="footnote">
            Drag to move it
          </Text>
          <Button
            icon="trash-outline"
            label="Delete"
            onPress={() => {
              commit({ ...now, marks: now.marks.filter(mark => mark.id !== selected) })
              setSelected(null)
            }}
            size="small"
            testID="markup-delete"
            variant="destructive"
          />
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={styles.tools}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.toolStrip}
      >
        {tools.map(item => {
          const on = tool === item.tool
          return (
            <Pressable
              accessibilityLabel={item.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              key={item.tool}
              onPress={() => pickTool(item.tool)}
              style={[styles.tool, on && { backgroundColor: withAlpha(theme.accent, 0.16) }]}
              testID={`markup-tool-${item.tool}`}
            >
              {item.icon ? (
                <Ionicons color={on ? theme.accent : theme.text} name={item.icon} size={20} />
              ) : (
                <View style={[styles.stepIcon, { borderColor: on ? theme.accent : theme.text }]}>
                  <Text style={{ color: on ? theme.accent : theme.text }} variant="caption">
                    1
                  </Text>
                </View>
              )}
            </Pressable>
          )
        })}
      </ScrollView>
      <View style={styles.row}>
        <View style={styles.swatches}>
          {COLORS.map(item => (
            <Pressable
              accessibilityLabel={item.label}
              accessibilityRole="button"
              accessibilityState={{ selected: color === item.value }}
              hitSlop={4}
              key={item.value}
              onPress={() => setColor(item.value)}
              style={[
                styles.swatch,
                { backgroundColor: item.value, borderColor: withAlpha(theme.text, 0.2) },
                color === item.value && { borderColor: theme.accent, borderWidth: 3 }
              ]}
              testID={`markup-color-${item.label.toLowerCase()}`}
            />
          ))}
        </View>
        <View style={styles.sizes}>
          {[0, 1, 2].map(value => (
            <Pressable
              accessibilityLabel={['Thin', 'Medium', 'Thick'][value]!}
              accessibilityRole="button"
              accessibilityState={{ selected: size === value }}
              key={value}
              onPress={() => setSize(value)}
              style={[
                styles.size,
                size === value && { backgroundColor: withAlpha(theme.accent, 0.16) }
              ]}
              testID={`markup-size-${value}`}
            >
              <View
                style={{
                  backgroundColor: size === value ? theme.accent : theme.text,
                  borderRadius: 6,
                  height: 4 + value * 3,
                  width: 4 + value * 3
                }}
              />
            </Pressable>
          ))}
        </View>
        <IconButton
          accessibilityLabel="Undo"
          disabled={!steps.past.length}
          icon="arrow-undo"
          iconSize={20}
          onPress={() => setSteps(undo)}
          size={36}
          testID="markup-undo"
        />
        <IconButton
          accessibilityLabel="Redo"
          disabled={!steps.future.length}
          icon="arrow-redo"
          iconSize={20}
          onPress={() => setSteps(redo)}
          size={36}
          testID="markup-redo"
        />
      </View>
      {onAdd ? (
        <View style={styles.add}>
          <Button
            busy={added}
            busyLabel="Added to your message"
            icon="add"
            label="Add to message"
            onPress={() =>
              void exportNow().then(url => {
                onAdd(url, pictureName(file.name, file.mime))
                setAdded(true)
                setTimeout(() => setAdded(false), 1600)
              })
            }
            testID="markup-add"
            variant="secondary"
            wide
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  add: { paddingHorizontal: 16, paddingTop: 4 },
  canvas: { borderRadius: 16, flex: 1, marginHorizontal: 12, overflow: 'hidden' },
  failed: { padding: 32 },
  fill: { flex: 1 },
  inline: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingTop: 8
  },
  row: { alignItems: 'center', flexDirection: 'row', gap: 4, paddingHorizontal: 12 },
  size: { alignItems: 'center', borderRadius: 14, height: 28, justifyContent: 'center', width: 28 },
  sizes: { flexDirection: 'row', marginLeft: 'auto' },
  stepIcon: {
    alignItems: 'center',
    borderRadius: 11,
    borderWidth: 2,
    height: 22,
    justifyContent: 'center',
    width: 22
  },
  swatch: { borderRadius: 12, borderWidth: 1, height: 24, width: 24 },
  swatches: { flexDirection: 'row', gap: 8 },
  textField: { borderRadius: 10, flex: 1, fontSize: 16, minHeight: 40, paddingHorizontal: 12 },
  tool: { alignItems: 'center', borderRadius: 12, height: 40, justifyContent: 'center', width: 44 },
  toolStrip: { flexGrow: 0 },
  tools: { gap: 2, paddingHorizontal: 12, paddingVertical: 8 }
})
