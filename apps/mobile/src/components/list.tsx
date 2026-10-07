/**
 * The iOS grouped list, as docs/ui-design.md "Settings windows" describes it:
 * a small muted label, one card with hairline dividers, rows of 52 pt or more
 * that hold a title, an optional second line, and one control on the right.
 * Nothing is nested inside a card.
 *
 * API (stable; do not rename):
 *
 *   <ListScroll>                     ScrollView with the page padding and
 *                                    automatic insets under a large or
 *                                    transparent header. Any ScrollView props.
 *   <Group label? footer? error?>    One card. Children are rows; dividers are
 *                                    drawn between them (null/false skipped).
 *                                    `footer` is a muted line under the card,
 *                                    `error` a red one (shown instead).
 *   <Row title subtitle? value? right? chevron? icon? iconTint?
 *        destructive? disabled? onPress? onLongPress? testID?>
 *                                    The basic row. `value` is muted text on the
 *                                    right; `right` any node (a small button).
 *                                    `chevron` adds the disclosure arrow.
 *                                    `icon` is an SF Symbol name drawn in a
 *                                    28 pt rounded tile (`iconTint` its fill).
 *   <SwitchRow title subtitle? value onValueChange disabled? icon? testID?>
 *                                    Tapping anywhere on the row toggles it;
 *                                    the row is one switch for VoiceOver.
 *   <CheckRow title subtitle? checked onPress disabled? testID?>
 *                                    A choice row with a check on the right.
 *   <TextFieldRow label value onCommit placeholder? secure? multiline?
 *        keyboardType? autoCapitalize? autoCorrect? disabled? testID?>
 *                                    A bare field with its label on the left.
 *                                    Keeps its own draft and calls `onCommit`
 *                                    on blur or return when the text changed;
 *                                    a thrown error shows under the row and
 *                                    the field keeps the draft. Without a
 *                                    `label` the field fills the row.
 *
 *   LIST_INSET  horizontal page padding (16) for anything placed beside groups.
 */

import { Children, Fragment, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View
} from 'react-native'

import { type Palette, useTheme } from '../theme'

import { Icon } from './icon'

export const LIST_INSET = 16
const RADIUS = 24
const ROW_MIN = 52
const ROW_PAD = 16
const TILE = 28

/** The card fill: a grey film on white, a lifted grey on black. */
const cardFill = (colors: Palette) => colors.bubbleBot

export function ListScroll({ children, contentContainerStyle, ...props }: ScrollViewProps) {
  return (
    <ScrollView
      contentContainerStyle={[{ gap: 28, paddingBottom: 48, paddingHorizontal: LIST_INSET, paddingTop: 12 }, contentContainerStyle]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      {...props}
    >
      {children}
    </ScrollView>
  )
}

export interface GroupProps {
  children?: ReactNode
  error?: null | string
  footer?: ReactNode
  label?: string
  testID?: string
}

export function Group({ children, error, footer, label, testID }: GroupProps) {
  const { colors } = useTheme()
  const rows = Children.toArray(children).filter(child => isValidElement(child) || typeof child === 'string')
  const iconInset = rows.some(row => isValidElement(row) && (row.props as { icon?: string }).icon)

  return (
    <View testID={testID}>
      {label ? <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text> : null}
      {rows.length ? (
        <View style={[styles.card, { backgroundColor: cardFill(colors) }]}>
          {rows.map((row, index) => (
            <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
              {index > 0 ? (
                <View
                  style={[
                    styles.divider,
                    { backgroundColor: colors.hairline, marginLeft: iconInset ? ROW_PAD + TILE + 14 : ROW_PAD }
                  ]}
                />
              ) : null}
              {row}
            </Fragment>
          ))}
        </View>
      ) : null}
      {error ? (
        <Text style={[styles.footer, { color: colors.danger }]}>{error}</Text>
      ) : footer ? (
        typeof footer === 'string' ? (
          <Text style={[styles.footer, { color: colors.textMuted }]}>{footer}</Text>
        ) : (
          <View style={styles.footerBox}>{footer}</View>
        )
      ) : null}
    </View>
  )
}

export interface RowProps {
  /** For assistive tech: the row as a whole is a switch or a choice. Set by SwitchRow and CheckRow. */
  checked?: boolean
  chevron?: boolean
  destructive?: boolean
  disabled?: boolean
  icon?: string
  iconTint?: string
  loading?: boolean
  onLongPress?: () => void
  onPress?: () => void
  right?: ReactNode
  role?: 'radio' | 'switch'
  subtitle?: null | string
  testID?: string
  title: string
  value?: null | string
}

export function Row({
  checked,
  chevron,
  destructive,
  disabled,
  icon,
  iconTint,
  loading,
  onLongPress,
  onPress,
  right,
  role,
  subtitle,
  testID,
  title,
  value
}: RowProps) {
  const { colors } = useTheme()
  const interactive = Boolean(onPress || onLongPress) && !disabled
  // A switch row toggles on tap like the switch itself; it does not flash grey.
  const highlight = interactive && role !== 'switch'

  return (
    <Pressable
      accessibilityHint={subtitle ?? undefined}
      accessibilityLabel={value ? `${title}, ${value}` : title}
      accessibilityRole={role ?? (onPress ? 'button' : undefined)}
      accessibilityState={role === 'switch' ? { checked, disabled } : role === 'radio' ? { disabled, selected: checked } : { disabled }}
      disabled={!interactive}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && highlight && { backgroundColor: colors.surface3 }, disabled && { opacity: 0.45 }]}
      testID={testID}
    >
      {icon ? (
        <View style={[styles.tile, { backgroundColor: iconTint ?? colors.surface3 }]}>
          <Icon color={iconTint ? '#FFFFFF' : colors.text} name={icon} size={15} weight="semibold" />
        </View>
      ) : null}
      <View style={styles.body}>
        <Text numberOfLines={2} style={[styles.title, { color: destructive ? colors.danger : colors.text }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={3} style={[styles.subtitle, { color: colors.textMuted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text numberOfLines={1} style={[styles.value, { color: colors.textMuted }]}>
          {value}
        </Text>
      ) : null}
      {loading ? <ActivityIndicator color={colors.textMuted} /> : right}
      {chevron ? <Icon color={colors.textFaint} name="chevron.right" size={13} weight="semibold" /> : null}
    </Pressable>
  )
}

export interface SwitchRowProps {
  disabled?: boolean
  icon?: string
  iconTint?: string
  onValueChange: (value: boolean) => void
  subtitle?: null | string
  testID?: string
  title: string
  value: boolean
}

export function SwitchRow({ disabled, icon, iconTint, onValueChange, subtitle, testID, title, value }: SwitchRowProps) {
  const { colors } = useTheme()

  return (
    <Row
      checked={value}
      disabled={disabled}
      icon={icon}
      iconTint={iconTint}
      onPress={() => onValueChange(!value)}
      right={
        <View importantForAccessibility="no-hide-descendants" style={Platform.OS === 'ios' ? styles.switchBox : undefined}>
          <Switch
            accessibilityElementsHidden
            disabled={disabled}
            onValueChange={onValueChange}
            trackColor={{ false: colors.surface3, true: colors.success }}
            value={value}
          />
        </View>
      }
      role="switch"
      subtitle={subtitle}
      testID={testID}
      title={title}
    />
  )
}

export interface CheckRowProps {
  checked: boolean
  disabled?: boolean
  onPress: () => void
  subtitle?: null | string
  testID?: string
  title: string
}

export function CheckRow({ checked, disabled, onPress, subtitle, testID, title }: CheckRowProps) {
  const { colors } = useTheme()

  return (
    <Row
      checked={checked}
      disabled={disabled}
      onPress={onPress}
      right={
        <View style={{ width: 22 }}>
          {checked ? <Icon color={colors.accent} name="checkmark" size={17} weight="semibold" /> : null}
        </View>
      }
      role="radio"
      subtitle={subtitle}
      testID={testID}
      title={title}
    />
  )
}

export interface TextFieldRowProps {
  autoCapitalize?: TextInputProps['autoCapitalize']
  autoCorrect?: boolean
  disabled?: boolean
  keyboardType?: TextInputProps['keyboardType']
  /** Omit for a field that fills the row (a multiline note inside its own card). */
  label?: string
  multiline?: boolean
  onCommit: (value: string) => Promise<unknown> | unknown
  placeholder?: string
  secure?: boolean
  testID?: string
  value: string
}

export function TextFieldRow({
  autoCapitalize,
  autoCorrect,
  disabled,
  keyboardType,
  label,
  multiline,
  onCommit,
  placeholder,
  secure,
  testID,
  value
}: TextFieldRowProps) {
  const { colors } = useTheme()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<null | string>(null)
  const [saving, setSaving] = useState(false)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) {
      setDraft(value)
    }
  }, [value])

  const commit = async () => {
    focused.current = false

    if (draft === value) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onCommit(draft)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <View>
      <View style={[styles.row, multiline && styles.multiRow, multiline && !label && styles.bareMultiRow]}>
        {label ? <Text style={[styles.title, styles.fieldLabel, { color: colors.text }]}>{label}</Text> : null}
        <TextInput
          accessibilityLabel={label ?? placeholder}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          editable={!disabled}
          keyboardType={keyboardType}
          multiline={multiline}
          onBlur={() => void commit()}
          onChangeText={setDraft}
          onFocus={() => {
            focused.current = true
          }}
          onSubmitEditing={multiline ? undefined : () => void commit()}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          returnKeyType="done"
          secureTextEntry={secure}
          style={[styles.field, { color: colors.text }, !label && styles.bareField, multiline && styles.multiField]}
          testID={testID}
          value={draft}
        />
        {saving ? <ActivityIndicator color={colors.textMuted} /> : null}
      </View>
      {error ? <Text style={[styles.rowError, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bareMultiRow: { paddingBottom: 4, paddingTop: 4 },
  body: { flex: 1, gap: 2, minWidth: 0, paddingVertical: 12 },
  bareField: { textAlign: 'left' },
  card: { borderCurve: 'continuous', borderRadius: RADIUS, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginRight: 0 },
  field: { flex: 1, fontSize: 17, minHeight: 44, paddingVertical: 10, textAlign: 'right' },
  fieldLabel: { flexShrink: 0, marginRight: 12 },
  footer: { fontSize: 13, lineHeight: 18, paddingHorizontal: ROW_PAD, paddingTop: 8 },
  footerBox: { paddingHorizontal: ROW_PAD, paddingTop: 8 },
  label: { fontSize: 13, fontWeight: '500', paddingBottom: 8, paddingHorizontal: ROW_PAD },
  multiField: { flex: 0, minHeight: 88, textAlign: 'left', textAlignVertical: 'top' },
  multiRow: { alignItems: 'stretch', flexDirection: 'column', gap: 0, paddingTop: 12 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: ROW_MIN, paddingHorizontal: ROW_PAD },
  rowError: { fontSize: 13, paddingBottom: 10, paddingHorizontal: ROW_PAD },
  subtitle: { fontSize: 14, lineHeight: 19 },
  // iOS 26 draws the switch 63x28 from its frame's corner; give it that box so rows centre it.
  switchBox: { alignItems: 'flex-start', height: 28, justifyContent: 'flex-start', overflow: 'visible', width: 63 },
  tile: { alignItems: 'center', borderCurve: 'continuous', borderRadius: 8, height: TILE, justifyContent: 'center', width: TILE },
  title: { fontSize: 17, lineHeight: 22 },
  value: { flexShrink: 1, fontSize: 17, maxWidth: '55%', textAlign: 'right' }
})
