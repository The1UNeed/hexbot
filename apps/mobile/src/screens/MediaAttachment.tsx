import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { useVideoPlayer, VideoView } from 'expo-video'
import { type ReactNode, useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'

import { IconButton, Text, useTheme } from '../ui'
import type { AttachmentView } from './types'

/** "0:07", "12:30": a player's time. */
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * A picture, video or audio file in a message. It plays from the phone's own
 * copy, or from the daemon's, read once through `load`. While that loads its
 * space is held; a file that cannot be read is its card.
 */
export function MediaAttachment({
  card,
  file,
  load
}: {
  card: ReactNode
  file: AttachmentView
  load?: (path: string) => Promise<string>
}) {
  const theme = useTheme()
  const [read, setRead] = useState<{ uri?: string; failed?: boolean }>({})
  const uri = file.uri ?? read.uri

  useEffect(() => {
    if (file.uri || !file.path || !load) return
    let live = true
    load(file.path).then(
      uri => live && setRead({ uri }),
      () => live && setRead({ failed: true })
    )
    return () => {
      live = false
    }
  }, [file.path, file.uri, load])

  if (read.failed || (!uri && !(file.path && load))) return card
  if (!uri)
    return (
      <View
        accessibilityLabel={`Loading ${file.name}`}
        style={[
          file.kind === 'audio' ? styles.audio : styles.video,
          { backgroundColor: theme.fill }
        ]}
        testID="chat-media-loading"
      />
    )
  if (file.kind === 'image')
    return (
      <Image
        accessibilityLabel={file.name}
        source={{ uri }}
        style={[styles.image, { backgroundColor: theme.fill }]}
      />
    )
  return file.kind === 'audio' ? (
    <AudioPlayer name={file.name} uri={uri} />
  ) : (
    <VideoPlayer name={file.name} uri={uri} />
  )
}

function VideoPlayer({ name, uri }: { name: string; uri: string }) {
  const player = useVideoPlayer(uri)
  return (
    <View accessibilityLabel={name} style={styles.video} testID="chat-video">
      <VideoView contentFit="contain" nativeControls player={player} style={styles.fill} />
    </View>
  )
}

// iOS keeps an app quiet under the silent switch unless it says it plays anyway.
let audioMode: Promise<void> | undefined

/** Hexbot's own small player: play or pause, how far it is, and how long. */
function AudioPlayer({ name, uri }: { name: string; uri: string }) {
  const theme = useTheme()
  const player = useAudioPlayer(uri)
  const status = useAudioPlayerStatus(player)
  const done = status.duration > 0 ? Math.min(1, status.currentTime / status.duration) : 0
  const toggle = async () => {
    if (status.playing) return player.pause()
    audioMode ??= setAudioModeAsync({ playsInSilentMode: true }).catch(() => {
      audioMode = undefined
    })
    await audioMode
    // A finished file plays again from the start.
    if (status.duration > 0 && status.currentTime >= status.duration - 0.05) void player.seekTo(0)
    player.play()
  }
  return (
    <View
      accessibilityLabel={name}
      style={[styles.audio, { backgroundColor: theme.fill }]}
      testID="chat-audio"
    >
      <IconButton
        accessibilityLabel={status.playing ? `Pause ${name}` : `Play ${name}`}
        icon={status.playing ? 'pause' : 'play'}
        iconSize={18}
        onPress={toggle}
        size={32}
        testID="chat-audio-play"
      />
      <View style={[styles.track, { backgroundColor: theme.hairline }]}>
        <View style={[styles.played, { backgroundColor: theme.text, width: `${done * 100}%` }]} />
      </View>
      <Text tone="muted" variant="caption">
        {clock(status.currentTime)} / {clock(status.duration)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  audio: {
    alignItems: 'center',
    borderRadius: 22,
    flexDirection: 'row',
    gap: 8,
    height: 44,
    paddingLeft: 6,
    paddingRight: 12,
    width: 260
  },
  image: { borderRadius: 16, height: 140, width: 180 },
  fill: { flex: 1 },
  played: { borderRadius: 2, height: 4 },
  track: { borderRadius: 2, flex: 1, height: 4, overflow: 'hidden' },
  video: {
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    borderRadius: 16,
    overflow: 'hidden',
    width: 260
  }
})
