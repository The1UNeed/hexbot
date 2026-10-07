/**
 * A question the bot is waiting on: the question, the choices as rows A, B,
 * C (the first may be Recommended) and a field for your own answer. One tap
 * answers a single-choice question; multi-select and typed answers confirm
 * with Done. An answered question collapses to the chosen line.
 */

import * as Haptics from 'expo-haptics'
import { Fragment, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { clarifyRespond } from '../../lib/api'
import type { ClarifyQuestion, ClarifyRequest } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'
import { radii, useTheme } from '../../theme'
import { Icon } from '../icon'

import { CardButton, useCardWidth } from './cards'

const LETTERS = 'ABCDEFGH'

/** Strip the "(Recommended)" label the tool adds to its first choice. */
export const plainChoice = (choice: string) => choice.replace(/\s*\(Recommended\)\s*$/i, '')

/** What the tool receives: one choice, or the chosen list as a JSON array. */
export function encodeAnswer(question: ClarifyQuestion, chosen: string[], typed: string): string {
  const own = typed.trim()

  if (question.multiSelect) {
    return JSON.stringify(own ? [...chosen, own] : chosen)
  }

  return own || chosen[0] || ''
}

function shownAnswer(answer: string): string {
  try {
    const parsed: unknown = JSON.parse(answer)

    return Array.isArray(parsed) ? parsed.map(String).join(', ') : answer
  } catch {
    return answer
  }
}

function Question({
  answer,
  frozen,
  onAnswer,
  question
}: {
  answer?: string
  frozen: boolean
  onAnswer: (answer: string) => void
  question: ClarifyQuestion
}) {
  const { colors } = useTheme()
  const [chosen, setChosen] = useState<string[]>([])
  const [typed, setTyped] = useState('')

  if (answer !== undefined) {
    return (
      <View style={styles.question}>
        <Text style={[styles.prompt, { color: colors.text }]}>{question.question}</Text>
        <View style={[styles.answered, { backgroundColor: colors.bg }]} testID="clarify-answered">
          <Text numberOfLines={2} style={[styles.answeredText, { color: colors.textMuted }]}>
            {shownAnswer(answer)}
          </Text>
          <Icon color={colors.success} name="checkmark" size={13} weight="semibold" />
        </View>
      </View>
    )
  }

  const pick = (choice: string) => {
    const value = plainChoice(choice)
    void Haptics.selectionAsync().catch(() => undefined)

    if (question.multiSelect) {
      setChosen(items => (items.includes(value) ? items.filter(item => item !== value) : [...items, value]))
    } else {
      onAnswer(value)
    }
  }

  const submitOwn = () => {
    const encoded = encodeAnswer(question, chosen, typed)

    if (encoded && encoded !== '[]') {
      onAnswer(encoded)
    }
  }

  const showDone = question.multiSelect || !question.choices.length || Boolean(typed.trim())

  return (
    <View style={styles.question}>
      <Text style={[styles.prompt, { color: colors.text }]}>{question.question}</Text>
      {question.choices.length ? (
        <View style={[styles.choices, { backgroundColor: colors.bg }]}>
          {question.choices.map((choice, index) => {
            const value = plainChoice(choice)
            const selected = chosen.includes(value)
            const recommended = choice !== value

            return (
              <Fragment key={`${index}-${choice}`}>
                {index > 0 ? <View style={[styles.divider, { backgroundColor: colors.hairline }]} /> : null}
                <Pressable
                  accessibilityRole={question.multiSelect ? 'checkbox' : 'button'}
                  accessibilityState={{ checked: question.multiSelect ? selected : undefined, disabled: frozen }}
                  disabled={frozen}
                  onPress={() => pick(choice)}
                  style={({ pressed }) => [styles.choice, (pressed || selected) && { backgroundColor: colors.surface }]}
                  testID={`clarify-choice-${LETTERS[index] ?? index}`}
                >
                  <View style={[styles.letter, { backgroundColor: selected ? colors.accent : colors.surface2 }]}>
                    {selected ? (
                      <Icon color="#FFFFFF" name="checkmark" size={11} weight="bold" />
                    ) : (
                      <Text style={[styles.letterText, { color: colors.textMuted }]}>{LETTERS[index] ?? index + 1}</Text>
                    )}
                  </View>
                  <Text style={[styles.choiceText, { color: frozen ? colors.textMuted : colors.text }]}>{value}</Text>
                  {recommended ? <Text style={[styles.recommended, { color: colors.textMuted }]}>Recommended</Text> : null}
                </Pressable>
              </Fragment>
            )
          })}
        </View>
      ) : null}
      <View style={styles.own}>
        <TextInput
          accessibilityLabel="Your own answer"
          editable={!frozen}
          onChangeText={setTyped}
          onSubmitEditing={submitOwn}
          placeholder={question.choices.length ? 'Type your own answer' : 'Type your answer'}
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          style={[styles.field, { backgroundColor: colors.bg, color: colors.text }]}
          testID="clarify-own"
          value={typed}
        />
        {showDone ? (
          <CardButton disabled={frozen || (!typed.trim() && chosen.length === 0)} label="Done" onPress={submitOwn} testID="clarify-done" tone="primary" />
        ) : null}
      </View>
    </View>
  )
}

export function ClarifyCard({ clarify }: { clarify: ClarifyRequest }) {
  const { colors } = useTheme()
  const width = useCardWidth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const answer = async (question: ClarifyQuestion, value: string) => {
    if (busy) {
      return
    }

    const key = question.questionId ?? clarify.requestId
    setBusy(true)
    setError(null)

    try {
      await clarifyRespond(clarify.sessionId, clarify.requestId, value, question.questionId)
      transcriptActions().answerClarify(clarify.sessionId, clarify.requestId, key, value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const open = Object.keys(clarify.answers).length < clarify.questions.length

  return (
    <View style={[styles.card, { backgroundColor: colors.bubbleBot, maxWidth: width, width }]} testID="clarify-card">
      {clarify.questions.map(question => (
        <Question
          answer={clarify.answers[question.questionId ?? clarify.requestId]}
          frozen={Boolean(clarify.expired) || busy}
          key={question.questionId ?? question.question}
          onAnswer={value => void answer(question, value)}
          question={question}
        />
      ))}
      {clarify.expired && open ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>The bot stopped waiting. Reply in the message field instead.</Text>
      ) : null}
      {error ? <Text style={[styles.note, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  answered: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  answeredText: { flex: 1, fontSize: 16 },
  card: { borderRadius: radii.bubble, gap: 16, paddingHorizontal: 14, paddingVertical: 12 },
  choice: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 46, paddingHorizontal: 12, paddingVertical: 10 },
  choiceText: { flex: 1, fontSize: 16, lineHeight: 21 },
  choices: { borderRadius: 14, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  field: { borderRadius: 12, flex: 1, fontSize: 16, minHeight: 40, paddingHorizontal: 12, paddingVertical: 9 },
  letter: { alignItems: 'center', borderRadius: 6, height: 22, justifyContent: 'center', width: 22 },
  letterText: { fontSize: 12, fontWeight: '700' },
  note: { fontSize: 14, lineHeight: 19 },
  own: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  prompt: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  question: { gap: 10 },
  recommended: { fontSize: 13 }
})
