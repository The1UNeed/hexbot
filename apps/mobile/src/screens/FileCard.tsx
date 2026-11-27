import { Pressable, StyleSheet, View } from 'react-native'

import { kindOf } from '../../../web/src/lib/file-kinds'
import { splitName } from '../core/files'
import { radius, Text, useTheme, withAlpha } from '../ui'

/** A page with two lines of text and a band in the file type's colour, as on the desktop. */
function PageIcon({ color }: { color: string }) {
  const theme = useTheme()
  const line = withAlpha(theme.text, 0.18)
  return (
    <View style={[styles.page, { backgroundColor: withAlpha(theme.text, 0.06) }]}>
      <View style={[styles.line, { backgroundColor: line }]} />
      <View style={[styles.line, styles.short, { backgroundColor: line }]} />
      <View style={[styles.band, { backgroundColor: color }]} />
    </View>
  )
}

/**
 * A file as one small card, the desktop's: its type, its name cut in the
 * middle so the extension stays, and its kind. Pictures, video and audio show
 * themselves instead; every other file is this card, and a tap previews it.
 */
export function FileCard({
  name,
  onOpen,
  testID
}: {
  name: string
  onOpen?: () => void
  testID?: string
}) {
  const theme = useTheme()
  const kind = kindOf(name)
  const { stem, ext } = splitName(name)
  const body = (
    <>
      <PageIcon color={kind.color} />
      <View style={styles.text}>
        <View style={styles.name}>
          <Text numberOfLines={1} style={styles.stem} variant="subhead">
            {stem}
          </Text>
          {ext ? <Text variant="subhead">.{ext}</Text> : null}
        </View>
        <Text numberOfLines={1} tone="muted" variant="footnote">
          {kind.label}
        </Text>
      </View>
    </>
  )
  const frame = { backgroundColor: theme.surface, borderColor: theme.hairline }
  return onOpen ? (
    <Pressable
      accessibilityHint="Shows a preview"
      accessibilityLabel={`${name}, ${kind.label}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.card, frame, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      {body}
    </Pressable>
  ) : (
    <View accessibilityLabel={`${name}, ${kind.label}`} style={[styles.card, frame]} testID={testID}>
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  band: { height: 12, marginTop: 'auto' },
  card: {
    alignItems: 'center',
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    maxWidth: 280,
    paddingLeft: 10,
    paddingRight: 14,
    paddingVertical: 10
  },
  line: { borderRadius: 2, height: 3, marginHorizontal: 6, marginTop: 8 },
  name: { flexDirection: 'row' },
  page: { borderRadius: 6, height: 40, overflow: 'hidden', width: 32 },
  short: { marginTop: 4, width: 12 },
  stem: { flexShrink: 1 },
  text: { flexShrink: 1, gap: 2 }
})
