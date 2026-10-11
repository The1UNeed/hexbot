import { Image, StyleSheet, View } from 'react-native'
import Svg, { Ellipse, Path } from 'react-native-svg'

import { EYES, FACE_EYES, type FaceMood, type FaceStyle, faceForName, resolveFace } from './faces'
import { Text } from './Text'
import { useTheme } from './theme'

/**
 * One colour per state, the same as the web app: blue while it works, accent
 * when it needs you, red when it stopped, green when it finished and you have
 * not looked yet. Idle draws nothing.
 */
export type BotStatus = 'done' | 'idle' | 'needs_you' | 'stopped' | 'working'

export const STATUS_LABELS: Record<BotStatus, string> = {
  done: 'Done',
  idle: 'Idle',
  needs_you: 'Needs you',
  stopped: 'Stopped',
  working: 'Working'
}

/** Anything that has a face: a bot, or a room member that is a bot. */
export interface FaceSource {
  name: string
  /** Shape and colour; derived from the name when missing. */
  face?: FaceStyle | null
  /** An uploaded avatar, as a `data:` or file URI. */
  imageUri?: string | null
}

/** Mood that suits a status, so the eyes say what the dot says. */
export function moodForStatus(status?: BotStatus): FaceMood {
  switch (status) {
    case 'working':
      return 'working'
    case 'needs_you':
      return 'listening'
    case 'done':
      return 'happy'
    default:
      return 'idle'
  }
}

function useStatusColor(status?: BotStatus) {
  const theme = useTheme()

  switch (status) {
    case 'working':
      return theme.info
    case 'needs_you':
      return theme.accent
    case 'stopped':
      return theme.danger
    case 'done':
      return theme.success
    default:
      return null
  }
}

/** The bare drawing: a shape in a colour with two eyes. */
export function FaceDrawing({
  mood = 'idle',
  size,
  style
}: {
  mood?: FaceMood
  size: number
  style: FaceStyle
}) {
  const { color, shape } = resolveFace(style)
  const eyes = EYES[mood]

  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Path d={shape.path} fill={color.value} />
      <Ellipse
        cx={50 - eyes.gap / 2 - eyes.rx / 2}
        cy={eyes.cy}
        fill={FACE_EYES}
        rx={eyes.rx}
        ry={eyes.ry}
      />
      <Ellipse
        cx={50 + eyes.gap / 2 + eyes.rx / 2}
        cy={eyes.cy}
        fill={FACE_EYES}
        rx={eyes.rx}
        ry={eyes.ry}
      />
    </Svg>
  )
}

export interface BotFaceProps extends FaceSource {
  size?: number
  /** Defaults to one that suits `status`. */
  mood?: FaceMood
  status?: BotStatus
  testID?: string
}

/** A bot's face: its uploaded image, or its generated face, with a status dot. */
export function BotFace({ face, imageUri, mood, name, size = 44, status, testID }: BotFaceProps) {
  const theme = useTheme()
  const dot = useStatusColor(status)
  const dotSize = Math.max(10, Math.round(size * 0.26))
  const label =
    status && status !== 'idle' ? `${name}, ${STATUS_LABELS[status].toLowerCase()}` : name

  return (
    <View
      accessibilityLabel={label}
      accessible
      accessibilityRole="image"
      style={{ height: size, width: size }}
      testID={testID}
    >
      {imageUri ? (
        <Image
          source={{ uri: imageUri }}
          style={{ borderRadius: size / 2, height: size, width: size }}
        />
      ) : (
        <FaceDrawing
          mood={mood ?? moodForStatus(status)}
          size={size}
          style={face ?? faceForName(name)}
        />
      )}
      {dot ? (
        <View
          style={[
            styles.dot,
            {
              backgroundColor: dot,
              borderColor: theme.background,
              borderRadius: dotSize,
              borderWidth: dotSize > 12 ? 2.5 : 2,
              height: dotSize,
              width: dotSize
            }
          ]}
        />
      ) : null}
    </View>
  )
}

/**
 * A room's face: one bot's face for a single bot, otherwise up to four faces
 * in a 2x2 grid, the way the web app draws rooms.
 */
export function RoomFace({
  members,
  name,
  size = 44,
  status,
  testID
}: {
  members: FaceSource[]
  name: string
  size?: number
  status?: BotStatus
  testID?: string
}) {
  const theme = useTheme()
  const dot = useStatusColor(status)
  const dotSize = Math.max(10, Math.round(size * 0.26))

  if (members.length <= 1) {
    const only = members[0] ?? { name }

    return <BotFace {...only} name={name} size={size} status={status} testID={testID} />
  }

  const cell = (size - 2) / 2

  return (
    <View
      accessibilityLabel={name}
      accessibilityRole="image"
      accessible
      style={{ height: size, width: size }}
      testID={testID}
    >
      <View style={styles.grid}>
        {members.slice(0, 4).map((member, index) => (
          <View key={`${member.name}-${index}`} style={{ height: cell, width: cell }}>
            {member.imageUri ? (
              <Image
                source={{ uri: member.imageUri }}
                style={{ borderRadius: cell / 2, height: cell, width: cell }}
              />
            ) : (
              <FaceDrawing size={cell} style={member.face ?? faceForName(member.name)} />
            )}
          </View>
        ))}
      </View>
      {dot ? (
        <View
          style={[
            styles.dot,
            {
              backgroundColor: dot,
              borderColor: theme.background,
              borderRadius: dotSize,
              borderWidth: 2,
              height: dotSize,
              width: dotSize
            }
          ]}
        />
      ) : null}
    </View>
  )
}

/** A person: initials on a neutral disc. */
export function PersonFace({
  name,
  size = 36,
  testID
}: {
  name: string
  size?: number
  testID?: string
}) {
  const theme = useTheme()
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase()

  return (
    <View
      accessibilityLabel={name}
      accessibilityRole="image"
      accessible
      style={[
        styles.person,
        { backgroundColor: theme.fill, borderRadius: size / 2, height: size, width: size }
      ]}
      testID={testID}
    >
      <Text
        maxFontSizeMultiplier={1}
        style={{ fontSize: size * 0.38, fontWeight: '600', lineHeight: size * 0.5 }}
      >
        {initials || '?'}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  dot: { bottom: -1, position: 'absolute', right: -1 },
  grid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  person: { alignItems: 'center', justifyContent: 'center' }
})
