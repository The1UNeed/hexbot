/**
 * Pick a bot's face: a row of shapes drawn in the chosen colour and a row of
 * colour swatches, the chosen one ringed. `FaceRaster` turns a face into the
 * PNG the daemon stores (it accepts png, jpeg and webp, not SVG).
 */

import * as Haptics from 'expo-haptics'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Ellipse, Path } from 'react-native-svg'

import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarStyle, resolveStyle } from '../../lib/avatar-builder'
import { useTheme } from '../../theme'
import { FaceDrawing } from '../face'

const SHAPE = 40
const SWATCH = 24

export function FacePicker({ onChange, value }: { onChange: (style: AvatarStyle) => void; value: AvatarStyle }) {
  const { colors } = useTheme()

  const pick = (next: AvatarStyle) => {
    void Haptics.selectionAsync().catch(() => undefined)
    onChange(next)
  }

  return (
    <View style={styles.wrap}>
      <View accessibilityLabel="Shape" accessibilityRole="radiogroup" style={styles.row}>
        {AVATAR_SHAPES.map(shape => {
          const selected = value.shape === shape.id

          return (
            <Pressable
              accessibilityLabel={shape.label}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              hitSlop={2}
              key={shape.id}
              onPress={() => pick({ ...value, shape: shape.id })}
              style={[styles.shape, { borderColor: selected ? colors.text : 'transparent' }]}
              testID={`face-shape-${shape.id}`}
            >
              <FaceDrawing size={SHAPE - 12} style={{ color: value.color, shape: shape.id }} />
            </Pressable>
          )
        })}
      </View>
      <View accessibilityLabel="Colour" accessibilityRole="radiogroup" style={[styles.row, styles.colors]}>
        {AVATAR_COLORS.map(color => {
          const selected = value.color === color.id

          return (
            <Pressable
              accessibilityLabel={color.label}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              hitSlop={4}
              key={color.id}
              onPress={() => pick({ ...value, color: color.id })}
              style={[styles.ring, { borderColor: selected ? colors.text : 'transparent' }]}
              testID={`face-color-${color.id}`}
            >
              <View style={[styles.swatch, { backgroundColor: color.value, borderColor: colors.hairline }]} />
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export interface FaceRasterHandle {
  /** The face as a `data:image/png;base64,...` URL, or null if drawing failed. */
  capture: (style: AvatarStyle) => Promise<null | string>
}

type SvgRef = { toDataURL: (callback: (base64: string) => void, options?: object) => void }

/** An off-screen face that can be rasterised. Mount it once; call `capture`. */
export const FaceRaster = forwardRef<FaceRasterHandle>(function FaceRaster(_props, ref) {
  const svg = useRef<SvgRef | null>(null)
  const [job, setJob] = useState<null | { resolve: (value: null | string) => void; style: AvatarStyle }>(null)

  useImperativeHandle(ref, () => ({
    capture: style =>
      new Promise(resolve => {
        // Never hold up a save on the drawing: no PNG means the name-derived face.
        const giveUp = setTimeout(() => resolve(null), 1500)

        setJob({
          resolve: value => {
            clearTimeout(giveUp)
            resolve(value)
          },
          style
        })
      })
  }))

  useEffect(() => {
    if (!job) {
      return
    }

    // Let the new paths reach the native view before reading it back.
    const timer = setTimeout(() => {
      if (!svg.current) {
        return job.resolve(null)
      }

      try {
        // The PNG is the view's size at screen scale (128 pt -> 384 px on a 3x phone).
        svg.current.toDataURL(base64 => job.resolve(base64 ? `data:image/png;base64,${base64.replace(/\s+/g, '')}` : null))
      } catch {
        job.resolve(null)
      }
    }, 60)

    return () => clearTimeout(timer)
  }, [job])

  if (!job) {
    return null
  }

  const { color, shape } = resolveStyle(job.style)

  return (
    <View pointerEvents="none" style={styles.offscreen}>
      <Svg height={128} ref={svg as never} viewBox="0 0 100 100" width={128}>
        <Path d={shape.path} fill={color.value} />
        <Ellipse cx={41} cy={48} fill="#151517" rx={3.6} ry={6.2} />
        <Ellipse cx={59} cy={48} fill="#151517" rx={3.6} ry={6.2} />
      </Svg>
    </View>
  )
})

const styles = StyleSheet.create({
  colors: { gap: 2 },
  offscreen: { left: -1000, opacity: 0, position: 'absolute', top: 0 },
  ring: {
    alignItems: 'center',
    borderRadius: SWATCH,
    borderWidth: 2,
    height: SWATCH + 6,
    justifyContent: 'center',
    width: SWATCH + 6
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'center' },
  shape: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    borderWidth: 2,
    height: SHAPE + 4,
    justifyContent: 'center',
    width: SHAPE + 4
  },
  swatch: { borderRadius: SWATCH / 2, borderWidth: StyleSheet.hairlineWidth, height: SWATCH, width: SWATCH },
  wrap: { gap: 14 }
})
