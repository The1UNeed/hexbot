import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Button, Field, radius, Text, useTheme } from '../ui'

import type { ApprovalChoice, ApprovalRequestView, SignInAnswer } from './types'

/**
 * The secure sign-in card a bot shows with `hexbot_passwords`. What the user
 * types goes to the daemon with the answer, which saves it in Passwords for
 * every bot and types it into the page; the bot never sees it.
 */
export function SignInCard({
  form,
  onAnswer,
  request
}: {
  form: NonNullable<ApprovalRequestView['form']>
  onAnswer: (
    requestId: string,
    choice: ApprovalChoice,
    signIn?: SignInAnswer
  ) => Promise<unknown> | void
  request: ApprovalRequestView
}) {
  const theme = useTheme()
  const [username, setUsername] = useState(form.username ?? '')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState<ApprovalChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const decided = request.decision ?? sent
  const id = request.requestId

  // Settled only once the daemon took the answer; a failure keeps the form.
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true)
    try {
      await onAnswer(id, choice, choice === 'deny' ? undefined : { username, password })
      setSent(choice)
      setPassword('')
    } catch {
      // The app shows the error; the form stays for another try.
    } finally {
      setBusy(false)
    }
  }

  return (
    <View
      accessibilityLabel={decided ? undefined : `Sign in to ${form.title}`}
      style={[styles.card, { borderColor: theme.hairline, backgroundColor: theme.background }]}
      testID={`sign-in-${id}`}
    >
      <View style={styles.head}>
        <View style={[styles.icon, { borderColor: theme.hairline }]}>
          <Ionicons color={theme.muted} name="key-outline" size={18} />
        </View>
        <View style={styles.title}>
          <Text numberOfLines={1} variant="subhead">
            Sign in to {form.title}
          </Text>
          <Text tone="muted" variant="footnote">
            Secure form
          </Text>
        </View>
        {decided ? (
          <View style={styles.decision}>
            {decided === 'deny' ? null : (
              <Ionicons color={theme.success} name="checkmark" size={14} />
            )}
            <Text
              style={decided === 'deny' ? undefined : { color: theme.success }}
              tone="muted"
              variant="footnote"
            >
              {decided === 'deny' ? 'Cancelled' : 'Submitted'}
            </Text>
          </View>
        ) : null}
      </View>
      {decided ? null : (
        <>
          {form.update ? (
            <Text tone="muted" variant="footnote">
              The saved password for {form.site} didn't work. Enter the current one.
            </Text>
          ) : null}
          <Field
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect={false}
            label="Username or email"
            onChangeText={setUsername}
            testID={`sign-in-${id}-username`}
            textContentType="username"
            value={username}
          />
          <Field
            autoCapitalize="none"
            autoComplete="current-password"
            autoCorrect={false}
            label="Password"
            onChangeText={setPassword}
            onSubmitEditing={() => password && !busy && void answer('once')}
            secureTextEntry
            testID={`sign-in-${id}-password`}
            textContentType="password"
            value={password}
          />
          <Text tone="muted" variant="footnote">
            Goes straight to {form.site} and into Passwords for your bots. The bot never sees it.
          </Text>
          <View style={styles.actions}>
            <Button
              busy={busy}
              disabled={!password}
              label="Sign in"
              onPress={() => void answer('once')}
              style={styles.button}
              testID={`sign-in-${id}-submit`}
            />
            <Button
              disabled={busy}
              label="Cancel"
              onPress={() => void answer('deny')}
              style={[styles.button, { backgroundColor: theme.inset }]}
              testID={`sign-in-${id}-cancel`}
              variant="secondary"
            />
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 18 },
  card: {
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    marginTop: 14,
    maxWidth: '92%',
    padding: 14
  },
  decision: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  head: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  icon: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: 'center',
    width: 36
  },
  title: { flex: 1, minWidth: 0 }
})
