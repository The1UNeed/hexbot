import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { FaceDrawing } from './BotFace'
import { FACE_COLORS, FACE_SHAPES, type FaceStyle, resolveFace } from './faces'
import { Text } from './Text'
import { HIT, useTheme } from './theme'

/** A heading with the name of what is picked beside it, over its choices. */
function Choice({
  children,
  faded,
  picked,
  title
}: {
  children: ReactNode
  faded: boolean
  picked?: string
  title: string
}) {
  return (
    <View style={styles.choice}>
      <View style={styles.heading}>
        <Text variant="subhead">{title}</Text>
        <Text tone="muted" variant="callout">
          {picked}
        </Text>
      </View>
      <View
        accessibilityLabel={title}
        accessibilityRole="radiogroup"
        style={[styles.grid, faded && styles.faded]}
      >
        {children}
      </View>
    </View>
  )
}

/**
 * Every shape, drawn in the chosen colour, and every colour, as the web
 * app's Face page offers them. Behind a photo nothing is picked and the
 * choices fade, but each still works: picking one brings the face back.
 */
export function FacePicker({
  onChange,
  photo = false,
  testID,
  value
}: {
  value: FaceStyle
  onChange: (face: FaceStyle) => void
  photo?: boolean
  testID: string
}) {
  const theme = useTheme()
  const { color, shape } = resolveFace(value)

  return (
    <View style={styles.picker} testID={testID}>
      <Choice faded={photo} picked={photo ? undefined : shape.label} title="Shape">
        {FACE_SHAPES.map(item => {
          const active = !photo && item.id === shape.id

          return (
            <View key={item.id} style={styles.shapeCell}>
              <Pressable
                accessibilityLabel={item.label}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                onPress={() => onChange({ color: color.id, shape: item.id })}
                style={[
                  styles.shape,
                  active && { backgroundColor: theme.fill, borderColor: theme.text }
                ]}
                testID={`${testID}-shape-${item.id}`}
              >
                <FaceDrawing size={36} style={{ color: color.id, shape: item.id }} />
              </Pressable>
            </View>
          )
        })}
      </Choice>
      <Choice faded={photo} picked={photo ? undefined : color.label} title="Colour">
        {FACE_COLORS.map(item => {
          const active = !photo && item.id === color.id

          return (
            <Pressable
              accessibilityLabel={item.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              key={item.id}
              onPress={() => onChange({ color: item.id, shape: shape.id })}
              style={styles.colorCell}
              testID={`${testID}-color-${item.id}`}
            >
              <View style={[styles.ring, active && { borderColor: theme.text }]}>
                <View
                  style={[
                    styles.swatch,
                    { backgroundColor: item.value, borderColor: theme.hairline }
                  ]}
                />
              </View>
            </Pressable>
          )
        })}
      </Choice>
    </View>
  )
}

const styles = StyleSheet.create({
  choice: { gap: 8 },
  colorCell: { alignItems: 'center', height: HIT, justifyContent: 'center', width: `${100 / 7}%` },
  faded: { opacity: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  heading: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  picker: { gap: 20 },
  ring: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: 20,
    borderWidth: 2,
    height: 40,
    justifyContent: 'center',
    width: 40
  },
  shape: {
    alignItems: 'center',
    aspectRatio: 1,
    borderColor: 'transparent',
    borderRadius: 14,
    borderWidth: 1.5,
    justifyContent: 'center'
  },
  shapeCell: { padding: 3, width: '20%' },
  swatch: { borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, height: 30, width: 30 }
})
