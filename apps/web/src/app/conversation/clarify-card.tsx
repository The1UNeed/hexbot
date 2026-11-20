import { Check } from 'lucide-react'
import { useState } from 'react'

import { useFaceColor } from '../../components/ui/avatar'
import { Button } from '../../components/ui/button'
import { clarifyAnswered, clarifyRespond } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { Bot, ClarifyQuestion, ClarifyRequest } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

import { botBubbleStyle } from './index'

const LETTERS = 'ABCDEFGH'

/** Strip the "(Recommended)" label the tool adds to its first choice. */
export const plainChoice = (choice: string) => choice.replace(/\s*\(Recommended\)\s*$/i, '')

/** What the tool receives: one choice, or the chosen list as a JSON array. */
export function encodeAnswer(question: ClarifyQuestion, chosen: string[], typed: string): string {
  const own = typed.trim()

  if (question.multiSelect) {
    const all = own ? [...chosen, own] : chosen

    return JSON.stringify(all)
  }

  return own || chosen[0] || ''
}

const rowClass =
  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-[length:var(--text-body)] transition-colors hover:bg-surface-3/50 disabled:pointer-events-none'

const letterClass =
  'grid size-5 shrink-0 place-items-center rounded-[5px] bg-surface-3 text-[11px] font-semibold text-muted'

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
  const [chosen, setChosen] = useState<string[]>([])
  const [typed, setTyped] = useState('')

  if (answer !== undefined) {
    let shown = answer

    try {
      const parsed: unknown = JSON.parse(answer)
      shown = Array.isArray(parsed) ? parsed.map(String).join(', ') : answer
    } catch {
      // A plain answer is not JSON; show it as typed.
    }

    return (
      <div className="grid gap-2">
        <div className="font-medium">{question.question}</div>
        <div className="flex min-w-0 items-center gap-3 rounded-[12px] bg-surface-3/50 px-3 py-2 text-muted">
          <span className="min-w-0 flex-1 truncate" title={shown}>
            {shown}
          </span>
          <Check className="shrink-0" size={14} />
        </div>
      </div>
    )
  }

  const pick = (choice: string) => {
    const value = plainChoice(choice)

    if (question.multiSelect) {
      setChosen(items =>
        items.includes(value) ? items.filter(item => item !== value) : [...items, value]
      )
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

  return (
    <div className="grid gap-2">
      <div className="font-medium">{question.question}</div>
      {question.choices.length ? (
        <div
          className="divide-y divide-border overflow-hidden rounded-[12px] bg-background/80"
          role={question.multiSelect ? 'group' : 'listbox'}
        >
          {question.choices.map((choice, index) => {
            const value = plainChoice(choice)
            const selected = chosen.includes(value)

            return (
              <button
                aria-pressed={question.multiSelect ? selected : undefined}
                className={cn(rowClass, selected && 'bg-accent/10')}
                disabled={frozen}
                key={`${index}-${choice}`}
                onClick={() => pick(choice)}
                role={question.multiSelect ? undefined : 'option'}
                type="button"
              >
                <span className={cn(letterClass, selected && 'bg-accent text-accent-fg')}>
                  {selected ? <Check size={12} /> : (LETTERS[index] ?? index + 1)}
                </span>
                <span className="min-w-0 flex-1">{value}</span>
                {/^\(Recommended\)/i.test(choice.slice(value.length).trim()) ? (
                  <span className="text-[length:var(--text-meta)] text-muted">Recommended</span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault()
          submitOwn()
        }}
      >
        <input
          aria-label="Your own answer"
          className="h-9 min-w-0 flex-1 rounded-[12px] border border-border bg-background px-3 text-[length:var(--text-body)] outline-none placeholder:text-muted focus-visible:border-foreground/40 disabled:opacity-50"
          disabled={frozen}
          onChange={event => setTyped(event.target.value)}
          placeholder={question.choices.length ? 'Type your own answer' : 'Type your answer'}
          value={typed}
        />
        {question.multiSelect || !question.choices.length || typed.trim() ? (
          <Button
            disabled={frozen || (!typed.trim() && chosen.length === 0)}
            size="md"
            type="submit"
            variant="primary"
          >
            Done
          </Button>
        ) : null}
      </form>
    </div>
  )
}

/** An answer as a person writes it: a chosen list reads as words, not JSON. */
function spoken(answer: string): string {
  try {
    const parsed: unknown = JSON.parse(answer)

    if (Array.isArray(parsed)) {
      return parsed.map(String).join(', ')
    }
  } catch {
    // A plain answer is not JSON.
  }

  return answer
}

/**
 * The message that answers a question the bot stopped waiting on: the answer
 * alone, or each question of a batch with its answer.
 */
export function replyText(clarify: ClarifyRequest, answers: Record<string, string>): string {
  const keyOf = (question: ClarifyQuestion) => question.questionId ?? clarify.requestId

  if (clarify.questions.length === 1) {
    return spoken(answers[keyOf(clarify.questions[0]!)] ?? '')
  }

  return clarify.questions
    .map(question => `${question.question}\n${spoken(answers[keyOf(question)] ?? '')}`)
    .join('\n\n')
}

/**
 * A question the bot is waiting on, drawn like its messages (washed with its
 * face colour) with options A/B/C… and a field for your own answer. Answered questions collapse to
 * the chosen line; a batch keeps asking until every question is locked.
 *
 * When the bot stopped waiting (Stop, or the daemon restarting for an
 * update), `onReply` keeps the card usable: the answer goes as your next
 * message, as if typed in the message field.
 */
export function ClarifyCard({
  bot,
  clarify,
  onReply
}: {
  bot?: Bot
  clarify: ClarifyRequest
  onReply?: (text: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Answers to a batch the bot stopped waiting on, held until all are in.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const color = useFaceColor(bot, bot ? bot.display_name : null)
  const stopped = Boolean(clarify.expired) && !clarifyAnswered(clarify)
  const replying = stopped && Boolean(onReply)
  const answers = replying ? { ...clarify.answers, ...drafts } : clarify.answers

  const answer = async (question: ClarifyQuestion, value: string) => {
    if (busy) {
      return
    }

    const key = question.questionId ?? clarify.requestId

    if (replying) {
      const next = { ...drafts, [key]: value }

      if (clarifyAnswered({ ...clarify, answers: { ...clarify.answers, ...next } })) {
        setDrafts({})
        onReply!(replyText(clarify, { ...clarify.answers, ...next }))
      } else {
        setDrafts(next)
      }

      return
    }

    setBusy(true)

    try {
      await clarifyRespond(clarify.sessionId, clarify.requestId, value, question.questionId)
      transcriptActions().answerClarify(clarify.sessionId, clarify.requestId, key, value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="hex-bubble grid min-w-0 max-w-[min(85%,40rem)] flex-1 gap-4 rounded-[20px] bg-bubble px-4 py-3"
      data-testid="clarify-card"
      style={botBubbleStyle(color)}
    >
      {clarify.questions.map(question => {
        const key = question.questionId ?? clarify.requestId

        return (
          <Question
            answer={Object.hasOwn(answers, key) ? answers[key] : undefined}
            frozen={(stopped && !replying) || busy}
            key={question.questionId ?? question.question}
            onAnswer={value => void answer(question, value)}
            question={question}
          />
        )
      })}
      {stopped ? (
        <p className="text-[length:var(--text-secondary)] text-muted">
          {replying
            ? 'The bot stopped waiting. Your answer goes as a new message.'
            : 'The bot stopped waiting.'}
        </p>
      ) : null}
      {error ? (
        <p className="text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
