/**
 * What a draft card shares between the web and mobile apps: the edits a user
 * made to a card still waiting, kept while they look away, its icon, and how
 * a failed answer is worded.
 */
import type { MailService } from './types'

export type UnsentDraft = Partial<Record<'bcc' | 'body' | 'cc' | 'subject' | 'to', string>>

export const unsentDrafts = new Map<string, UnsentDraft>()

/** The icon a draft card shows for the mailbox it goes from. */
export function draftIcon(service: MailService) {
  return service === 'google' ? 'gmail' : service === 'microsoft' ? 'microsoftoutlook' : 'glyph:mail'
}

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
