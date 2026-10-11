import { Ionicons } from '@expo/vector-icons'
import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Switch, View } from 'react-native'

import { Text } from './Text'
import { HIT, radius, useTheme } from './theme'

export interface RowProps {
  title: string
  testID: string
  subtitle?: string | null
  /** Small text at the top right, usually a time. */
  meta?: string | null
  leading?: ReactNode
  trailing?: ReactNode
  /** A chevron at the end, for rows that open another view. */
  chevron?: boolean
  onPress?: () => void
  onLongPress?: () => void
  destructive?: boolean
  disabled?: boolean
  selected?: boolean
  /** Lines of subtitle before it truncates. */
  subtitleLines?: number
  accessibilityLabel?: string
  accessibilityHint?: string
}

/** One list row: optional face or icon, a title, a line under it, and a time. */
export function Row({
  accessibilityHint,
  accessibilityLabel,
  chevron,
  destructive,
  disabled,
  leading,
  meta,
  onLongPress,
  onPress,
  selected,
  subtitle,
  subtitleLines = 1,
  testID,
  title,
  trailing
}: RowProps) {
  const theme = useTheme()
  const label = accessibilityLabel ?? [title, subtitle, meta].filter(Boolean).join(', ')
  const interactive = !!(onPress || onLongPress)

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityState={{ disabled: !!disabled, selected }}
      disabled={disabled || !interactive}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.pressed : 'transparent', opacity: disabled ? 0.45 : 1 }
      ]}
      testID={testID}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text
            numberOfLines={1}
            style={[styles.title, destructive && { color: theme.danger }]}
            variant={subtitle ? 'headline' : 'body'}
          >
            {title}
          </Text>
          {meta ? (
            <Text numberOfLines={1} tone="muted" variant="footnote">
              {meta}
            </Text>
          ) : null}
        </View>
        {subtitle ? (
          <Text numberOfLines={subtitleLines} tone="muted" variant="callout">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Ionicons color={theme.faint} name="chevron-forward" size={18} /> : null}
    </Pressable>
  )
}

export interface GroupProps {
  children: ReactNode
  /** A short sentence-case heading above the group. */
  title?: string
  /** A line of help under the group. */
  footer?: string
  /** Rounded inset panel (forms) or flush rows (lists on the home screen). */
  inset?: boolean
  /** Separator indent so lines start at the text, not the face. */
  separatorInset?: number
  testID?: string
}

/** Rows with hairlines between them, optionally inside a rounded panel. */
export function Group({
  children,
  footer,
  inset = true,
  separatorInset = 16,
  testID,
  title
}: GroupProps) {
  const theme = useTheme()
  const rows = Children.toArray(children).filter(isValidElement)

  return (
    <View style={styles.group} testID={testID}>
      {title ? (
        <Text accessibilityRole="header" style={styles.groupTitle} tone="muted" variant="footnote">
          {title}
        </Text>
      ) : null}
      <View style={inset ? [styles.panel, { backgroundColor: theme.surface }] : null}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? (
              <View
                style={{
                  backgroundColor: theme.hairline,
                  height: StyleSheet.hairlineWidth,
                  marginLeft: separatorInset
                }}
              />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <Text style={styles.groupTitle} tone="muted" variant="footnote">
          {footer}
        </Text>
      ) : null}
    </View>
  )
}

export interface SwitchRowProps {
  title: string
  value: boolean
  onValueChange: (value: boolean) => void
  testID: string
  subtitle?: string | null
  leading?: ReactNode
  disabled?: boolean
}

/** A row that is a toggle; the whole row is the switch's label. */
export function SwitchRow({
  disabled,
  leading,
  onValueChange,
  subtitle,
  testID,
  title,
  value
}: SwitchRowProps) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.row, { opacity: disabled ? 0.45 : 1 }]}
      testID={`${testID}-row`}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text tone="muted" variant="footnote">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        disabled={disabled}
        ios_backgroundColor={theme.fill}
        onValueChange={onValueChange}
        testID={testID}
        thumbColor="#ffffff"
        trackColor={{ false: theme.hairline, true: theme.success }}
        value={value}
      />
    </Pressable>
  )
}

/** A row in a pick-one list, with a checkmark on the chosen one. */
export function ChoiceRow({
  disabled,
  leading,
  onPress,
  selected,
  subtitle,
  testID,
  title
}: {
  title: string
  selected: boolean
  onPress: () => void
  testID: string
  subtitle?: string | null
  leading?: ReactNode
  disabled?: boolean
}) {
  const theme = useTheme()

  return (
    <Pressable
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.pressed : 'transparent', opacity: disabled ? 0.45 : 1 }
      ]}
      testID={testID}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text tone="muted" variant="footnote">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.check}>
        {selected ? <Ionicons color={theme.accent} name="checkmark" size={22} /> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 2, justifyContent: 'center', minWidth: 0 },
  check: { alignItems: 'flex-end', width: 24 },
  group: { gap: 6 },
  groupTitle: { paddingHorizontal: 16 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  panel: { borderRadius: radius.card, overflow: 'hidden' },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: HIT + 8,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  title: { flexShrink: 1 },
  titleLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between'
  }
})
