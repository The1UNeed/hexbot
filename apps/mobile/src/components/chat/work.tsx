/**
 * What a turn is doing and what it did. While it runs: the bot's bobbing
 * face and muted words at the foot ("Research is thinking"), no spinner.
 * Afterwards: one small muted line ("Worked for 3s") that opens to the
 * steps; a step opens to its arguments and output in monospace. Memory and
 * soul writes get their own marks under the bubble.
 */

import { Image } from 'expo-image'
import { type ReactNode, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

import { avatarSrc, styleForName } from '../../lib/avatar-builder'
import type { Bot, Message, ToolCall } from '../../lib/types'
import { useTheme } from '../../theme'
import { FaceDrawing } from '../face'
import { Icon } from '../icon'

import { MONO } from './markdown'
import { asks, liveStatus, type MemoryMark, memoryMarks, toolLabel, visibleSteps, workShown, workSummary } from './steps'

/** A face with no status dot that bobs while `working`: the one continuous motion in the app. */
export function WorkingFace({ bot, name, size, working = true }: { bot?: Pick<Bot, 'avatar' | 'name'>; name?: string; size: number; working?: boolean }) {
  const reduced = useReducedMotion()
  const offset = useSharedValue(0)
  const image = avatarSrc(bot?.avatar)

  useEffect(() => {
    if (working && !reduced) {
      offset.value = withRepeat(withTiming(-2.5, { duration: 700, easing: Easing.inOut(Easing.sin) }), -1, true)
    } else {
      cancelAnimation(offset)
      offset.value = withTiming(0, { duration: 160 })
    }
  }, [offset, reduced, working])

  const bob = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }))

  return (
    <Animated.View style={[{ height: size, width: size }, bob]}>
      {image ? (
        <Image source={{ uri: image }} style={{ borderRadius: size / 2, height: size, width: size }} />
      ) : (
        <FaceDrawing mood={working ? 'working' : 'idle'} size={size} style={styleForName(bot?.name ?? name ?? '?')} />
      )}
    </Animated.View>
  )
}

const ICONS: Record<string, string> = {
  browser_click: 'cursorarrow',
  browser_navigate: 'globe',
  browser_type: 'keyboard',
  codemode: 'chevron.left.forwardslash.chevron.right',
  cronjob_manage: 'clock',
  delegate_task: 'person.2',
  execute_code: 'chevron.left.forwardslash.chevron.right',
  image_generate: 'photo',
  ls: 'folder',
  patch: 'square.and.pencil',
  read_file: 'doc.text',
  search_files: 'magnifyingglass',
  terminal: 'terminal',
  vision_analyze: 'eye',
  web_extract: 'globe',
  web_search: 'globe',
  write_file: 'square.and.pencil'
}

export const toolIcon = (name: string) => ICONS[name] ?? 'wrench.and.screwdriver'

const format = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/** The text of a tool result: Pi's `{content: [{text}]}`, a string, or JSON. */
function resultText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] } | null)?.content

  if (Array.isArray(content)) {
    return content
      .map(item => item.text ?? '')
      .join('\n')
      .trim()
  }

  return format(result)
}

function StepRow({ call }: { call: ToolCall }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const running = call.status === 'running'

  return (
    <Animated.View layout={LinearTransition.duration(180)} style={call.parentToolCallId ? styles.nested : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}
        testID={`step-${call.name}`}
      >
        <View style={[styles.stepIcon, { backgroundColor: colors.surface2 }]}>
          <Icon color={colors.textMuted} name={toolIcon(call.name)} size={12} />
        </View>
        <Text numberOfLines={1} style={[styles.stepLabel, { color: running ? colors.text : colors.textMuted }]}>
          {toolLabel(call)}
        </Text>
        {running ? (
          <View style={[styles.runningDot, { backgroundColor: colors.working }]} />
        ) : (
          <Icon
            color={call.status === 'error' ? colors.danger : colors.success}
            name={call.status === 'error' ? 'exclamationmark.circle' : 'checkmark'}
            size={12}
            weight="semibold"
          />
        )}
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={styles.detail}>
          {call.args != null ? <Mono text={format(call.args)} /> : null}
          {call.result != null ? <Mono text={resultText(call.result)} /> : null}
        </Animated.View>
      ) : null}
    </Animated.View>
  )
}

function Mono({ text }: { text: string }) {
  const { colors } = useTheme()

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.mono, { backgroundColor: colors.surface }]}>
      <Text selectable style={[styles.monoText, { color: colors.text }]}>
        {text.length > 4000 ? `${text.slice(0, 4000)}…` : text}
      </Text>
    </ScrollView>
  )
}

/** The reasoning trace and the steps, set off by a thin rule on the left. */
function WorkCard({ message }: { message: Message }) {
  const { colors } = useTheme()
  const steps = visibleSteps(message.toolCalls)

  return (
    <Animated.View entering={FadeIn.duration(180)} style={[styles.card, { borderColor: colors.border }]} testID="work-card">
      {message.thinking ? (
        <Text style={[styles.trace, { color: colors.textMuted }]}>{message.thinking.trim()}</Text>
      ) : message.streaming && !steps.length ? (
        <Text style={[styles.trace, { color: colors.textMuted }]}>Nothing to show yet.</Text>
      ) : null}
      {steps.map(call => (
        <StepRow call={call} key={call.toolId} />
      ))}
    </Animated.View>
  )
}

/**
 * The live line at the foot of a running turn. `face` is the bobbing face;
 * rooms pass the speaking bot's. Tap it for the trace and the steps.
 */
export function LiveStatus({ face, message, name }: { face: ReactNode; message: Message; name: string }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const status = liveStatus(message, name)

  // While the bot only waits on a teammate, the ask line says so.
  const asking = !status.call && asks(message).some(ask => ask.status === 'running')
  const label = asking ? `${name} is asking a teammate` : status.label

  return (
    <View style={styles.live}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLiveRegion="polite"
        onPress={() => setOpen(!open)}
        style={styles.liveRow}
        testID="live-status"
      >
        {face}
        <Animated.Text
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(120)}
          key={label}
          numberOfLines={1}
          style={[styles.liveText, { color: colors.textMuted }]}
        >
          {label}
        </Animated.Text>
      </Pressable>
      {open ? <WorkCard message={message} /> : null}
    </View>
  )
}

/** "Worked for 3s ›" under a finished turn; nothing for short or housekeeping-only work. */
export function WorkSummary({ fresh, message, name }: { fresh: boolean; message: Message; name: string }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)

  if (message.streaming || !workShown(message)) {
    return null
  }

  const label = workSummary(message, name)

  if (!label) {
    return null
  }

  return (
    <Animated.View entering={fresh ? FadeIn.duration(220) : undefined} style={styles.summary}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => setOpen(!open)}
        style={styles.summaryRow}
        testID="work-summary"
      >
        <Text style={[styles.summaryText, { color: colors.textMuted }]}>{label}</Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon color={colors.textMuted} name="chevron.right" size={10} weight="semibold" />
        </View>
      </Pressable>
      {open ? <WorkCard message={message} /> : null}
    </Animated.View>
  )
}

const MARK_LABEL: Record<MemoryMark['kind'], string> = { memory: 'Memory updated', soul: 'Soul updated' }

function Mark({ mark }: { mark: MemoryMark }) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[styles.mark, { borderColor: colors.border }]}
      >
        <Icon color={colors.textMuted} name={mark.kind === 'soul' ? 'sparkles' : 'brain'} size={11} />
        <Text style={[styles.markText, { color: colors.textMuted }]}>{MARK_LABEL[mark.kind]}</Text>
      </Pressable>
      {open ? <Mono text={mark.text} /> : null}
    </View>
  )
}

/** A mark under the bubble for every memory or soul write the turn made. */
export function MemoryMarks({ message }: { message: Message }) {
  const marks = memoryMarks(message)

  if (!marks.length) {
    return null
  }

  return (
    <View style={styles.marks} testID="memory-marks">
      {marks.map((mark, index) => (
        <Mark key={`${mark.kind}-${index}`} mark={mark} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderLeftWidth: 2, gap: 2, marginLeft: 12, marginTop: 4, paddingLeft: 10, paddingVertical: 2 },
  detail: { gap: 6, marginBottom: 6, marginLeft: 32 },
  live: { alignItems: 'flex-start' },
  liveRow: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 36, paddingRight: 8 },
  liveText: { flexShrink: 1, fontSize: 15 },
  mark: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 3
  },
  markText: { fontSize: 12 },
  marks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 4, paddingTop: 4 },
  mono: { borderRadius: 10, flexGrow: 0, maxHeight: 220 },
  monoText: { fontFamily: MONO, fontSize: 12, lineHeight: 17, padding: 10 },
  nested: { marginLeft: 20 },
  runningDot: { borderRadius: 3, height: 6, width: 6 },
  step: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 36 },
  stepIcon: { alignItems: 'center', borderRadius: 7, height: 22, justifyContent: 'center', width: 22 },
  stepLabel: { flex: 1, fontSize: 14 },
  summary: { alignItems: 'flex-start', paddingLeft: 4, paddingTop: 4 },
  summaryRow: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 24 },
  summaryText: { fontSize: 13 },
  trace: { fontSize: 14, lineHeight: 20, paddingVertical: 4 }
})
