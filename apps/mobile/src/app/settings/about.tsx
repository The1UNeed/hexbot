import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'

import { FaceDrawing } from '../../components/face'
import { Group, ListScroll, Row } from '../../components/list'
import { appVersion } from '../../components/settings/kit'
import { styleForName } from '../../lib/avatar-builder'
import { daemonInfo } from '../../lib/api'
import type { DaemonInfo } from '../../lib/types'
import { daemonBehind } from '../../lib/version-skew'
import { useConnection } from '../../stores/connection'
import { useTheme } from '../../theme'

/** About: this app, the daemon and its agent runtime, the license and the credit. */
export default function About() {
  const { colors } = useTheme()
  const cached = useConnection(state => state.daemon)
  const [info, setInfo] = useState<DaemonInfo | null>(cached)

  useEffect(() => {
    void daemonInfo()
      .then(setInfo)
      .catch(() => undefined)
  }, [])

  const app = appVersion()
  const behind = info ? daemonBehind(app, info.version) : false

  return (
    <>
      <Stack.Screen options={{ title: 'About' }} />
      <ListScroll testID="about">
        <View style={styles.hero}>
          <FaceDrawing size={72} style={styleForName('hexbot')} />
          <Text style={[styles.name, { color: colors.text }]}>Hexbot</Text>
          <Text style={[styles.tagline, { color: colors.textMuted }]}>Bots with faces and memories of their own, on your own computer.</Text>
        </View>

        <Group footer={behind ? `The daemon is older than this app. Update Hexbot on ${info?.daemon_name ?? 'the computer'}.` : undefined}>
          <Row title="App" value={app} />
          <Row title="Daemon" value={info?.version ?? '—'} />
          <Row title="Agent runtime" value={info?.hermes_version ?? '—'} />
          <Row title="License" value="AGPL-3.0" />
        </Group>

        <Group>
          <Row chevron icon="safari" onPress={() => void Linking.openURL('https://hexbot.app')} testID="about-website" title="Website" />
          <Row
            chevron
            icon="chevron.left.forwardslash.chevron.right"
            onPress={() => void Linking.openURL('https://github.com/The1UNeed/hexbot')}
            testID="about-source"
            title="Source code"
          />
        </Group>

        <Text style={[styles.credit, { color: colors.textMuted }]}>
          Hexbot began as a fork of Hermes Agent by Nous Research, used under the MIT license.
        </Text>
      </ListScroll>
    </>
  )
}

const styles = StyleSheet.create({
  credit: { fontSize: 13, lineHeight: 18, paddingHorizontal: 24, textAlign: 'center' },
  hero: { alignItems: 'center', gap: 6, paddingTop: 8 },
  name: { fontSize: 28, fontWeight: '700', marginTop: 6 },
  tagline: { fontSize: 15, lineHeight: 20, paddingHorizontal: 24, textAlign: 'center' }
})
