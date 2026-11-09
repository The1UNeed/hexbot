/**
 * What a draft card shares between the web and mobile apps: the edits a user
 * made to a card still waiting, kept while they look away, and how a failed
 * answer is worded.
 */
export type UnsentDraft = Partial<Record<'bcc' | 'body' | 'cc' | 'subject' | 'to', string>>

export const unsentDrafts = new Map<string, UnsentDraft>()

/** The card settled or expired, here or on another app: its edits go. */
export function forgetUnsentDraft(requestId: string) {
  unsentDrafts.delete(requestId)
}

/**
 * A failed send or save, worded for the user. A request the app gave up
 * waiting for may still have gone out, so it says where to look.
 */
export function draftAnswerError(text: string, action: 'deny' | 'save' | 'send', service: string) {
  if (!text.startsWith('request timed out') || action === 'deny') {
    return text || 'Could not send it. Try again.'
  }

  return action === 'save'
    ? `${service} is taking a while. Look in Drafts before you save it again.`
    : `${service} is taking a while. Look in Sent before you send it again.`
}
