import { Ionicons } from '@expo/vector-icons'
import type { ComponentRef, Ref } from 'react'
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native'

import { IconButton } from './Button'
import { Text } from './Text'
import { mono, radius, useTheme } from './theme'

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string
  testID: string
  /** Shown under the field; replaced by `error` when there is one. */
  hint?: string
  error?: string | null
  /** Hide the label visually; it still names the field for VoiceOver. */
  hideLabel?: boolean
  monospace?: boolean
  /** Minimum height for multiline fields, in points. */
  minHeight?: number
  ref?: Ref<ComponentRef<typeof TextInput>>
}

/** A labelled text field on a filled well. */
export function Field({
  error,
  hideLabel,
  hint,
  label,
  minHeight,
  monospace,
  multiline,
  ref,
  testID,
  ...input
}: FieldProps) {
  const theme = useTheme()

  return (
    <View style={styles.field}>
      {hideLabel ? null : (
        <Text nativeID={`${testID}-label`} tone="muted" variant="footnote">
          {label}
        </Text>
      )}
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={hideLabel ? undefined : `${testID}-label`}
        allowFontScaling
        maxFontSizeMultiplier={1.6}
        multiline={multiline}
        placeholderTextColor={theme.faint}
        ref={ref}
        selectionColor={theme.accent}
        style={[
          styles.input,
          {
            backgroundColor: theme.fill,
            borderColor: error ? theme.danger : 'transparent',
            color: theme.text,
            fontFamily: monospace ? mono : undefined,
            fontSize: monospace ? 15 : 17,
            minHeight: minHeight ?? (multiline ? 120 : 50)
          },
          multiline && styles.multiline
        ]}
        testID={testID}
        textAlignVertical={multiline ? 'top' : 'center'}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" tone="danger" variant="footnote">
          {error}
        </Text>
      ) : hint ? (
        <Text tone="muted" variant="footnote">
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

export interface SearchFieldProps {
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  testID: string
}

/** A capsule search field with a clear button. */
export function SearchField({
  onChangeText,
  placeholder = 'Search',
  testID,
  value
}: SearchFieldProps) {
  const theme = useTheme()

  return (
    <View style={[styles.search, { backgroundColor: theme.fill }]}>
      <Ionicons color={theme.muted} name="search" size={18} />
      <TextInput
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        maxFontSizeMultiplier={1.6}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        returnKeyType="search"
        selectionColor={theme.accent}
        style={[styles.searchInput, { color: theme.text }]}
        testID={testID}
        value={value}
      />
      {value ? (
        <IconButton
          accessibilityLabel="Clear search"
          color={theme.muted}
          icon="close-circle"
          iconSize={18}
          onPress={() => onChangeText('')}
          size={32}
          testID={`${testID}-clear`}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  input: {
    borderRadius: radius.field,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  multiline: { lineHeight: 22, paddingTop: 12 },
  search: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 6
  },
  searchInput: { flex: 1, fontSize: 17, minHeight: 44, paddingVertical: 8 }
})
