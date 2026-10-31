import { Ionicons } from '@expo/vector-icons'
import { useId, useRef, useState } from 'react'
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native'
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg'

import { applyFormat, type Format, type Selection } from './core/markdown-edit'
import { MarkdownText } from './MarkdownText'
import { Group, mono, radius, Row, Segmented, Text, useTheme } from './ui'

export type FingerprintFile = 'memory' | 'soul'

/** 10.25.26, in the reader's own order of day and month, as the app shows it. */
export function cardDate(seconds: null | number | undefined): string {
  if (!seconds) return 'Not written yet'
  return new Date(seconds * 1000)
    .toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })
    .replace(/[/-]/g, '.')
}

const CARDS: Record<
  FingerprintFile,
  { base: [string, string]; deep: string; glow: string; line: string; title: string }
> = {
  memory: {
    base: ['#3c3fd6', '#2622a6'],
    deep: '#1d1a8f',
    glow: '#5a5cf0',
    line: 'What it remembers',
    title: 'Memory'
  },
  soul: {
    base: ['#d8314b', '#a8182f'],
    deep: '#8f1028',
    glow: '#ef4d63',
    line: 'Who it is',
    title: 'Soul'
  }
}

function FileCard({
  date,
  disabled,
  file,
  onPress
}: {
  date: null | number | undefined
  disabled?: boolean
  file: FingerprintFile
  onPress: () => void
}) {
  const card = CARDS[file]
  const id = useId().replace(/:/g, '')

  return (
    <Pressable
      accessibilityHint={`Opens ${card.title.toLowerCase()}`}
      accessibilityLabel={`${card.title}, edited ${cardDate(date)}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { opacity: disabled ? 0.5 : 1 },
        pressed && styles.pressed
      ]}
      testID={`fingerprint-${file}`}
    >
      <Svg height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <LinearGradient id={`${id}b`} x1="0" x2="1" y1="0" y2="1">
            <Stop offset="0" stopColor={card.base[0]} />
            <Stop offset="1" stopColor={card.base[1]} />
          </LinearGradient>
          <RadialGradient cx="72%" cy="28%" id={`${id}g`} r="70%">
            <Stop offset="0" stopColor={card.glow} stopOpacity="1" />
            <Stop offset="1" stopColor={card.glow} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient cx="15%" cy="95%" id={`${id}d`} r="70%">
            <Stop offset="0" stopColor={card.deep} stopOpacity="1" />
            <Stop offset="1" stopColor={card.deep} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect fill={`url(#${id}b)`} height="100%" width="100%" />
        <Rect fill={`url(#${id}g)`} height="100%" width="100%" />
        <Rect fill={`url(#${id}d)`} height="100%" width="100%" />
      </Svg>
      <View>
        <Text style={styles.cardTitle}>{card.title.toUpperCase()}</Text>
        <Text style={styles.cardLine}>{card.line.toUpperCase()}</Text>
      </View>
      <Text style={styles.cardDate}>{cardDate(date)}</Text>
    </Pressable>
  )
}

/** The bot's soul and memory as two cards, each with the day it last changed. */
export function FingerprintCards({
  disabled,
  memoryAt,
  name,
  onOpen,
  soulAt
}: {
  disabled?: boolean
  memoryAt: null | number | undefined
  name: string
  onOpen: (file: FingerprintFile) => void
  soulAt: null | number | undefined
}) {
  return (
    <Group
      footer={`${name} and you both write these. Your chat takes changes after it summarises older messages.`}
      title="Fingerprint"
    >
      <View style={styles.cards}>
        <FileCard date={soulAt} disabled={disabled} file="soul" onPress={() => onOpen('soul')} />
        <FileCard
          date={memoryAt}
          disabled={disabled}
          file="memory"
          onPress={() => onOpen('memory')}
        />
      </View>
    </Group>
  )
}

export function aboutFile(file: FingerprintFile, name: string): string {
  return file === 'soul'
    ? `This is ${name}'s soul: who it is and the values it tries to hold to in every conversation. ${name} may refine it over time and tells you when it does. You can edit it at any time. This note is not part of the file.`
    : `This is what ${name} remembers: facts, preferences and lessons it keeps from one conversation to the next. ${name} writes it as you talk, and dreaming tidies it each day. You can edit it at any time. This note is not part of the file.`
}

const TOOLS: {
  format: Format
  label: string
  text?: string
  icon?: keyof typeof Ionicons.glyphMap
}[] = [
  { format: 'bold', label: 'Bold', text: 'B' },
  { format: 'italic', label: 'Italic', text: 'I' },
  { format: 'h1', label: 'Heading 1', text: 'H1' },
  { format: 'h2', label: 'Heading 2', text: 'H2' },
  { format: 'h3', label: 'Heading 3', text: 'H3' },
  { format: 'bullet', icon: 'list', label: 'Bulleted list' },
  { format: 'ordered', label: 'Numbered list', text: '1.' }
]

/**
 * A soul or memory file: formatted to read, its Markdown with a few tools to
 * edit. The card's Save sends it; Share hands the text to another app.
 */
export function DocumentPanel({
  about,
  cap,
  fileName,
  onChange,
  value
}: {
  about: string
  cap?: number
  fileName: string
  onChange: (text: string) => void
  value: string
}) {
  const theme = useTheme()
  const [mode, setMode] = useState<'edit' | 'read'>('read')
  const selection = useRef<Selection>({ end: value.length, start: value.length })
  const [shownSelection, setShownSelection] = useState<Selection | undefined>()
  const over = cap !== undefined && value.length > cap

  const format = (kind: Format) => {
    const edit = applyFormat(value, selection.current, kind)
    selection.current = edit.selection
    setShownSelection(edit.selection)
    onChange(edit.text)
  }

  return (
    <>
      <Text style={styles.about} tone="muted" variant="footnote">
        <Text style={styles.aboutLead} tone="muted" variant="footnote">
          About this file.{' '}
        </Text>
        {about}
      </Text>
      <Segmented
        onChange={setMode}
        options={[
          { key: 'read', label: 'Read' },
          { key: 'edit', label: 'Edit' }
        ]}
        selected={mode}
        testID="document-mode"
      />
      {mode === 'read' ? (
        <View style={[styles.page, { backgroundColor: theme.surface }]} testID="document-read">
          {value.trim() ? (
            <MarkdownText text={value} />
          ) : (
            <Text tone="muted">Nothing written yet.</Text>
          )}
        </View>
      ) : (
        <View style={[styles.page, { backgroundColor: theme.surface }]}>
          <View accessibilityRole="toolbar" style={styles.tools}>
            {TOOLS.map(tool => (
              <Pressable
                accessibilityLabel={tool.label}
                accessibilityRole="button"
                hitSlop={4}
                key={tool.format}
                onPress={() => format(tool.format)}
                style={({ pressed }) => [
                  styles.tool,
                  { backgroundColor: pressed ? theme.fill : 'transparent' }
                ]}
                testID={`document-tool-${tool.format}`}
              >
                {tool.icon ? (
                  <Ionicons color={theme.text} name={tool.icon} size={18} />
                ) : (
                  <Text
                    style={[
                      styles.toolText,
                      tool.format === 'italic' && { fontStyle: 'italic' },
                      tool.format === 'bold' && { fontWeight: '800' }
                    ]}
                  >
                    {tool.text}
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel={`${fileName} source`}
            autoCorrect
            multiline
            onChangeText={text => {
              setShownSelection(undefined)
              onChange(text)
            }}
            onSelectionChange={event => {
              selection.current = event.nativeEvent.selection
            }}
            placeholder="Nothing written yet. Start typing."
            placeholderTextColor={theme.muted}
            scrollEnabled={false}
            selection={shownSelection}
            style={[styles.source, { color: theme.text }]}
            testID="document-source"
            textAlignVertical="top"
            value={value}
          />
        </View>
      )}
      {cap !== undefined ? (
        <Text
          align="right"
          style={styles.count}
          tone={over ? 'danger' : 'muted'}
          variant="footnote"
        >
          {`${value.length.toLocaleString()} / ${cap.toLocaleString()}`}
        </Text>
      ) : null}
      <Group>
        <Row
          leading={<Ionicons color={theme.text} name="share-outline" size={20} />}
          onPress={() => void Share.share({ message: value, title: fileName })}
          testID="document-share"
          title="Share"
        />
      </Group>
    </>
  )
}

const styles = StyleSheet.create({
  about: { fontStyle: 'italic', lineHeight: 19, paddingHorizontal: 4 },
  aboutLead: { fontStyle: 'normal', fontWeight: '600' },
  card: {
    aspectRatio: 6 / 5,
    borderRadius: 20,
    flex: 1,
    justifyContent: 'space-between',
    overflow: 'hidden',
    padding: 14
  },
  cardDate: { color: 'rgba(255,255,255,0.85)', fontFamily: mono, fontSize: 13, letterSpacing: 0.5 },
  cardLine: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: mono,
    fontSize: 10,
    letterSpacing: 0.8,
    marginTop: 4
  },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '600', letterSpacing: 0.6 },
  cards: { flexDirection: 'row', gap: 10, padding: 10 },
  count: { paddingHorizontal: 4 },
  page: { borderRadius: radius.card, gap: 8, minHeight: 240, padding: 16 },
  pressed: { transform: [{ scale: 0.98 }] },
  source: { fontFamily: mono, fontSize: 14, lineHeight: 21, minHeight: 200 },
  tool: {
    alignItems: 'center',
    borderRadius: 9,
    height: 34,
    justifyContent: 'center',
    minWidth: 34
  },
  toolText: { fontSize: 14, fontWeight: '600' },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 }
})
