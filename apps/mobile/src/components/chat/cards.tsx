/**
 * Cards a turn can stop on, drawn in the transcript like a bot's bubble:
 * an approval (Approve / Allow in this section / Deny, then the outcome),
 * and the Stopped card for a turn that did not finish.
 */

import * as Haptics from 'expo-haptics'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'

import { approvalRespond } from '../../lib/api'
import { toMillis } from '../../lib/time'
import type { ApprovalChoice, ApprovalRequest } from '../../lib/types'
import { transcriptActions, type TranscriptMessage } from '../../stores/transcripts'
import { radii, useTheme } from '../../theme'
import { Icon } from '../icon'

import { MONO } from './markdown'

const BUTTON: Record<ApprovalChoice, string> = {
  always: 'Always allow',
  deny: 'Deny',
  once: 'Approve',
  session: 'Allow in this section'
}

const OUTCOME: Record<ApprovalChoice, string> = {
  always: 'Always allowed',
  deny: 'Denied',
  once: 'Approved',
  session: 'Allowed in this section'
}

/** The card's width: the same column a bot's bubble uses. */
export function useCardWidth() {
  const { width } = useWindowDimensions()

  return Math.min(560, Math.round(width * 0.84))
}

export function CardButton({
  busy,
  disabled,
  label,
  onPress,
  testID,
  tone = 'plain'
}: {
  busy?: boolean
  disabled?: boolean
  label: string
  onPress: () => void
  testID?: string
  tone?: 'danger' | 'plain' | 'primary'
}) {
  const { colors } = useTheme()
  const fill = tone === 'primary' ? colors.primary : colors.bg
  const ink = tone === 'primary' ? colors.primaryText : tone === 'danger' ? colors.danger : colors.text

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: fill, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={ink} size="small" /> : <Text style={[styles.buttonText, { color: ink }]}>{label}</Text>}
    </Pressable>
  )
}

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const { colors } = useTheme()
  const width = useCardWidth()
  const [busy, setBusy] = useState<ApprovalChoice | null>(null)
  const [error, setError] = useState<null | string>(null)

  const choose = async (choice: ApprovalChoice) => {
    setBusy(choice)
    setError(null)
    void Haptics.selectionAsync().catch(() => undefined)

    try {
      await approvalRespond(approval.sessionId, approval.requestId, choice)
      transcriptActions().resolveApproval(approval.sessionId, approval.requestId, choice)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const decided = approval.decision
  const denied = decided === 'deny'

  return (
    <View
      style={[styles.card, { backgroundColor: colors.bubbleBot, borderColor: decided ? 'transparent' : colors.warning, maxWidth: width, width }]}
      testID="approval-card"
    >
      <View style={styles.titleRow}>
        <Icon color={decided ? colors.textMuted : colors.warning} name="hand.raised" size={15} weight="semibold" />
        <Text style={[styles.title, { color: colors.text }]}>Approval needed</Text>
      </View>
      {approval.command ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.command, { backgroundColor: colors.bg }]}>
          <Text selectable style={[styles.commandText, { color: colors.text }]}>
            {approval.command}
          </Text>
        </ScrollView>
      ) : null}
      {approval.reason ? <Text style={[styles.reason, { color: colors.textMuted }]}>{approval.reason}</Text> : null}
      {decided ? (
        <View style={styles.outcome} testID="approval-outcome">
          <Icon color={denied ? colors.danger : colors.success} name={denied ? 'xmark.circle.fill' : 'checkmark.circle.fill'} size={16} />
          <Text style={[styles.outcomeText, { color: denied ? colors.danger : colors.success }]}>{OUTCOME[decided]}</Text>
        </View>
      ) : (
        <View style={styles.buttons}>
          {approval.choices.map(choice => (
            <CardButton
              busy={busy === choice}
              disabled={Boolean(busy) && busy !== choice}
              key={choice}
              label={BUTTON[choice]}
              onPress={() => void choose(choice)}
              testID={`approval-${choice}`}
              tone={choice === 'once' ? 'primary' : choice === 'deny' ? 'danger' : 'plain'}
            />
          ))}
        </View>
      )}
      {error ? <Text style={[styles.reason, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  )
}

/** "notion" -> "Notion", "web_search" -> "Web search", "mcp:github" -> "github". */
export function humanConnector(id: null | string | undefined): string {
  if (!id) {
    return ''
  }

  if (id.startsWith('mcp:')) {
    return id.slice(4)
  }

  const words = id.replace(/_/g, ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A provider error as a sentence: `400: {"message":"…"}` reads as its
 * message. Anything else is shown as sent.
 */
export function errorSentence(error: null | string | undefined): string {
  const text = (error ?? '').trim()
  const match = /^(\d{3}):\s*(\{[\s\S]*\})$/.exec(text)

  if (match) {
    try {
      const body = JSON.parse(match[2]!) as { error?: { message?: string }; message?: string }
      const message = body.message ?? body.error?.message

      if (message) {
        return message
      }
    } catch {
      return text
    }
  }

  return text
}

/** A turn that did not finish: what happened, and Retry. */
export function StoppedCard({
  message,
  name,
  onFix,
  onRetry
}: {
  message: TranscriptMessage
  name: string
  onFix?: (connector: string) => void
  onRetry?: () => void
}) {
  const { colors, dark } = useTheme()
  const width = useCardWidth()
  const connector = message.errorDetail?.connector ?? null
  const connectorName = message.errorDetail?.connectorName ?? humanConnector(connector)
  const time = message.createdAt > 0 ? new Date(toMillis(message.createdAt)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null

  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.card,
        { backgroundColor: dark ? 'rgba(244,100,91,0.10)' : 'rgba(217,45,32,0.06)', borderColor: dark ? 'rgba(244,100,91,0.22)' : 'rgba(217,45,32,0.16)', maxWidth: width, width }
      ]}
      testID="stopped-card"
    >
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: colors.danger }]} />
        <Text style={[styles.title, { color: colors.text, flex: 1 }]}>{name} stopped</Text>
        {time ? <Text style={[styles.time, { color: colors.textMuted }]}>{time}</Text> : null}
      </View>
      <Text selectable style={[styles.reason, { color: colors.text }]}>
        {errorSentence(message.error)}
      </Text>
      <View style={styles.row}>
        {connector && onFix ? <CardButton label={`Fix ${connectorName}`} onPress={() => onFix(connector)} tone="primary" /> : null}
        {onRetry ? <CardButton label="Retry" onPress={onRetry} testID="stopped-retry" /> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', borderRadius: radii.pill, height: 40, justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  buttons: { gap: 8, marginTop: 4 },
  card: { borderRadius: radii.bubble, borderWidth: StyleSheet.hairlineWidth, gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  command: { borderRadius: 12, flexGrow: 0 },
  commandText: { fontFamily: MONO, fontSize: 13.5, lineHeight: 19, paddingHorizontal: 12, paddingVertical: 10 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  outcome: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 2 },
  outcomeText: { fontSize: 15, fontWeight: '600' },
  reason: { fontSize: 15, lineHeight: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  time: { fontSize: 13 },
  title: { fontSize: 16, fontWeight: '600' },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }
})
