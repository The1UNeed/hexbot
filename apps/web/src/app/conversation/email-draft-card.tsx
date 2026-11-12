import { type KeyboardEvent, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { ConnectorIcon } from '../../components/ui/connector-icon'
import { splitAddresses } from '../../lib/addresses'
import { approvalRespond } from '../../lib/api'
import { cn } from '../../lib/cn'
import {
  draftAnswerError,
  draftIcon,
  forgetUnsentDraft,
  unsentDrafts as unsent
} from '../../lib/draft-card'
import type { ApprovalRequest, EmailDraft, EmailDraftForm } from '../../lib/types'
import { transcriptActions } from '../../stores/transcripts'

import { CardStatus } from './connect-card'

/**
 * The draft card a bot shows with `hexbot_mail`. The user changes anything,
 * then sends it or saves it to Drafts with their own click; the bot can't
 * send without it. The card settles once the mailbox took the email; a
 * refusal shows here and keeps the edits. Enter never sends: only Send, or
 * Cmd or Ctrl+Enter. Discard tells the bot nothing went out, and the user
 * can ask it for another draft in the chat.
 */
export function EmailDraftCard({
  approval,
  form
}: {
  approval: ApprovalRequest
  form: EmailDraftForm
}) {
  const kept = unsent.get(approval.requestId) ?? {}

  const keep =
    (key: 'bcc' | 'body' | 'cc' | 'subject' | 'to', set: (value: string) => void) =>
    (value: string) => {
      unsent.set(approval.requestId, { ...unsent.get(approval.requestId), [key]: value })
      set(value)
    }

  const [to, setTo] = useState(kept.to ?? form.to.join(', '))
  const [cc, setCc] = useState(kept.cc ?? form.cc.join(', '))
  const [bcc, setBcc] = useState(kept.bcc ?? form.bcc.join(', '))
  const [copies, setCopies] = useState(Boolean(cc || bcc))
  const [subject, setSubject] = useState(kept.subject ?? form.subject)
  const [body, setBody] = useState(kept.body ?? form.body)
  const [busy, setBusy] = useState<'deny' | 'save' | 'send' | null>(null)
  const [error, setError] = useState<null | string>(null)
  const id = useId()

  const draft: EmailDraft = {
    bcc: splitAddresses(bcc),
    body,
    cc: splitAddresses(cc),
    reply_to: form.reply_to ?? null,
    subject: subject.trim(),
    to: splitAddresses(to)
  }

  const nobody = draft.to.length + draft.cc.length + draft.bcc.length === 0

  const answer = async (action: 'deny' | 'save' | 'send') => {
    setBusy(action)
    setError(null)

    try {
      if (action === 'deny') {
        await approvalRespond(approval.sessionId, approval.requestId, 'deny')
        transcriptActions().resolveApproval(approval.sessionId, approval.requestId, 'deny')
      } else {
        const answer = { draft, mail_action: action }
        // Answers once Gmail or Outlook took it, or with why they wouldn't.
        await approvalRespond(approval.sessionId, approval.requestId, 'once', answer)
        transcriptActions().resolveApproval(approval.sessionId, approval.requestId, 'once', answer)
      }

      forgetUnsentDraft(approval.requestId)
    } catch (failure) {
      const text = failure instanceof Error ? failure.message : ''
      setError(draftAnswerError(text, action, form.service_name))
    } finally {
      setBusy(null)
    }
  }

  const shortcut = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()

      if (!nobody && !busy) {
        void answer('send')
      }
    }
  }

  const decided = approval.decision
  // Another app may have sent it with its own edits: show what went.
  const went = approval.outcome?.draft ?? draft

  const icon = (
    <ConnectorIcon className="size-5" icon={draftIcon(form.service)} />
  )

  // Answered: one line for what happened, then the email as it went.
  if (decided) {
    forgetUnsentDraft(approval.requestId)

    return (
      <div
        className="hex-bubble min-w-0 max-w-[min(100%,36rem)] flex-1 rounded-[18px] border border-border bg-background px-3.5 py-3"
        role="group"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="min-w-0 flex-1 truncate font-medium">
            {went.subject || 'No subject'}
          </span>
          <CardStatus done={decided !== 'deny'}>
            {decided === 'deny'
              ? 'Not sent'
              : approval.outcome?.mail_action === 'save'
                ? 'Saved to Drafts'
                : 'Sent'}
          </CardStatus>
        </div>
        {went.to.length ? (
          <p className="mt-0.5 truncate text-[length:var(--text-secondary)] text-muted">
            To {went.to.join(', ')}
          </p>
        ) : null}
        {decided !== 'deny' && went.body.trim() ? (
          <p className="mt-1.5 line-clamp-2 text-[length:var(--text-secondary)] text-muted">
            {went.body.trim().replace(/\s+/g, ' ')}
          </p>
        ) : null}
      </div>
    )
  }

  // Unanswered: a compose window. Plain rows split by hairlines, the
  // message as plain text, and the sender beside the buttons. Not a form,
  // so Enter in a field never sends a half-written email.
  return (
    <div
      aria-label={`Email draft${form.to.length ? ` to ${form.to.join(', ')}` : ''}`}
      className="hex-bubble min-w-0 max-w-[min(100%,36rem)] flex-1 overflow-hidden rounded-[18px] border border-border bg-background"
      onKeyDown={shortcut}
      role="group"
    >
      <Line id={`${id}-to`} label="To" onChange={keep('to', setTo)} value={to}>
        {copies ? null : (
          <button
            className="hex-focus shrink-0 rounded px-1 text-[length:var(--text-secondary)] text-muted hover:text-foreground"
            onClick={() => setCopies(true)}
            type="button"
          >
            Cc
          </button>
        )}
      </Line>
      {copies ? (
        <>
          <Line id={`${id}-cc`} label="Cc" onChange={keep('cc', setCc)} value={cc} />
          <Line id={`${id}-bcc`} label="Bcc" onChange={keep('bcc', setBcc)} value={bcc} />
        </>
      ) : null}
      <input
        aria-label="Subject"
        className={cn(BARE, 'border-b border-border px-3.5 py-2.5 font-medium')}
        onChange={event => keep('subject', setSubject)(event.target.value)}
        placeholder="Subject"
        value={subject}
      />
      <textarea
        aria-label="Message"
        className={cn(BARE, 'block min-h-32 resize-none px-3.5 py-2.5 leading-relaxed')}
        onChange={event => keep('body', setBody)(event.target.value)}
        rows={Math.min(16, Math.max(5, body.split('\n').length + 1))}
        value={body}
      />
      {error ? (
        <p className="px-3.5 pb-1 text-[length:var(--text-secondary)] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2 px-3.5 pt-1 pb-3">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-secondary)] text-muted">
          {form.from || form.service_name}
        </span>
        <Button
          busy={busy === 'deny'}
          disabled={busy !== null}
          onClick={() => void answer('deny')}
          size="sm"
          type="button"
          variant="ghost"
        >
          Discard
        </Button>
        <Button
          busy={busy === 'save'}
          disabled={busy !== null}
          onClick={() => void answer('save')}
          size="sm"
          type="button"
          variant="ghost"
        >
          Save draft
        </Button>
        <Button
          aria-keyshortcuts="Meta+Enter Control+Enter"
          busy={busy === 'send'}
          disabled={nobody || busy !== null}
          onClick={() => void answer('send')}
          size="sm"
          type="button"
          variant="primary"
        >
          Send
        </Button>
      </div>
    </div>
  )
}

/** A field with no well: the text sits on the card. */
const BARE =
  'w-full bg-transparent text-[length:var(--text-body)] text-foreground outline-none placeholder:text-muted'

/** One address line of the compose window, its label in front. */
function Line({
  children,
  id,
  label,
  onChange,
  value
}: {
  children?: React.ReactNode
  id: string
  label: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3.5">
      <label className="w-8 shrink-0 text-[length:var(--text-secondary)] text-muted" htmlFor={id}>
        {label}
      </label>
      <input
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect="off"
        className={cn(BARE, 'py-2.5')}
        id={id}
        onChange={event => onChange(event.target.value)}
        spellCheck={false}
        type="text"
        value={value}
      />
      {children}
    </div>
  )
}
