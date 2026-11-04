import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { SignInForm } from '../../../web/src/lib/types'
import { Button, useTheme } from '../ui'

import { CardField, CardStatus, ConnectCard, cardStyles } from './ConnectCard'
import type { ApprovalChoice, ApprovalRequestView, CardAnswer } from './types'

/**
 * The secure sign-in card a bot shows with `hexbot_passwords`. The form
 * folds behind Sign in; what the user types goes to the daemon with the
 * answer, which saves it in Passwords for every bot and types it into the
 * page. The bot never sees it.
 */
export function SignInCard({
  form,
  joined,
  onAnswer,
  request
}: {
  form: SignInForm
  joined?: boolean
  onAnswer: (
    requestId: string,
    choice: ApprovalChoice,
    answer?: CardAnswer
  ) => Promise<unknown> | void
  request: ApprovalRequestView
}) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
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
    <ConnectCard
      joined={joined}
      accessibilityLabel={decided ? undefined : `Sign in to ${form.title}`}
      action={
        open ? null : (
          <Button
            label="Sign in"
            onPress={() => setOpen(true)}
            style={cardStyles.headButton}
            testID={`sign-in-${id}-open`}
          />
        )
      }
      icon={
        <View style={[styles.icon, { borderColor: theme.hairline }]}>
          <Ionicons color={theme.muted} name="key-outline" size={18} />
        </View>
      }
      status={
        decided ? (
          <CardStatus done={decided !== 'deny'} label={decided === 'deny' ? 'Not now' : 'Saved'} />
        ) : null
      }
      subtitle={form.update ? `The saved password for ${form.site} didn't work` : form.site}
      testID={`sign-in-${id}`}
      title={form.title}
    >
      {decided || !open ? null : (
        <>
          <CardField
            autoComplete="username"
            autoFocus={!form.username}
            label="Username or email"
            onChangeText={setUsername}
            testID={`sign-in-${id}-username`}
            textContentType="username"
            value={username}
          />
          <CardField
            autoComplete="current-password"
            autoFocus={Boolean(form.username)}
            label="Password"
            onChangeText={setPassword}
            onSubmitEditing={() => password && !busy && void answer('once')}
            secret
            testID={`sign-in-${id}-password`}
            textContentType="password"
            value={password}
          />
          <View style={cardStyles.actions}>
            <Button
              busy={busy}
              disabled={!password}
              label="Sign in"
              onPress={() => void answer('once')}
              style={cardStyles.button}
              testID={`sign-in-${id}-submit`}
            />
            <Button
              disabled={busy}
              label="Not now"
              onPress={() => void answer('deny')}
              style={[cardStyles.button, { backgroundColor: theme.inset }]}
              testID={`sign-in-${id}-cancel`}
              variant="secondary"
            />
          </View>
        </>
      )}
    </ConnectCard>
  )
}

const styles = StyleSheet.create({
  icon: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: 'center',
    width: 36
  }
})
