/**
 * The bot's large face; a tap opens the picker under it (shapes, colours, a
 * photo). A picked face is rasterised to PNG and saved at once.
 */

import * as ImagePicker from 'expo-image-picker'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'

import { type AvatarStyle, styleForName } from '../../lib/avatar-builder'
import type { Bot, BotUpdatePatch } from '../../lib/types'
import { useTheme } from '../../theme'
import { BotFace, type DotStatus } from '../face'

import { FacePicker, FaceRaster, type FaceRasterHandle } from './face-picker'

const MAX_BYTES = 2 * 1024 * 1024

export function FaceEditor({
  bot,
  onSave,
  size = 112,
  status
}: {
  bot: Bot
  onSave: (patch: BotUpdatePatch) => Promise<unknown>
  size?: number
  status?: DotStatus
}) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<AvatarStyle | null>(null)
  const [error, setError] = useState<null | string>(null)
  const raster = useRef<FaceRasterHandle>(null)
  const current = style ?? styleForName(bot.name)

  const save = (patch: BotUpdatePatch) => {
    setError(null)
    void onSave(patch).catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
  }

  const pick = async (next: AvatarStyle) => {
    setStyle(next)
    const png = await raster.current?.capture(next)

    if (png) {
      save({ avatar: png })
    } else {
      setError('Could not draw that face. Try again.')
    }
  }

  const photo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      base64: true,
      mediaTypes: ['images'],
      quality: 0.7
    })
    const asset = result.canceled ? null : result.assets[0]

    if (!asset?.base64) {
      return
    }

    if (asset.base64.length * 0.75 > MAX_BYTES) {
      return setError('Choose an image under 2 MB.')
    }

    save({ avatar: `data:image/jpeg;base64,${asset.base64}` })
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityHint={open ? 'Closes the face picker' : 'Opens the face picker'}
        accessibilityLabel="Change face"
        accessibilityRole="button"
        onPress={() => setOpen(value => !value)}
        style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.96 : 1 }] })}
        testID="bot-face"
      >
        <BotFace bot={bot} size={size} status={status} />
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={styles.picker}>
          <FacePicker onChange={next => void pick(next)} value={current} />
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void photo()} testID="bot-face-photo">
              <Text style={[styles.action, { color: colors.text }]}>Choose a photo</Text>
            </Pressable>
            {bot.avatar ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  setStyle(null)
                  save({ avatar: null })
                }}
                testID="bot-face-generated"
              >
                <Text style={[styles.action, { color: colors.textMuted }]}>Use a generated face</Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
      {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
      <FaceRaster ref={raster} />
    </View>
  )
}

const styles = StyleSheet.create({
  action: { fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 24, justifyContent: 'center' },
  error: { fontSize: 13, textAlign: 'center' },
  picker: { alignSelf: 'stretch', gap: 18, paddingTop: 8 },
  wrap: { alignItems: 'center', gap: 12 }
})
