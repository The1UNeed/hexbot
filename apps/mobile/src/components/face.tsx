/**
 * Bot faces: a shape and a colour with two eyes (lib/avatar-builder.ts). An
 * uploaded image replaces the drawing. A working bot's face bobs; it is the
 * one continuous motion in the app (docs/ui-design.md).
 */

import { Image } from 'expo-image'
import { useEffect } from 'react'
import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'
import Svg, { Ellipse, Path } from 'react-native-svg'

import { type AvatarStyle, avatarSrc, resolveStyle, styleForName } from '../lib/avatar-builder'
import type { Bot, BotStatus, Room } from '../lib/types'
import { useTheme } from '../theme'

export type FaceMood = 'happy' | 'idle' | 'listening' | 'sleeping' | 'working'

const EYES: Record<FaceMood, { cy: number; gap: number; rx: number; ry: number }> = {
  happy: { cy: 46, gap: 19, rx: 4.4, ry: 3 },
  idle: { cy: 48, gap: 18, rx: 3.6, ry: 6.2 },
  listening: { cy: 52, gap: 16, rx: 3.8, ry: 4.6 },
  sleeping: { cy: 50, gap: 18, rx: 4.2, ry: 0.9 },
  working: { cy: 49, gap: 17, rx: 3.2, ry: 4.4 }
}

export function FaceDrawing({ mood = 'idle', size, style }: { mood?: FaceMood; size: number; style: AvatarStyle }) {
  const { color, shape } = resolveStyle(style)
  const eyes = EYES[mood]

  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Path d={shape.path} fill={color.value} />
      <Ellipse cx={50 - eyes.gap / 2 - eyes.rx / 2} cy={eyes.cy} fill="#151517" rx={eyes.rx} ry={eyes.ry} />
      <Ellipse cx={50 + eyes.gap / 2 + eyes.rx / 2} cy={eyes.cy} fill="#151517" rx={eyes.rx} ry={eyes.ry} />
    </Svg>
  )
}

export type DotStatus = 'done' | BotStatus

export function statusColor(status: DotStatus | undefined, colors: ReturnType<typeof useTheme>['colors']): null | string {
  switch (status) {
    case 'done':
      return colors.success
    case 'needs_you':
      return colors.accent
    case 'stopped':
      return colors.danger
    case 'working':
      return colors.working
    default:
      return null
  }
}

export const STATUS_LABEL: Record<Exclude<DotStatus, 'idle'>, string> = {
  done: 'Done',
  needs_you: 'Needs you',
  stopped: 'Stopped',
  working: 'Working'
}

/** The coloured dot on a face's lower right; nothing while idle. */
export function StatusDot({ size, status }: { size: number; status?: DotStatus }) {
  const { colors } = useTheme()
  const color = statusColor(status, colors)

  if (!color) {
    return null
  }

  const dot = Math.max(10, Math.round(size * 0.26))

  return (
    <View
      accessibilityLabel={STATUS_LABEL[status as Exclude<DotStatus, 'idle'>]}
      style={{
        backgroundColor: color,
        borderColor: colors.bg,
        borderRadius: dot,
        borderWidth: 2,
        bottom: -1,
        height: dot,
        position: 'absolute',
        right: -1,
        width: dot
      }}
    />
  )
}

function useBob(active: boolean) {
  const reduced = useReducedMotion()
  const offset = useSharedValue(0)

  useEffect(() => {
    if (active && !reduced) {
      offset.value = withRepeat(withTiming(-2.5, { duration: 700, easing: Easing.inOut(Easing.sin) }), -1, true)
    } else {
      cancelAnimation(offset)
      offset.value = withTiming(0, { duration: 160 })
    }
  }, [active, offset, reduced])

  return useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }))
}

export interface BotFaceProps {
  bot?: Pick<Bot, 'avatar' | 'display_name' | 'name'> | null
  /** Used when there is no bot record (a departed room member). */
  name?: string
  size: number
  status?: DotStatus
  style?: ViewStyle
}

/** A bot's face with its status dot. */
export function BotFace({ bot, name, size, status, style }: BotFaceProps) {
  const image = avatarSrc(bot?.avatar)
  const key = bot?.name ?? name ?? '?'
  const bob = useBob(status === 'working')
  const mood: FaceMood = status === 'working' ? 'working' : status === 'needs_you' ? 'listening' : 'idle'

  return (
    <View accessibilityLabel={bot?.display_name ?? name} accessibilityRole="image" style={[{ height: size, width: size }, style]}>
      <Animated.View style={bob}>
        {image ? (
          <Image source={{ uri: image }} style={{ borderRadius: size / 2, height: size, width: size }} />
        ) : (
          <FaceDrawing mood={mood} size={size} style={styleForName(key)} />
        )}
      </Animated.View>
      <StatusDot size={size} status={status} />
    </View>
  )
}

/** A room's active bot members, in the order they joined. */
export const activeBots = (room: Pick<Room, 'members'>) =>
  room.members.filter(member => member.member_kind === 'bot' && !member.left_at)

/** One face for a one-bot room, otherwise up to four faces in a 2x2 grid. */
export function RoomCluster({
  bots,
  room,
  size,
  status
}: {
  bots: Record<string, Bot>
  room: Pick<Room, 'members' | 'name'>
  size: number
  status?: DotStatus
}) {
  const members = activeBots(room)

  if (members.length <= 1) {
    const id = members[0]?.member_id ?? ''

    return <BotFace bot={bots[id]} name={members[0]?.display_name ?? room.name} size={size} status={status} />
  }

  // Two bots overlap on a diagonal; three or four sit in a 2x2 grid.
  if (members.length === 2) {
    const cell = Math.round(size * 0.66)

    return (
      <View accessibilityLabel={room.name} accessibilityRole="image" style={{ height: size, width: size }}>
        {members.map((member, index) => (
          <BotFace
            bot={bots[member.member_id]}
            key={member.member_id}
            name={member.display_name ?? member.member_id}
            size={cell}
            style={{ left: index === 0 ? 0 : size - cell, position: 'absolute', top: index === 0 ? 0 : size - cell }}
          />
        ))}
        <StatusDot size={size} status={status} />
      </View>
    )
  }

  const gap = Math.max(1, Math.round(size * 0.04))
  const cell = (size - gap) / 2

  return (
    <View accessibilityLabel={room.name} accessibilityRole="image" style={{ height: size, width: size }}>
      <View style={[styles.grid, { gap, height: size, width: size }]}>
        {members.slice(0, 4).map(member => (
          <BotFace bot={bots[member.member_id]} key={member.member_id} name={member.display_name ?? member.member_id} size={cell} />
        ))}
      </View>
      <StatusDot size={size} status={status} />
    </View>
  )
}

/** A person: initials on a neutral disc. */
export function PersonAvatar({ name, size }: { name: string; size: number }) {
  const { colors } = useTheme()
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
      style={{
        alignItems: 'center',
        backgroundColor: colors.surface2,
        borderRadius: size / 2,
        height: size,
        justifyContent: 'center',
        width: size
      }}
    >
      <Text style={{ color: colors.text, fontSize: size * 0.36, fontWeight: '600' }}>{initials || '?'}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' }
})
