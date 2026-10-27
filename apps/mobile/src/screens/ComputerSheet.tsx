import { useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View
} from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { ComputerFrame } from '../ComputerFrame'
import { COMPUTER_QUALITIES, computerActivity, screenPlays } from '../core/computer'
import { loadComputerQuality, saveComputerQuality } from '../core/storage'
import type { Bot, ComputerCursor, ComputerQuality, ComputerStatus } from '../core/types'
import {
  BotFace,
  Button,
  ChoiceRow,
  type FaceSource,
  faceForName,
  Group,
  radius,
  resolveFace,
  Row,
  space,
  Text,
  useTheme
} from '../ui'

const native = Platform.OS !== 'web'

/** A bot's cursor stays this long after its last action, then fades; as on the web. */
const CURSOR_STAYS_S = 45
const CLICKS = new Set(['click', 'double_click', 'middle_click', 'right_click'])
const TYPING = new Set(['key', 'type'])
const ARROW =
  'M4.5 3.2 20.4 10a.9.9 0 0 1-.1 1.7l-6.6 1.9-2 6.5a.9.9 0 0 1-1.7.1L3.2 4.5a.9.9 0 0 1 1.3-1.3Z'

const BUSY: Partial<Record<ComputerStatus['state'], string>> = {
  resetting: 'Resetting',
  restarting: 'Restarting',
  starting: 'Starting',
  stopping: 'Turning off'
}

function useReduceMotion() {
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then(setReduce)
      .catch(() => {})
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduce)

    return () => subscription?.remove()
  }, [])

  return reduce
}

/** Seconds since the epoch, moving on every few seconds while cursors show. */
function useClock(running: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    if (!running) return
    setNow(Date.now() / 1000)
    const timer = setInterval(() => setNow(Date.now() / 1000), 5000)

    return () => clearInterval(timer)
  }, [running])

  return now
}

/**
 * One bot's pointer: an arrow in its colour with its face beside it. It
 * glides to where the bot acts, presses and rings on a click, and its face
 * bobs while the bot types. It fades once its bot has been idle a while.
 */
function CursorMark({
  acting,
  cursor,
  face,
  height,
  stale,
  width
}: {
  acting: boolean
  cursor: ComputerCursor
  face: FaceSource
  height: number
  stale: boolean
  width: number
}) {
  const theme = useTheme()
  const reduce = useReduceMotion()
  const color = face.face || !face.imageUri ? resolveFace(face.face ?? faceForName(face.name)).color.value : theme.info
  const x = useRef(new Animated.Value(cursor.x * width)).current
  const y = useRef(new Animated.Value(cursor.y * height)).current
  const shown = useRef(new Animated.Value(0)).current
  const press = useRef(new Animated.Value(1)).current
  const ring = useRef(new Animated.Value(0)).current
  const bob = useRef(new Animated.Value(0)).current
  const ms = (value: number) => (reduce ? 0 : value)

  useEffect(() => {
    const glide = { duration: ms(650), easing: Easing.inOut(Easing.cubic), useNativeDriver: native }
    Animated.parallel([
      Animated.timing(x, { ...glide, toValue: cursor.x * width }),
      Animated.timing(y, { ...glide, toValue: cursor.y * height })
    ]).start()
  }, [cursor.x, cursor.y, width, height])

  useEffect(() => {
    Animated.timing(shown, {
      duration: ms(stale ? 240 : 320),
      easing: Easing.out(Easing.cubic),
      toValue: stale ? 0 : 1,
      useNativeDriver: native
    }).start()
  }, [stale])

  useEffect(() => {
    if (!acting || !CLICKS.has(cursor.action) || reduce) return
    ring.setValue(0)
    // After the glide lands.
    Animated.sequence([
      Animated.delay(560),
      Animated.parallel([
        Animated.timing(ring, { duration: 640, toValue: 1, useNativeDriver: native }),
        Animated.sequence([
          Animated.timing(press, { duration: 140, toValue: 0.78, useNativeDriver: native }),
          Animated.timing(press, { duration: 220, toValue: 1, useNativeDriver: native })
        ])
      ])
    ]).start()
  }, [cursor.at])

  const typing = acting && TYPING.has(cursor.action) && !reduce

  useEffect(() => {
    if (!typing) {
      bob.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { duration: 140, toValue: 1, useNativeDriver: native }),
        Animated.timing(bob, { duration: 140, toValue: 0, useNativeDriver: native })
      ])
    )
    loop.start()

    return () => loop.stop()
  }, [typing])

  return (
    <Animated.View
      accessibilityLabel={`${face.name}'s cursor`}
      accessible
      pointerEvents="none"
      style={[styles.cursor, { opacity: shown, transform: [{ translateX: x }, { translateY: y }] }]}
      testID={`computer-cursor-${cursor.bot}`}
    >
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: color,
            opacity: ring.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.8, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }) }]
          }
        ]}
      />
      <Animated.View style={[styles.arrow, { transform: [{ scale: press }] }]}>
        <Svg height={26} viewBox="0 0 24 24" width={26}>
          <Path d={ARROW} fill={color} stroke="#ffffff" strokeLinejoin="round" strokeWidth={1.8} />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[
          styles.face,
          { transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }] }
        ]}
      >
        <BotFace {...face} mood={acting ? 'working' : 'idle'} size={26} />
      </Animated.View>
    </Animated.View>
  )
}

/** Every bot that acted on the computer lately, where it last acted. */
function Cursors({
  faceFor,
  height,
  status,
  width
}: {
  faceFor: (bot: string) => FaceSource
  height: number
  status: ComputerStatus
  width: number
}) {
  const cursors = status.cursors ?? []
  const now = useClock(cursors.length > 0)

  if (!width) return null

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {cursors.map(cursor => (
        <CursorMark
          acting={status.actor === cursor.bot}
          cursor={cursor}
          face={faceFor(cursor.bot)}
          height={height}
          key={cursor.bot}
          stale={status.actor !== cursor.bot && now - cursor.at > CURSOR_STAYS_S}
          width={width}
        />
      ))}
    </View>
  )
}

/** One line under the screen: what is happening on it, in plain words. */
function caption(status: ComputerStatus, nameOf: (bot: string) => string) {
  const busy = BUSY[status.state]
  if (busy) return `${busy} your bots' computer`
  if (status.control === 'user') return 'You have control. Your bots wait until you give it back.'
  if (status.actor && status.activity) return computerActivity(nameOf(status.actor), status.activity)
  return "Your bots' computer"
}

function confirmReset(action: () => void) {
  const title = "Reset your bots' computer?"
  const body = 'Everything on it is erased, for every bot, and they get a fresh one.'
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title} ${body}`) ?? true) action()
    return
  }
  Alert.alert(title, body, [
    { style: 'cancel', text: 'Cancel' },
    { onPress: action, style: 'destructive', text: 'Reset' }
  ])
}

export interface ComputerSheetProps {
  /** The bot whose chat opened the card; it may not have Computer use yet. */
  bot?: Bot
  bots: Bot[]
  faceOf: (bot: Bot) => FaceSource
  /** The daemon's address, such as `http://192.168.1.10:9119`. */
  origin: null | string
  status: ComputerStatus | null
  call: (method?: string, params?: Record<string, unknown>) => Promise<ComputerStatus>
  /** A link to the screen; it is not a status, so it is never merged into one. */
  view: (control: boolean, quality: ComputerQuality) => Promise<{ path: string }>
  /** Gives `bot` Computer use. */
  onEnable?: () => void
  /** Moves on at every reconnect; a restarted daemon forgets the old link. */
  connects: number
}

/**
 * The bots' shared computer on its own card: the live screen with each bot's
 * cursor, a line saying what is happening, and its controls. Take control
 * lets you use it with your fingers; the bots wait until you give it back.
 */
export function ComputerSheet({
  bot,
  bots,
  call,
  connects,
  faceOf,
  onEnable,
  origin,
  status,
  view
}: ComputerSheetProps) {
  const theme = useTheme()
  const [src, setSrc] = useState<null | string>(null)
  // Measured on a wrapper that is always there, so the cursors know the
  // screen's size however it appears; the screen is 16:10.
  const [width, setWidth] = useState(0)
  const [error, setError] = useState<null | string>(null)
  const running = status?.state === 'running'
  const user = status?.control === 'user'
  const enabled = !bot || (bot.tools ?? []).includes('computer_use')
  const plays = !origin || screenPlays(origin)
  // This phone's choice, read before the first link so it is made only once.
  const [quality, setQuality] = useState<ComputerQuality | null>(null)
  useEffect(() => {
    void loadComputerQuality()
      .catch(() => 'auto' as const)
      .then(setQuality)
  }, [])
  const choose = (next: ComputerQuality) => {
    setQuality(next)
    void saveComputerQuality(next).catch(() => {})
  }

  const act = (method: string, params?: Record<string, unknown>) => {
    setError(null)
    call(method, params).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  // A new link waits for this connection's status, so a hold given back
  // elsewhere while the phone was away is not taken again.
  const [read, setRead] = useState(-1)
  useEffect(() => {
    setError(null)
    call('hexbot.computer.status')
      .then(() => setRead(connects))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [connects])

  // Hand the computer back when the card closes, once a take-over still on
  // its way has landed.
  const holding = useRef(false)
  holding.current = user
  const taking = useRef<Promise<ComputerStatus | undefined>>(Promise.resolve(undefined))
  const take = () => {
    setError(null)
    taking.current = call('hexbot.computer.control', { holder: 'user' }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    })
  }
  useEffect(
    () => () => {
      void taking.current.then(taken => {
        if (holding.current || taken?.control === 'user')
          void call('hexbot.computer.control', { holder: 'bot' }).catch(() => {})
      })
    },
    []
  )

  useEffect(() => {
    setSrc(null)
    if (!running || !origin || !plays || !enabled || !quality || read !== connects) return
    let current = true
    let renew: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      view(user, quality)
        .then(({ path }) => {
          if (!current || !path) return
          // A watching screen needs no sound. The daemon sets size and frame rate.
          setSrc(`${origin}${path}${user ? '' : '&audio=none'}`)
          renew = setTimeout(load, 55 * 60_000)
        })
        .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)))
    void load()

    return () => {
      current = false
      if (renew) clearTimeout(renew)
    }
  }, [running, origin, plays, user, enabled, quality, connects, read])

  const byName = new Map(bots.map(b => [b.name, b]))
  const faceFor = (name: string) => {
    const known = byName.get(name)
    return known ? faceOf(known) : { name }
  }
  const nameOf = (name: string) => byName.get(name)?.display_name ?? name

  if (!status) {
    return (
      <View style={styles.center}>
        {error ? <Text tone="danger">{error}</Text> : <ActivityIndicator />}
      </View>
    )
  }

  const placeholder = (body: string, action?: { label: string; onPress: () => void; testID: string }) => (
    <View style={[styles.screen, styles.placeholder, { backgroundColor: theme.fill }]}>
      <Text align="center" tone="muted" variant="callout">
        {body}
      </Text>
      {action ? <Button label={action.label} onPress={action.onPress} testID={action.testID} /> : null}
    </View>
  )

  if (!status.available)
    return (
      <View style={styles.body}>
        {placeholder(
          "To give your bots a computer, install Cua on the daemon's computer (uv tool install cua) and start Docker."
        )}
      </View>
    )

  if (!enabled)
    return (
      <View style={styles.body}>
        {placeholder(
          `${bot?.display_name ?? 'This bot'} can work on your bots' computer: a Linux desktop you can watch and take over.`,
          onEnable
            ? { label: 'Turn on Computer use', onPress: onEnable, testID: 'computer-enable' }
            : undefined
        )}
      </View>
    )

  const busy = BUSY[status.state]
  const lit = !!status.actor || user

  return (
    <View style={styles.body}>
      <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        {running && !plays ? (
          placeholder(
            "Your bots' screen plays only over a secure connection, and this one is plain HTTP. Connect through Hex Connect to watch it."
          )
        ) : running ? (
          <View
            style={[
              styles.screen,
              { backgroundColor: '#000000' },
              lit && { borderColor: theme.info, borderWidth: 2 }
            ]}
            testID="computer-screen"
          >
            {src ? <ComputerFrame control={user} uri={src} /> : null}
            <Cursors faceFor={faceFor} height={width / 1.6} status={status} width={width} />
          </View>
        ) : busy ? (
          placeholder(
            status.state === 'starting'
              ? `${busy}… The first start downloads the computer, a few GB.`
              : `${busy}…`
          )
        ) : (
          placeholder(
            status.state === 'absent'
              ? 'Your bots get a computer the first time one needs it.'
              : "Your bots' computer is off.",
            { label: 'Turn on', onPress: () => act('hexbot.computer.start'), testID: 'computer-start' }
          )
        )}
      </View>
      <View style={styles.captionLine}>
        {lit ? <View style={[styles.dot, { backgroundColor: theme.info }]} /> : null}
        <Text
          numberOfLines={2}
          style={styles.caption}
          testID="computer-caption"
          tone={lit ? 'text' : 'muted'}
          variant="footnote"
        >
          {caption(status, nameOf)}
        </Text>
      </View>
      {running && (plays || user) ? (
        <Button
          label={user ? 'Give back' : 'Take control'}
          onPress={() => (user ? act('hexbot.computer.control', { holder: 'bot' }) : take())}
          testID="computer-control"
          variant={user ? 'primary' : 'secondary'}
          wide
        />
      ) : null}
      {error || status.error ? (
        <Text tone="danger" variant="footnote">
          {error || status.error}
        </Text>
      ) : null}
      <Group>
        <Row
          disabled={!running || !!busy}
          onPress={() => act('hexbot.computer.restart')}
          testID="computer-restart"
          title="Restart"
        />
        <Row
          disabled={!running || !!busy}
          onPress={() => act('hexbot.computer.stop')}
          testID="computer-stop"
          title="Turn off"
        />
        <Row
          destructive
          disabled={!!busy || status.state === 'absent'}
          onPress={() => confirmReset(() => act('hexbot.computer.reset'))}
          testID="computer-reset"
          title="Reset…"
        />
      </Group>
      <Group title="Quality on this device">
        {COMPUTER_QUALITIES.map(option => (
          <ChoiceRow
            key={option.value}
            onPress={() => choose(option.value)}
            selected={quality === option.value}
            testID={`computer-quality-${option.value}`}
            title={option.label}
          />
        ))}
      </Group>
    </View>
  )
}

const styles = StyleSheet.create({
  arrow: { left: -4, position: 'absolute', top: -3 },
  body: { gap: space.md, padding: space.lg },
  caption: { flex: 1 },
  captionLine: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  center: { alignItems: 'center', padding: space.xl },
  cursor: { height: 0, left: 0, position: 'absolute', top: 0, width: 0 },
  dot: { borderRadius: 3, height: 6, width: 6 },
  face: {
    left: 15,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    top: 15
  },
  placeholder: { alignItems: 'center', gap: space.md, justifyContent: 'center', padding: space.xl },
  ring: {
    borderRadius: 20,
    borderWidth: 2.5,
    height: 40,
    left: -20,
    position: 'absolute',
    top: -20,
    width: 40
  },
  screen: { aspectRatio: 16 / 10, borderRadius: radius.field, overflow: 'hidden', width: '100%' }
})
