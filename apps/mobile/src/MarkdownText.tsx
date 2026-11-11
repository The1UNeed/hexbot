import { Ionicons } from '@expo/vector-icons'
import { memo } from 'react'
import { Linking, Text as NativeText, View } from 'react-native'
import { linkLabel, type Tag, tagHint } from '../../web/src/lib/tags'
import { parseMessage, type Span } from './core/message-text'
import { mono, useTheme } from './ui'

/** What a tag in a message opens here, as the app that holds the chat says. */
export interface ResolvedTag {
  /** The words to show instead of the message's own, such as a bot's name for `@handle`. */
  label?: string
  /** A bot's face colour for its name. */
  color?: string
  onPress: () => void
}

/**
 * Says what a tag opens, or null when there is nothing to open: a bot or a
 * room that is gone, a file outside a bot's own chat, a page this phone lacks.
 * Such a tag reads as its plain words.
 */
export type ResolveTag = (tag: Exclude<Tag, { kind: 'link' }>) => null | ResolvedTag

/** The glyph a tag leads with; a bot's name stands in its colour instead. */
const GLYPHS: Record<Exclude<Tag['kind'], 'bot'>, keyof typeof Ionicons.glyphMap> = {
  file: 'document-text-outline',
  jobs: 'time-outline',
  link: 'globe-outline',
  plugin: 'extension-puzzle-outline',
  room: 'chatbubbles-outline',
  settings: 'settings-outline',
  skill: 'sparkles-outline'
}

function inline(spans: Span[], ink: string, resolveTag?: ResolveTag) {
  return spans.map((span, i) => {
    if (span.kind === 'link')
      return (
        <NativeText
          key={i}
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(span.url)
          }}
          style={{ color: ink }}
        >
          <Ionicons name={GLYPHS.link} size={15} />{' '}
          <NativeText style={{ textDecorationLine: 'underline' }}>
            {linkLabel(span.text, span.url)}
          </NativeText>
        </NativeText>
      )
    if (span.kind === 'tag') {
      const tag = span.tag
      const found = resolveTag?.(tag)
      // Nothing to open here: the words as the bot wrote them.
      if (!found) return span.text
      return (
        <NativeText
          key={i}
          accessibilityHint={tagHint(tag)}
          accessibilityRole="button"
          onPress={found.onPress}
          style={{ color: ink }}
        >
          {tag.kind === 'bot' ? null : (
            <>
              <Ionicons name={GLYPHS[tag.kind]} size={15} />{' '}
            </>
          )}
          <NativeText
            style={
              tag.kind === 'bot'
                ? { color: found.color ?? ink, fontWeight: '600' }
                : { textDecorationLine: 'underline' }
            }
          >
            {found.label ?? span.text}
          </NativeText>
        </NativeText>
      )
    }
    if (span.kind === 'bold')
      return (
        <NativeText key={i} style={{ fontWeight: '700' }}>
          {span.text}
        </NativeText>
      )
    if (span.kind === 'code')
      return (
        <NativeText key={i} style={{ fontFamily: mono }}>
          {span.text}
        </NativeText>
      )
    return span.text
  })
}
export const MarkdownText = memo(function MarkdownText({
  text,
  user = false,
  selectable = true,
  resolveTag
}: {
  text: string
  user?: boolean
  /**
   * Off in a chat bubble on a phone: iOS copies only a whole paragraph here,
   * so a long press on the bubble offers Copy and Select text instead.
   */
  selectable?: boolean
  /** What the tags in the message open; without it they read as plain words. */
  resolveTag?: ResolveTag
}) {
  const theme = useTheme()
  // Links are underlined in the text colour too; the accent is too faint on a washed bubble.
  const color = user ? theme.onInk : theme.text
  return (
    <View style={{ gap: 10 }}>
      {parseMessage(text).map((block, index) =>
        block.kind === 'code' ? (
          <NativeText
            key={index}
            selectable={selectable}
            style={{ color, fontFamily: mono, fontSize: 14, lineHeight: 20 }}
          >
            {block.text}
          </NativeText>
        ) : (
          <NativeText
            key={index}
            selectable={selectable}
            style={{
              color,
              fontSize: block.heading ? 20 : 17,
              fontWeight: block.heading ? '600' : '400',
              lineHeight: block.heading ? 26 : 23
            }}
          >
            {inline(block.spans, color, resolveTag)}
          </NativeText>
        )
      )}
    </View>
  )
})
