/**
 * A native Markdown renderer for bubbles, built on `marked`'s lexer:
 * paragraphs, emphasis, inline code, fenced blocks (monospace, scrolling
 * sideways, copy on long-press), lists, links, headings, block quotes,
 * simple tables and rules. Colours come from the bubble it sits in.
 */

import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { lexer, type Token, type Tokens } from 'marked'
import { memo, type ReactNode, useMemo, useState } from 'react'
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '../../theme'

export const MONO = Platform.select({ android: 'monospace', default: 'Menlo' })

export interface Ink {
  /** Body text. */
  text: string
  /** Quotes, table rules, list markers. */
  muted: string
  /** Fill behind code blocks. */
  codeFill: string
  /** Fill behind inline code. */
  inlineFill: string
  /** Hairlines for tables and rules. */
  rule: string
}

const ENTITIES: Record<string, string> = { '&#39;': "'", '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' }
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, match => ENTITIES[match] ?? match)

function openLink(href: string) {
  void Linking.openURL(href).catch(() => undefined)
}

/** Inline tokens as nested Text, so a paragraph wraps as one run. */
function inline(tokens: Token[] | undefined, ink: Ink, key = 'i'): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const id = `${key}.${index}`

    switch (token.type) {
      case 'strong':
        return (
          <Text key={id} style={styles.strong}>
            {inline((token as Tokens.Strong).tokens, ink, id)}
          </Text>
        )
      case 'em':
        return (
          <Text key={id} style={styles.em}>
            {inline((token as Tokens.Em).tokens, ink, id)}
          </Text>
        )
      case 'del':
        return (
          <Text key={id} style={styles.del}>
            {inline((token as Tokens.Del).tokens, ink, id)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={id} style={[styles.codespan, { backgroundColor: ink.inlineFill }]}>
            {`\u2009${decode((token as Tokens.Codespan).text)}\u2009`}
          </Text>
        )
      case 'link': {
        const link = token as Tokens.Link

        return (
          <Text accessibilityRole="link" key={id} onPress={() => openLink(link.href)} style={styles.link}>
            {inline(link.tokens, ink, id)}
          </Text>
        )
      }
      case 'image': {
        const image = token as Tokens.Image

        return (
          <Text accessibilityRole="link" key={id} onPress={() => openLink(image.href)} style={styles.link}>
            {image.text || image.href}
          </Text>
        )
      }
      case 'br':
        return '\n'
      case 'text': {
        const text = token as Tokens.Text

        return text.tokens?.length ? (
          <Text key={id}>{inline(text.tokens, ink, id)}</Text>
        ) : (
          decode(text.text)
        )
      }
      case 'escape':
        return decode((token as Tokens.Escape).text)
      default:
        return decode(token.raw)
    }
  })
}

function CodeBlock({ code, ink, lang }: { code: string; ink: Ink; lang?: string }) {
  const { colors } = useTheme()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void Clipboard.setStringAsync(code)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <Pressable
      accessibilityHint="Long-press to copy"
      accessibilityLabel={lang ? `${lang} code` : 'Code'}
      delayLongPress={350}
      onLongPress={copy}
      style={[styles.codeBlock, { backgroundColor: ink.codeFill }]}
      testID="code-block"
    >
      {lang || copied ? (
        <Text style={[styles.codeLang, { color: copied ? colors.success : ink.muted }]}>{copied ? 'Copied' : lang}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.flat}>
        <Text selectable={false} style={[styles.code, { color: ink.text }]}>
          {code}
        </Text>
      </ScrollView>
    </Pressable>
  )
}

/** Column widths from the longest cell, so rows line up without measuring. */
function columnWidths(table: Tokens.Table): number[] {
  return table.header.map((cell, column) => {
    const longest = Math.max(cell.text.length, ...table.rows.map(row => row[column]?.text.length ?? 0))

    return Math.min(260, Math.max(56, longest * 10 + 28))
  })
}

function Table({ ink, table }: { ink: Ink; table: Tokens.Table }) {
  const widths = columnWidths(table)

  const row = (cells: Tokens.TableCell[], header: boolean, key: string) => (
    <View key={key} style={[styles.tableRow, { borderColor: ink.rule }]}>
      {cells.map((cell, column) => (
        <View key={column} style={[styles.tableCell, { width: widths[column] }]}>
          <Text
            style={[
              styles.body,
              { color: ink.text, textAlign: cell.align === 'center' ? 'center' : cell.align === 'right' ? 'right' : 'left' },
              header && styles.strong
            ]}
          >
            {inline(cell.tokens, ink, `${key}.${column}`)}
          </Text>
        </View>
      ))}
    </View>
  )

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
      <View>
        {row(table.header, true, 'h')}
        {table.rows.map((cells, index) => row(cells, false, `r${index}`))}
      </View>
    </ScrollView>
  )
}

const HEADING_SIZE = [0, 22, 20, 18, 17, 17, 17]

function blocks(tokens: Token[], ink: Ink, key = 'b'): ReactNode[] {
  const out: ReactNode[] = []

  tokens.forEach((token, index) => {
    const id = `${key}.${index}`

    switch (token.type) {
      case 'space':
      case 'def':
        return
      case 'paragraph':
        out.push(
          <Text key={id} style={[styles.body, { color: ink.text }]}>
            {inline((token as Tokens.Paragraph).tokens, ink, id)}
          </Text>
        )

        return
      case 'text': {
        const text = token as Tokens.Text

        out.push(
          <Text key={id} style={[styles.body, { color: ink.text }]}>
            {text.tokens ? inline(text.tokens, ink, id) : decode(text.text)}
          </Text>
        )

        return
      }
      case 'heading': {
        const heading = token as Tokens.Heading
        const size = HEADING_SIZE[heading.depth] ?? 17

        out.push(
          <Text accessibilityRole="header" key={id} style={[styles.heading, { color: ink.text, fontSize: size, lineHeight: size + 6 }]}>
            {inline(heading.tokens, ink, id)}
          </Text>
        )

        return
      }
      case 'code': {
        const code = token as Tokens.Code

        out.push(<CodeBlock code={code.text.replace(/\n$/, '')} ink={ink} key={id} lang={code.lang || undefined} />)

        return
      }
      case 'blockquote':
        out.push(
          <View key={id} style={[styles.quote, { borderColor: ink.rule }]}>
            {blocks((token as Tokens.Blockquote).tokens, { ...ink, text: ink.muted }, id)}
          </View>
        )

        return
      case 'list': {
        const list = token as Tokens.List
        const start = typeof list.start === 'number' ? list.start : 1

        out.push(
          <View key={id} style={styles.list}>
            {list.items.map((item, position) => (
              <View key={`${id}.${position}`} style={styles.listItem}>
                <Text style={[styles.body, styles.marker, { color: ink.muted }]}>
                  {item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${start + position}.` : '•'}
                </Text>
                <View style={styles.listBody}>{blocks(item.tokens.filter(child => child.type !== 'checkbox'), ink, `${id}.${position}`)}</View>
              </View>
            ))}
          </View>
        )

        return
      }
      case 'table':
        out.push(<Table ink={ink} key={id} table={token as Tokens.Table} />)

        return
      case 'hr':
        out.push(<View key={id} style={[styles.hr, { backgroundColor: ink.rule }]} />)

        return
      default:
        if (token.raw.trim()) {
          out.push(
            <Text key={id} style={[styles.body, { color: ink.text }]}>
              {decode(token.raw.trim())}
            </Text>
          )
        }
    }
  })

  return out
}

/** One message's Markdown, parsed once per text. */
export const Markdown = memo(function Markdown({ ink, text }: { ink: Ink; text: string }) {
  const tokens = useMemo(() => {
    try {
      return lexer(text)
    } catch {
      return [{ raw: text, text, type: 'text' } as Token]
    }
  }, [text])

  return <View style={styles.root}>{blocks(tokens, ink)}</View>
})

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 23 },
  code: { fontFamily: MONO, fontSize: 13.5, lineHeight: 19 },
  codeBlock: { borderRadius: 12, paddingBottom: 10, paddingHorizontal: 12, paddingTop: 9 },
  codeLang: { fontSize: 12, fontWeight: '500', marginBottom: 4 },
  codespan: { fontFamily: MONO, fontSize: 15 },
  del: { textDecorationLine: 'line-through' },
  em: { fontStyle: 'italic' },
  heading: { fontWeight: '700', marginTop: 4 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  link: { textDecorationLine: 'underline' },
  list: { gap: 4 },
  listBody: { flex: 1, gap: 6, minWidth: 0 },
  listItem: { flexDirection: 'row', gap: 8 },
  marker: { fontVariant: ['tabular-nums'], minWidth: 14 },
  quote: { borderLeftWidth: 3, gap: 8, paddingLeft: 10 },
  root: { gap: 10 },
  strong: { fontWeight: '600' },
  tableCell: { paddingHorizontal: 8, paddingVertical: 6 },
  tableRow: { borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row' },
  flat: { flexGrow: 0 },
  tableScroll: { flexGrow: 0, marginHorizontal: -4 }
})
