import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { ApiKeyForm } from '../../../web/src/lib/types'
import { Button, Text, useTheme } from '../ui'

import { CardField, CardStatus, ConnectCard, cardStyles } from './ConnectCard'
import type { ApprovalChoice, ApprovalRequestView, CardAnswer } from './types'

/**
 * The API key card a bot shows with `hexbot_passwords`. The key typed goes
 * to the daemon with the answer, which saves it in Passwords for every bot;
 * commands get it in `form.env`. The bot never sees it.
 */
export function ApiKeyCard({
  form,
  joined,
  onAnswer,
  request
}: {
  form: ApiKeyForm
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
  const [key, setKey] = useState('')
  const [sent, setSent] = useState<ApprovalChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const decided = request.decision ?? sent
  const id = request.requestId
  const link = form.url && /^https?:\/\//.test(form.url) ? form.url : null

  // Settled only once the daemon took the answer; a failure keeps the form.
  const answer = async (choice: ApprovalChoice) => {
    setBusy(true)
    try {
      await onAnswer(id, choice, choice === 'deny' ? undefined : { key })
      setSent(choice)
      setKey('')
    } catch {
      // The app shows the error; the form stays for another try.
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConnectCard
      joined={joined}
      accessibilityLabel={decided ? undefined : `Add your ${form.title} API key`}
      action={
        open ? null : (
          <Button
            label="Add key"
            onPress={() => setOpen(true)}
            style={cardStyles.headButton}
            testID={`api-key-${id}-open`}
          />
        )
      }
      icon={
        <View style={[styles.icon, { borderColor: theme.hairline }]}>
          <Ionicons color={theme.muted} name="code-slash-outline" size={18} />
        </View>
      }
      status={
        decided ? (
          <CardStatus done={decided !== 'deny'} label={decided === 'deny' ? 'Not now' : 'Saved'} />
        ) : null
      }
      subtitle={form.update ? `The saved ${form.title} key didn't work` : `API key, as ${form.env}`}
      testID={`api-key-${id}`}
      title={form.title}
    >
      {decided || !open ? null : (
        <>
          <CardField
            autoComplete="off"
            autoFocus
            label="API key"
            link={link}
            onChangeText={setKey}
            onSubmitEditing={() => key.trim() && !busy && void answer('once')}
            secret
            testID={`api-key-${id}-key`}
            textContentType="none"
            value={key}
          />
          <Text tone="muted" variant="footnote">
            Saved in Passwords for your bots. Commands read it from {form.env}; the bot never sees
            it.
          </Text>
          <View style={cardStyles.actions}>
            <Button
              busy={busy}
              disabled={!key.trim()}
              label="Save"
              onPress={() => void answer('once')}
              style={cardStyles.button}
              testID={`api-key-${id}-submit`}
            />
            <Button
              disabled={busy}
              label="Not now"
              onPress={() => void answer('deny')}
              style={[cardStyles.button, { backgroundColor: theme.inset }]}
              testID={`api-key-${id}-cancel`}
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
