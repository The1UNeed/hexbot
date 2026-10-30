import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import notices from '../third-party-notices.json'
import { Group, Row, Text } from './ui'

/** One license text and the packages that ship it. */
interface Item {
  key: string
  title: string
  subtitle: string
  text: string
}

// Written by scripts/desktop/third-party-notices.mjs; `pnpm mobile:check` fails when it is stale.
const items: Item[] = [
  ...notices.licenses.map(license => ({
    key: license.id,
    title: license.id,
    subtitle: 'Full license text for the packages below that use it',
    text: license.text
  })),
  ...notices.entries.map(entry => ({
    key: `${entry.packages[0]!.name}@${entry.packages[0]!.version}`,
    title: entry.packages.map(item => `${item.name} ${item.version}`).join(', '),
    subtitle: [...new Set(entry.packages.map(item => item.license || 'See text'))].join(', '),
    text: entry.text
  }))
]

/** The open source packages this app ships, each opening to the license and notices it carries. */
export function Licenses() {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <>
      <Text tone="muted">
        Hexbot is Apache-2.0 software. This app includes the open source packages below. Tap one
        for its license and notices.
      </Text>
      <Group testID="licenses">
        {items.map(item => (
          <View key={item.key}>
            <Row
              accessibilityHint={open === item.key ? 'Hides the license' : 'Shows the license'}
              onPress={() => setOpen(open === item.key ? null : item.key)}
              subtitle={item.subtitle}
              testID={`license-${item.key}`}
              title={item.title}
            />
            {open === item.key ? (
              <Text selectable style={styles.text} variant="footnote">
                {item.text}
              </Text>
            ) : null}
          </View>
        ))}
      </Group>
    </>
  )
}

const styles = StyleSheet.create({
  text: { paddingBottom: 14, paddingHorizontal: 16 }
})
