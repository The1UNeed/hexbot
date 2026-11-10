import { useEffect, useRef, useState } from 'react'
import { Image, PixelRatio, Platform, StyleSheet, View } from 'react-native'
import type Svg from 'react-native-svg'

import { botPhoto, refusesFace } from './core/avatar'
import { pickFile } from './core/pickFile'
import type { Bot } from './core/types'
import type { useMobile } from './core/useMobile'
import {
  Banner,
  Button,
  FaceDrawing,
  FacePicker,
  type FaceStyle,
  faceForName,
  faceWash,
  radius,
  randomFace,
  Text,
  useTheme
} from './ui'

/**
 * The side of the drawing a face's picture is taken from. The library saves
 * a drawing at the size it is shown, in device pixels on a phone, so this
 * makes the picture 512 pixels square, as the web app saves it.
 */
const PICTURE = Platform.OS === 'web' ? 512 : 512 / PixelRatio.get()

/**
 * The Face page, as in the web app: the bot as it will look, on a stage
 * washed with its colour over a sample of its bubble, then every shape and
 * colour. Each pick is saved at once with its picture, for clients that only
 * show pictures. A photo takes the face's place until a shape or a colour is
 * picked again, or the photo is taken off.
 */
export function FaceEditor({ bot, mobile }: { bot: Bot; mobile: ReturnType<typeof useMobile> }) {
  const theme = useTheme()
  const [picked, setPicked] = useState<FaceStyle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drawing = useRef<Svg>(null)
  // A pick shows at once, in place of the photo too.
  const photo = picked ? null : botPhoto(bot)
  const value = picked ?? bot.face ?? bot.kept_face ?? faceForName(bot.display_name)
  const face = photo ? null : { face: value, name: bot.display_name }
  const off = busy || mobile.connection !== 'connected'

  const write = async (patch: { avatar: null | string; face?: FaceStyle }) => {
    setBusy(true)
    setError(null)

    try {
      await mobile.rpc('hexbot.bots.update', { name: bot.name, ...patch }).catch(cause => {
        // A daemon from before stored faces keeps the picture alone.
        if (!patch.face || !refusesFace(cause)) throw cause

        return mobile.rpc('hexbot.bots.update', { avatar: patch.avatar, name: bot.name })
      })
      await mobile.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const saved = useRef(write)
  saved.current = write

  useEffect(() => {
    if (!picked) return

    let latest = true

    // By the next frame the unseen drawing shows the pick. A pick made before
    // then replaces this one, so only the last is saved.
    const frame = requestAnimationFrame(() =>
      drawing.current?.toDataURL(avatar => {
        if (latest) void saved.current({ avatar, face: picked })
      })
    )

    return () => {
      latest = false
      cancelAnimationFrame(frame)
    }
  }, [picked])

  const choosePhoto = async () => {
    try {
      const file = await pickFile(['image/png', 'image/jpeg', 'image/webp'], 2_000_000)

      if (!file) return

      setPicked(null)
      await write({ avatar: file.base64 })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      {error ? <Banner message={error} tone="danger" testID="face-error" /> : null}
      <View
        style={[
          styles.stage,
          { backgroundColor: face ? faceWash(face, theme.surface, theme.scheme) : theme.surface }
        ]}
        testID="face-stage"
      >
        {photo ? (
          <Image source={{ uri: photo }} style={styles.photo} testID="face-photo" />
        ) : (
          <FaceDrawing size={104} style={value} />
        )}
        <View pointerEvents="none" style={styles.unseen}>
          <FaceDrawing drawing={drawing} size={PICTURE} style={value} />
        </View>
        <Text variant="headline">{bot.display_name}</Text>
        <View
          style={[
            styles.bubble,
            { backgroundColor: face ? faceWash(face, theme.fill, theme.scheme) : theme.fill }
          ]}
        >
          <Text variant="callout">This is how my messages look.</Text>
        </View>
      </View>
      <View style={styles.actions}>
        {photo ? (
          <>
            <Button
              disabled={off}
              label="Choose another photo"
              onPress={() => void choosePhoto()}
              size="small"
              testID="action-choose-bot-picture"
              variant="secondary"
            />
            <Button
              disabled={off}
              label="Back to a face"
              onPress={() => void write({ avatar: null })}
              size="small"
              testID="action-use-generated-face"
              variant="plain"
            />
          </>
        ) : (
          <>
            <Button
              disabled={off}
              label="Shuffle"
              onPress={() =>
                setPicked(randomFace([value, ...mobile.bots.flatMap(b => [b.face, b.kept_face])]))
              }
              size="small"
              testID="action-shuffle-face"
              variant="secondary"
            />
            <Button
              disabled={off}
              label="Use a photo"
              onPress={() => void choosePhoto()}
              size="small"
              testID="action-choose-bot-picture"
              variant="plain"
            />
          </>
        )}
      </View>
      <View style={[styles.choices, { backgroundColor: theme.surface }]}>
        <FacePicker
          onChange={next => {
            if (mobile.connection === 'connected') setPicked(next)
          }}
          photo={!!photo}
          testID="face-picker"
          value={value}
        />
        {photo ? (
          <Text tone="muted" variant="footnote">
            {bot.display_name} shows a photo. Pick a shape or a colour to go back to a face.
          </Text>
        ) : null}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  bubble: {
    alignSelf: 'stretch',
    borderBottomLeftRadius: 6,
    borderRadius: radius.bubble,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  choices: { borderRadius: radius.panel, gap: 14, padding: 18 },
  photo: { borderRadius: 52, height: 104, width: 104 },
  stage: {
    alignItems: 'center',
    borderRadius: radius.panel,
    gap: 12,
    overflow: 'hidden',
    padding: 18
  },
  // The drawing the picture is taken from: laid out at its full size, which
  // the stage clips, and never seen.
  unseen: { height: PICTURE, left: 0, opacity: 0, position: 'absolute', top: 0, width: PICTURE }
})
