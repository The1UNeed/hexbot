import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { splitAddresses } from '../../../web/src/lib/addresses'
import { forgetUnsentDraft, unsentDrafts as unsent } from '../../../web/src/lib/draft-card'
import type { EmailDraft, EmailDraftForm } from '../../../web/src/lib/types'
import { Button, radius, Text, useTheme } from '../ui'
import { PluginIcon } from '../ui/PluginIcon'

import { CardStatus, ConnectCard, cardStyles } from './ConnectCard'
import type { ApprovalChoice, ApprovalRequestView, CardAnswer } from './types'

/**
 * The draft card a bot shows with `hexbot_mail`, as on the desktop: the
 * user changes anything, then sends it or saves it to Drafts with their own
 * tap. The bot can't send without it. Discard tells the bot nothing went
 * out, and the user can ask it for another draft in the chat.
 */
export function EmailDraftCard({
  form,
  joined,
  onAnswer,
  request
}: {
  form: EmailDraftForm
  joined?: boolean
  onAnswer: (
    requestId: string,
    choice: ApprovalChoice,
    answer?: CardAnswer
  ) => Promise<unknown> | void
  request: ApprovalRequestView
}) {
  const theme = useTheme()
  const kept = unsent.get(request.requestId) ?? {}
  const keep =
    (key: 'bcc' | 'body' | 'cc' | 'subject' | 'to', set: (value: string) => void) =>
    (value: string) => {
      unsent.set(request.requestId, { ...unsent.get(request.requestId), [key]: value })
      set(value)
    }
  const [to, setTo] = useState(kept.to ?? form.to.join(', '))
  const [cc, setCc] = useState(kept.cc ?? form.cc.join(', '))
  const [bcc, setBcc] = useState(kept.bcc ?? form.bcc.join(', '))
  const [copies, setCopies] = useState(Boolean(cc || bcc))
  const [subject, setSubject] = useState(kept.subject ?? form.subject)
  const [body, setBody] = useState(kept.body ?? form.body)
  const [sent, setSent] = useState<'deny' | 'save' | 'send' | null>(null)
  const [busy, setBusy] = useState<'deny' | 'save' | 'send' | null>(null)
  const id = request.requestId

  const draft: EmailDraft = {
    bcc: splitAddresses(bcc),
    body,
    cc: splitAddresses(cc),
    reply_to: form.reply_to ?? null,
    subject: subject.trim(),
    to: splitAddresses(to)
  }
  const nobody = draft.to.length + draft.cc.length + draft.bcc.length === 0
  const decided = sent ?? (request.decision === 'deny' ? 'deny' : request.decision ? 'send' : null)

  // Settled only once the daemon took the answer; a failure keeps the draft.
  const answer = async (action: 'deny' | 'save' | 'send') => {
    setBusy(action)
    try {
      await (action === 'deny'
        ? onAnswer(id, 'deny')
        : onAnswer(id, 'once', { draft, mail_action: action }))
      setSent(action)
      forgetUnsentDraft(id)
    } catch {
      // The app shows the error; the draft stays for another try.
    } finally {
      setBusy(null)
    }
  }

  const icon = (
    <PluginIcon icon={form.service === 'google' ? 'gmail' : 'microsoftoutlook'} size={22} />
  )

  // Answered: what happened, then the email as it went.
  if (decided) {
    forgetUnsentDraft(id)
    return (
      <ConnectCard
        joined={joined}
        icon={icon}
        status={
          <CardStatus
            done={decided !== 'deny'}
            label={
              decided === 'deny' ? 'Not sent' : decided === 'save' ? 'Saved to Drafts' : 'Sent'
            }
          />
        }
        subtitle={draft.to.length ? `To ${draft.to.join(', ')}` : undefined}
        testID={`email-draft-${id}`}
        title={subject || 'No subject'}
      />
    )
  }

  // Unanswered: a compose window. Plain rows split by hairlines, the message
  // as plain text, and the sender beside the buttons.
  const line = { borderBottomColor: theme.hairline, borderBottomWidth: StyleSheet.hairlineWidth }
  const input = [styles.input, { color: theme.text }]
  return (
    <View
      accessibilityLabel={`Email draft to ${form.to.join(', ') || 'nobody yet'}`}
      style={[
        styles.card,
        joined && styles.joined,
        { backgroundColor: theme.background, borderColor: theme.hairline }
      ]}
      testID={`email-draft-${id}`}
    >
      <View style={[styles.row, line]}>
        <Text style={styles.label} tone="muted" variant="footnote">
          To
        </Text>
        <TextInput
          accessibilityLabel="To"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={keep('to', setTo)}
          placeholderTextColor={theme.faint}
          style={[input, styles.lineInput]}
          testID={`email-draft-${id}-to`}
          value={to}
        />
        {copies ? null : (
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => setCopies(true)}
            testID={`email-draft-${id}-copies`}
          >
            <Text tone="muted" variant="footnote">
              Cc
            </Text>
          </Pressable>
        )}
      </View>
      {copies
        ? (
            [
              ['Cc', cc, keep('cc', setCc)],
              ['Bcc', bcc, keep('bcc', setBcc)]
            ] as const
          ).map(([label, value, change]) => (
            <View key={label} style={[styles.row, line]}>
              <Text style={styles.label} tone="muted" variant="footnote">
                {label}
              </Text>
              <TextInput
                accessibilityLabel={label}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                onChangeText={change}
                style={[input, styles.lineInput]}
                testID={`email-draft-${id}-${label.toLowerCase()}`}
                value={value}
              />
            </View>
          ))
        : null}
      <TextInput
        accessibilityLabel="Subject"
        onChangeText={keep('subject', setSubject)}
        placeholder="Subject"
        placeholderTextColor={theme.faint}
        style={[input, styles.subject, line]}
        testID={`email-draft-${id}-subject`}
        value={subject}
      />
      <TextInput
        accessibilityLabel="Message"
        multiline
        onChangeText={keep('body', setBody)}
        style={[input, styles.body]}
        testID={`email-draft-${id}-body`}
        textAlignVertical="top"
        value={body}
      />
      <View style={styles.footer}>
        {icon}
        <Text numberOfLines={1} style={styles.from} tone="muted" variant="footnote">
          {form.from || form.service_name}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          busy={busy === 'deny'}
          disabled={busy !== null}
          label="Discard"
          onPress={() => void answer('deny')}
          size="small"
          testID={`email-draft-${id}-discard`}
          variant="plain"
        />
        <Button
          busy={busy === 'save'}
          disabled={busy !== null}
          label="Save draft"
          onPress={() => void answer('save')}
          size="small"
          testID={`email-draft-${id}-save`}
          variant="plain"
        />
        <Button
          busy={busy === 'send'}
          disabled={nobody || busy !== null}
          label="Send"
          onPress={() => void answer('send')}
          size="small"
          style={cardStyles.headButton}
          testID={`email-draft-${id}-send`}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'flex-end',
    paddingBottom: 12,
    paddingHorizontal: 10
  },
  body: { minHeight: 120, paddingVertical: 10 },
  card: {
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 14,
    maxWidth: '88%',
    overflow: 'hidden'
  },
  footer: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
    paddingHorizontal: 14
  },
  from: { flex: 1 },
  input: { flex: 1, fontSize: 16, paddingHorizontal: 14, paddingVertical: 10 },
  joined: { marginTop: 4 },
  label: { paddingLeft: 14, width: 48 },
  lineInput: { paddingLeft: 0 },
  row: { alignItems: 'center', flexDirection: 'row', paddingRight: 14 },
  subject: { flex: 0, fontWeight: '600' }
})
