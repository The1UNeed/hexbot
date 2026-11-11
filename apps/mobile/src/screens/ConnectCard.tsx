import { Ionicons } from '@expo/vector-icons'
import { type ReactNode, useState } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'

import { Field, HIT, radius, Text, useTheme } from '../ui'

/**
 * The card a bot waits on to connect something: a plugin to install, turn
 * on or set up, or a site to sign in to. Its head reads like a contact: the
 * icon, the name, one line, and the action or what happened.
 */
export function ConnectCard({
  accessibilityLabel,
  action,
  children,
  icon,
  joined = false,
  status,
  subtitle,
  testID,
  title
}: {
  accessibilityLabel?: string
  action?: ReactNode
  children?: ReactNode
  icon: ReactNode
  /** Right under the bot's own bubble or card: it sits 4 pt below, one stack. */
  joined?: boolean
  status?: ReactNode
  subtitle?: null | string
  testID: string
  title: string
}) {
  const theme = useTheme()

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.card,
        joined && styles.joined,
        { borderColor: theme.hairline, backgroundColor: theme.background }
      ]}
      testID={testID}
    >
      <View style={styles.head}>
        {icon}
        <View style={styles.title}>
          <Text numberOfLines={1} variant="subhead">
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} tone="muted" variant="footnote">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {status ?? action}
      </View>
      {children}
    </View>
  )
}

/** What the user did with a card: done with a check, or declined. */
export function CardStatus({ done, label }: { done: boolean; label: string }) {
  const theme = useTheme()

  return (
    <View style={styles.status}>
      {done ? <Ionicons color={theme.success} name="checkmark" size={14} /> : null}
      <Text style={done ? { color: theme.success } : undefined} tone="muted" variant="footnote">
        {label}
      </Text>
    </View>
  )
}

/** A card's field; a secret one hides what is typed until asked, and a link says where to get one. */
export function CardField({
  autoComplete,
  autoFocus,
  label,
  link,
  onChangeText,
  onSubmitEditing,
  placeholder,
  secret,
  testID,
  textContentType,
  value
}: {
  autoComplete?: 'current-password' | 'off' | 'username'
  autoFocus?: boolean
  label: string
  link?: null | string
  onChangeText: (value: string) => void
  onSubmitEditing?: () => void
  placeholder?: string
  secret?: boolean
  testID: string
  textContentType?: 'none' | 'password' | 'username'
  value: string
}) {
  const theme = useTheme()
  const [shown, setShown] = useState(false)

  return (
    <View style={styles.field}>
      <Field
        autoCapitalize="none"
        autoComplete={autoComplete ?? 'off'}
        autoCorrect={false}
        autoFocus={autoFocus}
        label={label}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        secureTextEntry={secret && !shown}
        testID={testID}
        textContentType={textContentType ?? 'none'}
        value={value}
      />
      <View style={styles.fieldActions}>
        {link ? (
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={() => void Linking.openURL(link)}
            testID={`${testID}-link`}
          >
            <Text tone="accent" variant="footnote">
              Get one
            </Text>
          </Pressable>
        ) : null}
        {secret ? (
          <Pressable
            accessibilityLabel={shown ? `Hide ${label}` : `Show ${label}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setShown(value => !value)}
            testID={`${testID}-show`}
          >
            <Ionicons
              color={theme.muted}
              name={shown ? 'eye-off-outline' : 'eye-outline'}
              size={16}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

export const cardStyles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: HIT, paddingHorizontal: 18 },
  // The head's action: a capsule like the rest, a little tighter.
  headButton: { minHeight: 36, paddingHorizontal: 14 }
})

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginTop: 14,
    maxWidth: '88%',
    padding: 12
  },
  field: { position: 'relative' },
  joined: { marginTop: 4 },
  fieldActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    position: 'absolute',
    right: 0,
    top: 0
  },
  head: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  status: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  title: { flex: 1, minWidth: 0 }
})
