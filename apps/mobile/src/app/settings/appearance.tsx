import * as Haptics from 'expo-haptics'
import { Stack } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Icon } from '../../components/icon'
import { Group, ListScroll } from '../../components/list'
import { applyNativeAppearance } from '../../components/settings/native-appearance'
import { type ThemePreference, useUi } from '../../stores/ui'
import { type Palette, palettes, useTheme } from '../../theme'

const CHOICES: { label: string; value: ThemePreference }[] = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' }
]

/** Face colours for the little previews, from the avatar palette. */
const FACES = ['#F59E0B', '#10B981', '#3B82F6']

/** Appearance: System, Light or Dark, each drawn as a small preview of the home list. */
export default function Appearance() {
  const { colors } = useTheme()
  const theme = useUi(state => state.theme)
  const setTheme = useUi(state => state.setTheme)

  const choose = (value: ThemePreference) => {
    if (value === theme) {
      return
    }

    void Haptics.selectionAsync().catch(() => undefined)
    setTheme(value)
    applyNativeAppearance(value)
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Appearance' }} />
      <ListScroll testID="appearance">
        <Group footer="System follows this phone's setting.">
          <View accessibilityLabel="Theme" accessibilityRole="radiogroup" style={styles.choices}>
            {CHOICES.map(choice => {
              const selected = theme === choice.value

              return (
                <Pressable
                  accessibilityLabel={choice.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={choice.value}
                  onPress={() => choose(choice.value)}
                  style={styles.choice}
                  testID={`appearance-${choice.value}`}
                >
                  <View style={[styles.frame, { borderColor: selected ? colors.text : 'transparent' }]}>
                    <Preview kind={choice.value} />
                  </View>
                  <Text style={[styles.label, { color: colors.text }]}>{choice.label}</Text>
                  <View
                    style={[
                      styles.radio,
                      selected ? { backgroundColor: colors.primary, borderColor: colors.primary } : { borderColor: colors.textFaint }
                    ]}
                  >
                    {selected ? <Icon color={colors.primaryText} name="checkmark" size={11} weight="bold" /> : null}
                  </View>
                </Pressable>
              )
            })}
          </View>
        </Group>
      </ListScroll>
    </>
  )
}

/** A tiny home list in one palette; System splits light and dark down the middle. */
function Preview({ kind }: { kind: ThemePreference }) {
  const [width, setWidth] = useState(0)

  if (kind !== 'system') {
    return <MiniList palette={palettes[kind]} />
  }

  return (
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={styles.fill}>
      <MiniList palette={palettes.light} />
      <View style={[styles.half, { width: width / 2 }]}>
        <View style={{ height: '100%', marginLeft: -width / 2, width }}>
          <MiniList palette={palettes.dark} />
        </View>
      </View>
    </View>
  )
}

function MiniList({ palette }: { palette: Palette }) {
  const { colors } = useTheme()

  return (
    <View style={[styles.mini, { backgroundColor: palette.bg, borderColor: colors.hairline }]}>
      <View style={styles.miniTop}>
        <View style={[styles.miniAvatar, { backgroundColor: palette.surface2 }]} />
        <View style={[styles.miniButton, { backgroundColor: palette.surface2 }]} />
      </View>
      {FACES.map(face => (
        <View key={face} style={styles.miniRow}>
          <View style={[styles.miniFace, { backgroundColor: face }]} />
          <View style={styles.miniLines}>
            <View style={[styles.miniLine, { backgroundColor: palette.text, width: '70%' }]} />
            <View style={[styles.miniLine, { backgroundColor: palette.textFaint, width: '45%' }]} />
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  choice: { alignItems: 'center', flex: 1, gap: 8 },
  choices: { flexDirection: 'row', gap: 14, paddingHorizontal: 18, paddingVertical: 20 },
  fill: { flex: 1 },
  frame: { aspectRatio: 0.62, borderCurve: 'continuous', borderRadius: 16, borderWidth: 2, padding: 2, width: '100%' },
  half: { bottom: 0, overflow: 'hidden', position: 'absolute', right: 0, top: 0 },
  label: { fontSize: 15, fontWeight: '500' },
  mini: { borderCurve: 'continuous', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flex: 1, gap: 9, overflow: 'hidden', paddingHorizontal: 8, paddingTop: 10 },
  miniAvatar: { borderRadius: 6, height: 12, width: 12 },
  miniButton: { borderRadius: 6, height: 12, width: 12 },
  miniFace: { borderRadius: 8, height: 16, width: 16 },
  miniLine: { borderRadius: 2, height: 4 },
  miniLines: { flex: 1, gap: 4 },
  miniRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  miniTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  radio: { alignItems: 'center', borderRadius: 11, borderWidth: 1.5, height: 22, justifyContent: 'center', width: 22 }
})
