import { type ReactNode } from 'react'
import { Linking, Text as NativeText, View } from 'react-native'
import { mono, useTheme } from './ui'
function inline(text: string, ink: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part)
    if (link)
      return (
        <NativeText
          key={i}
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(link[2])
          }}
          style={{ color: ink, textDecorationLine: 'underline' }}
        >
          {link[1]}
        </NativeText>
      )
    if (part.startsWith('**') && part.endsWith('**'))
      return (
        <NativeText key={i} style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </NativeText>
      )
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <NativeText key={i} style={{ fontFamily: mono }}>
          {part.slice(1, -1)}
        </NativeText>
      )
    return part
  })
}
export function MarkdownText({ text, user = false }: { text: string; user?: boolean }) {
  const theme = useTheme()
  const color = user ? theme.onInk : theme.text
  return (
    <View style={{ gap: 10 }}>
      {text
        .split(/(```[\s\S]*?```)/g)
        .filter(Boolean)
        .map((block, index) => {
          if (block.startsWith('```'))
            return (
              <NativeText
                key={index}
                selectable
                style={{ color, fontFamily: mono, fontSize: 14, lineHeight: 20 }}
              >
                {block
                  .replace(/^```[^\n]*\n?/, '')
                  .replace(/```$/, '')
                  .trimEnd()}
              </NativeText>
            )
          return block
            .trim()
            .split(/\n\s*\n/)
            .map((paragraph, i) => {
              const heading = /^(#{1,6})\s+/.exec(paragraph)
              return (
                <NativeText
                  key={`${index}-${i}`}
                  selectable
                  style={{
                    color,
                    fontSize: heading ? 20 : 17,
                    fontWeight: heading ? '600' : '400',
                    lineHeight: heading ? 26 : 23
                  }}
                >
                  {inline(
                    paragraph.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s/gm, '• '),
                    user ? color : theme.accent
                  )}
                </NativeText>
              )
            })
        })}
    </View>
  )
}
