import { type Ref, useEffect, useId, useRef } from 'react'
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, View } from 'react-native'
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Stop } from 'react-native-svg'

import {
  ballTransform,
  eyePlacements,
  eyeTransform,
  facePose,
  type FaceMood,
  type FaceStyle,
  faceForName,
  CAPSULE_EYE,
  resolveFace
} from './faces'
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

/**
 * The bare drawing: a shape in a colour with two capsule eyes on its ball.
 * `drawing` reaches the picture itself, to save it as a PNG.
 */
export function FaceDrawing({
  drawing,
  mood = 'idle',
  size,
  style
}: {
  drawing?: Ref<Svg>
  mood?: FaceMood
  size: number
  style: FaceStyle
}) {
  const { color, eyes, shape } = resolveFace(style)

  return (
    <Svg height={size} ref={drawing} viewBox="0 0 100 100" width={size}>
      <Path d={shape.path} fill={color.value} />
      <G transform={ballTransform(shape.ball)}>
        <G transform={facePose(mood)}>
          {eyePlacements(mood).map((eye, index) => (
            <Path d={CAPSULE_EYE} fill={eyes} key={index} transform={eyeTransform(eye)} />
          ))}
        </G>
      </G>
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
      ) : mood === 'computer' ? (
        <ComputerFace size={size} style={face ?? faceForName(name)} />
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

/** The pointer a face rides beside on the computer, its tip at the origin, as the web app draws it. */
const POINTER = 'M0 0 26 11a1.5 1.5 0 0 1-.2 2.8L15 17 11.8 27.6a1.5 1.5 0 0 1-2.8.2Z'

/** Where the pointer and its rider rest between moves, in face units; they visit them in turn. */
const CURSOR_STOPS = [
  { x: -6, y: -5 },
  { x: 7, y: -1 },
  { x: -2, y: 6 }
]

/**
 * A bot's face riding beside a pointer, as the web app shows it while the
 * bot uses the computer: the two glide from stop to stop and the pointer
 * dips once at each, as if it clicked. Still when the system asks for
 * reduced motion.
 */
function ComputerFace({ size, style }: { size: number; style: FaceStyle }) {
  const { color } = resolveFace(style)
  const unit = size / 100
  const [first] = CURSOR_STOPS
  const x = useRef(new Animated.Value(first!.x * unit)).current
  const y = useRef(new Animated.Value(first!.y * unit)).current
  const press = useRef(new Animated.Value(1)).current

  useEffect(() => {
    let cancelled = false
    let running: Animated.CompositeAnimation | null = null
    const ease = Easing.inOut(Easing.cubic)

    void (AccessibilityInfo.isReduceMotionEnabled?.() ?? Promise.resolve(false))
      .catch(() => false)
      .then(reduce => {
        if (cancelled || reduce) return
        const legs = CURSOR_STOPS.map((_, index) => {
          const to = CURSOR_STOPS[(index + 1) % CURSOR_STOPS.length]!
          return Animated.sequence([
            Animated.parallel([
              Animated.timing(x, {
                duration: 660,
                easing: ease,
                toValue: to.x * unit,
                useNativeDriver: true
              }),
              Animated.timing(y, {
                duration: 660,
                easing: ease,
                toValue: to.y * unit,
                useNativeDriver: true
              })
            ]),
            Animated.delay(90),
            Animated.timing(press, { duration: 110, toValue: 0.88, useNativeDriver: true }),
            Animated.timing(press, { duration: 110, toValue: 1, useNativeDriver: true }),
            Animated.delay(130)
          ])
        })
        running = Animated.loop(Animated.sequence(legs))
        running.start()
      })

    return () => {
      cancelled = true
      running?.stop()
    }
  }, [press, unit, x, y])

  return (
    <Animated.View
      style={{ height: size, transform: [{ translateX: x }, { translateY: y }], width: size }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale: press }] }]}>
        <Svg height={size} viewBox="0 0 100 100" width={size}>
          <G transform="translate(13 11)">
            <Path d={POINTER} fill={color.value} stroke={color.value} strokeLinejoin="round" strokeWidth={4} />
          </G>
        </Svg>
      </Animated.View>
      <View style={{ left: 35 * unit, position: 'absolute', top: 35 * unit }}>
        <FaceDrawing mood="computer" size={56 * unit} style={style} />
      </View>
    </Animated.View>
  )
}

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse)

/** An ellipse's perimeter (Ramanujan), since react-native-svg has no pathLength. */
const perimeter = (rx: number, ry: number) =>
  Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))

/** The whirl's two bands, as the web app draws them; each sweeps round at its own speed. */
const WHIRL = [
  { dash: 0.55, period: 830, rx: 38, ry: 13, turn: -22, width: 6 },
  { dash: 0.38, period: 1140, rx: 31, ry: 10, turn: 30, width: 4.5 }
].map(band => ({ ...band, length: perimeter(band.rx, band.ry) }))

/**
 * A bot's face folded into a whirl round a dot, as the web app shows it
 * while a chat loads. It fades in late, so a quick read never shows it, and
 * holds still when the system asks for reduced motion.
 */
export function LoadingFace({ face, name, size = 88, testID }: FaceSource & { size?: number; testID?: string }) {
  const { color } = resolveFace(face ?? faceForName(name))
  const gradient = `whirl-${useId().replace(/[^\w-]/g, '')}`
  const shown = useRef(new Animated.Value(0)).current
  const bands = useRef(WHIRL.map(() => new Animated.Value(0))).current

  useEffect(() => {
    let cancelled = false
    let running: Animated.CompositeAnimation | null = null

    void (AccessibilityInfo.isReduceMotionEnabled?.() ?? Promise.resolve(false))
      .catch(() => false)
      .then(reduce => {
        if (cancelled) return
        if (reduce) {
          shown.setValue(1)
          return
        }
        running = Animated.parallel([
          Animated.timing(shown, { delay: 150, duration: 180, toValue: 1, useNativeDriver: false }),
          ...bands.map((band, index) =>
            Animated.loop(
              Animated.timing(band, {
                duration: WHIRL[index]!.period,
                easing: Easing.linear,
                toValue: 1,
                useNativeDriver: false
              })
            )
          )
        ])
        running.start()
      })

    return () => {
      cancelled = true
      running?.stop()
    }
  }, [bands, shown])

  return (
    <Animated.View
      accessibilityLabel={`Opening ${name}'s chat`}
      accessibilityRole="progressbar"
      accessible
      style={{ height: size, opacity: shown, width: size }}
      testID={testID}
    >
      <Svg height={size} viewBox="0 0 100 100" width={size}>
        <Defs>
          <LinearGradient id={gradient} x1={0} x2={1} y1={0} y2={0.3}>
            {[0.3, 1, 0.6].map((opacity, index) => (
              <Stop key={index} offset={index / 2} stopColor={color.value} stopOpacity={opacity} />
            ))}
          </LinearGradient>
        </Defs>
        {WHIRL.map(({ dash, length, rx, ry, turn, width }, index) => (
          <G key={index} transform={`translate(50 52) rotate(${turn})`}>
            <AnimatedEllipse
              fill="none"
              rx={rx}
              ry={ry}
              stroke={`url(#${gradient})`}
              strokeDasharray={[dash * length, (1 - dash) * length]}
              strokeDashoffset={bands[index]!.interpolate({
                inputRange: [0, 1],
                outputRange: [0, length]
              })}
              strokeLinecap="round"
              strokeWidth={width}
            />
          </G>
        ))}
        <Circle cx={50} cy={52} fill={color.value} r={7} />
      </Svg>
    </Animated.View>
  )
}

/**
 * A room's face: one bot's face for a single bot, two overlapping on a
 * diagonal, otherwise up to four faces in a 2x2 grid.
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

  // Two faces overlap on a diagonal, like a group chat; three or four tile.
  const pair = members.length === 2
  const cell = pair ? Math.round(size * 0.64) : (size - 2) / 2

  return (
    <View
      accessibilityLabel={name}
      accessibilityRole="image"
      accessible
      style={{ height: size, width: size }}
      testID={testID}
    >
      <View style={pair ? styles.fill : styles.grid}>
        {members.slice(0, 4).map((member, index) => (
          <View
            key={`${member.name}-${index}`}
            style={[
              { height: cell, width: cell },
              pair &&
                (index
                  ? {
                      backgroundColor: theme.background,
                      borderRadius: cell,
                      boxSizing: 'content-box',
                      left: size - cell - 2,
                      padding: 2,
                      position: 'absolute',
                      top: size - cell - 2
                    }
                  : { left: 0, position: 'absolute', top: 0 })
            ]}
          >
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
  fill: { flex: 1 },
  grid: {
    alignContent: 'center',
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    justifyContent: 'center'
  },
  person: { alignItems: 'center', justifyContent: 'center' }
})
