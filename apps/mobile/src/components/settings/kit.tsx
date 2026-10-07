/**
 * Small pieces the settings pages share on top of the grouped list kit in
 * `components/list.tsx`: the page's one muted line, a notice, a pill button
 * for a row's one control, a state chip, a choice row whose explanation is
 * never cut off, and a plain row container for content the list kit's `Row`
 * does not draw (faces, monospace values).
 */

import Constants from 'expo-constants'
import { router } from 'expo-router'
import { type ReactNode, useEffect, useRef } from 'react'
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'

import { useConnection } from '../../stores/connection'
import { type Palette, useTheme } from '../../theme'
import { Icon } from '../icon'
import { LIST_INSET } from '../list'

/** An error as one short sentence; a dropped connection reads the same everywhere. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return /websocket|not connected|timed out|network request failed/i.test(message) ? 'Hexbot could not reach the daemon.' : message
}

/** Call `load` again whenever this phone reconnects to the daemon, so a page that failed offline fills in. */
export function useOnReconnect(load: () => unknown): void {
  const status = useConnection(state => state.status)
  const last = useRef(status)

  useEffect(() => {
    if (status === 'connected' && last.current !== 'connected') {
      load()
    }

    last.current = status
  }, [load, status])
}

export const MONO = Platform.select({ default: 'monospace', ios: 'Menlo' })

/** Close a sheet; one opened from a link with nothing under it lands on the home list. */
export function closeSheet(): void {
  if (router.canGoBack()) {
    router.back()
  } else {
    router.replace('/')
  }
}

/** This app's version, from app.json. */
export const appVersion = () => Constants.expoConfig?.version ?? '—'

/** The page's one muted line, under the header and above the first group. */
export function Lead({ children }: { children: ReactNode }) {
  const { colors } = useTheme()

  return <Text style={[styles.lead, { color: colors.textMuted }]}>{children}</Text>
}

/** A warning or a status the user should know about, tinted, never boxed in a card. */
export function Notice({ children, testID, tone = 'warning' }: { children: ReactNode; testID?: string; tone?: 'danger' | 'info' | 'warning' }) {
  const { colors } = useTheme()
  const ink = tone === 'danger' ? colors.danger : tone === 'info' ? colors.textMuted : colors.warning
  const icon = tone === 'info' ? 'arrow.triangle.2.circlepath' : 'exclamationmark.triangle'

  return (
    <View accessibilityRole={tone === 'danger' ? 'alert' : 'text'} style={[styles.notice, { backgroundColor: tint(ink, 0.1) }]} testID={testID}>
      <View style={styles.noticeIcon}>
        <Icon color={ink} name={icon} size={15} weight="semibold" />
      </View>
      <Text style={[styles.noticeText, { color: ink }]}>{children}</Text>
    </View>
  )
}

/** `#RRGGBB` with an alpha, for tinted fills derived from a token. */
export function tint(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)

  if (!match) {
    return hex
  }

  const value = parseInt(match[1], 16)

  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`
}

/** A row's one control: a small grey pill, or a filled one for the main action. */
export function PillButton({
  children,
  disabled,
  loading,
  onPress,
  testID,
  tone = 'default'
}: {
  children: string
  disabled?: boolean
  loading?: boolean
  onPress: () => void
  testID?: string
  tone?: 'danger' | 'default' | 'primary'
}) {
  const { colors } = useTheme()
  const fill = tone === 'primary' ? colors.primary : colors.surface3
  const ink = tone === 'primary' ? colors.primaryText : tone === 'danger' ? colors.danger : colors.text

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled }}
      disabled={disabled || loading}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, { backgroundColor: fill, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      {loading ? <ActivityIndicator color={ink} size="small" /> : <Text style={[styles.pillText, { color: ink }]}>{children}</Text>}
    </Pressable>
  )
}

/** A person's initials on a disc that stands off the grouped card in both themes. */
export function Initials({ faded, name, size }: { faded?: boolean; name: string; size: number }) {
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
        backgroundColor: colors.bg,
        borderRadius: size / 2,
        height: size,
        justifyContent: 'center',
        opacity: faded ? 0.45 : 1,
        width: size
      }}
    >
      <Text style={{ color: colors.text, fontSize: Math.round(size * 0.37), fontWeight: '600' }}>{initials || '?'}</Text>
    </View>
  )
}

/** A short state on the right of a row: Connected, This phone, Disabled. */
export function Chip({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'success' }) {
  const { colors } = useTheme()
  const ink = tone === 'success' ? colors.success : colors.textMuted

  return (
    <View style={[styles.chip, { backgroundColor: tone === 'success' ? tint(colors.success, 0.12) : colors.surface3 }]}>
      <Text style={[styles.chipText, { color: ink }]}>{children}</Text>
    </View>
  )
}

/** A row the list kit's `Row` cannot draw: any content, the same padding and height. */
export function Cell({
  children,
  onPress,
  style,
  testID
}: {
  children: ReactNode
  onPress?: () => void
  style?: ViewStyle
  testID?: string
}) {
  const { colors } = useTheme()

  if (!onPress) {
    return (
      <View style={[styles.cell, style]} testID={testID}>
        {children}
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.cell, pressed && { backgroundColor: colors.surface3 }, style]}
      testID={testID}
    >
      {children}
    </Pressable>
  )
}

/** One choice with a check, its whole explanation shown (approval modes, themes). */
export function ChoiceRow({
  checked,
  description,
  disabled,
  onPress,
  testID,
  title
}: {
  checked: boolean
  description?: string
  disabled?: boolean
  onPress: () => void
  testID?: string
  title: string
}) {
  const { colors } = useTheme()

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cell, styles.choice, pressed && { backgroundColor: colors.surface3 }, disabled && { opacity: 0.45 }]}
      testID={testID}
    >
      <View style={styles.choiceBody}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {description ? <Text style={[styles.subtitle, { color: colors.textMuted }]}>{description}</Text> : null}
      </View>
      <View style={styles.check}>{checked ? <Icon color={colors.accent} name="checkmark" size={17} weight="semibold" /> : null}</View>
    </Pressable>
  )
}

/** `ListScroll` for pages with text fields: keeps the focused field above the keyboard. */
export function KeyboardListScroll({ bottomOffset = 24, children, testID }: { bottomOffset?: number; children: ReactNode; testID?: string }) {
  return (
    <KeyboardAwareScrollView
      bottomOffset={bottomOffset}
      contentContainerStyle={{ gap: 28, paddingBottom: 48, paddingHorizontal: LIST_INSET, paddingTop: 12 }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      {children}
    </KeyboardAwareScrollView>
  )
}

/** Loading, or the reason a page could not load with a way to try again. */
export function PageState({ error, onRetry }: { error?: null | string; onRetry?: () => void }) {
  const { colors } = useTheme()

  if (!error) {
    return (
      <View style={styles.pageState}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    )
  }

  return (
    <View style={[styles.pageState, { gap: 14 }]}>
      <Text style={[styles.subtitle, { color: colors.textMuted, textAlign: 'center' }]}>{error}</Text>
      {onRetry ? <PillButton onPress={onRetry}>Try again</PillButton> : null}
    </View>
  )
}

export const text = (colors: Palette) =>
  StyleSheet.create({
    mono: { color: colors.text, fontFamily: MONO, fontSize: 15 },
    muted: { color: colors.textMuted, fontSize: 15 },
    subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 19 },
    title: { color: colors.text, fontSize: 17, lineHeight: 22 }
  })

const styles = StyleSheet.create({
  cell: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  check: { alignItems: 'flex-end', width: 22 },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 13, fontWeight: '600' },
  choice: { alignItems: 'center', paddingVertical: 12 },
  choiceBody: { flex: 1, gap: 3 },
  lead: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16 },
  notice: { borderCurve: 'continuous', borderRadius: 18, flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  noticeIcon: { paddingTop: 2 },
  noticeText: { flex: 1, fontSize: 15, lineHeight: 20 },
  pageState: { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 48 },
  pill: { alignItems: 'center', borderRadius: 999, height: 32, justifyContent: 'center', minWidth: 64, paddingHorizontal: 14 },
  pillText: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 14, lineHeight: 19 },
  title: { fontSize: 17, lineHeight: 22 }
})
