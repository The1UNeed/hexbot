import { memo } from 'react'
import { Linking, Text as NativeText, Platform, View } from 'react-native'
import { parseMessage, type Span } from './core/message-text'
import { mono, useTheme } from './ui'

/**
 * A browser selects across the paragraphs. On a phone, iOS can only copy a
 * whole text view, one paragraph here, so a long press on the bubble offers
 * Copy and Select text instead (`ChatScreen`).
 */
const selectable = Platform.OS === 'web'

function inline(spans: Span[], ink: string) {
  return spans.map((span, i) => {
    if (span.kind === 'link')
      return (
        <NativeText
          key={i}
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(span.url)
          }}
          style={{ color: ink, textDecorationLine: 'underline' }}
        >
          {span.text}
        </NativeText>
      )
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
  user = false
}: {
  text: string
  user?: boolean
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
            {inline(block.spans, color)}
          </NativeText>
        )
      )}
    </View>
  )
})
