import { Pressable, StyleSheet, View } from 'react-native'

import { FaceDrawing } from './BotFace'
import { FACE_COLORS, FACE_SHAPES, type FaceStyle } from './faces'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

/** Pick a colour and a shape for a bot's face, with the face itself as the preview. */
export function FacePicker({
  onChange,
  testID,
  value
}: {
  value: FaceStyle
  onChange: (face: FaceStyle) => void
  testID: string
}) {
  const theme = useTheme()

  return (
    <View style={styles.picker} testID={testID}>
      <FaceDrawing mood="happy" size={88} style={value} />
      <View accessibilityLabel="Colour" accessibilityRole="radiogroup" style={styles.wrap}>
        {FACE_COLORS.map(color => {
          const active = color.id === value.color

          return (
            <Pressable
              accessibilityLabel={color.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              key={color.id}
              onPress={() => onChange({ ...value, color: color.id })}
              style={styles.cell}
              testID={`${testID}-color-${color.id}`}
            >
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: color.value, borderColor: active ? theme.text : 'transparent' }
                ]}
              />
            </Pressable>
          )
        })}
      </View>
      <View accessibilityLabel="Shape" accessibilityRole="radiogroup" style={styles.wrap}>
        {FACE_SHAPES.map(shape => {
          const active = shape.id === value.shape

          return (
            <Pressable
              accessibilityLabel={shape.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              key={shape.id}
              onPress={() => onChange({ ...value, shape: shape.id })}
              style={[styles.cell, styles.shape, active && { backgroundColor: theme.fill }]}
              testID={`${testID}-shape-${shape.id}`}
            >
              <FaceDrawing size={30} style={{ color: value.color, shape: shape.id }} />
            </Pressable>
          )
        })}
      </View>
      <Text tone="muted" variant="footnote">
        Tap a colour, then a shape.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  cell: { alignItems: 'center', height: HIT, justifyContent: 'center', width: HIT },
  picker: { alignItems: 'center', gap: 14 },
  shape: { borderRadius: 14 },
  swatch: { borderRadius: 15, borderWidth: 2.5, height: 30, width: 30 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }
})
