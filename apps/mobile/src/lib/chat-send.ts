import { sectionsActions } from '../stores/sections'
import { transcriptActions } from '../stores/transcripts'

import { promptSubmit } from './api'
import type { Attachment } from './types'

export function attachmentPrompt(text: string, hasAttachments: boolean): string {
  return text.trim() || (hasAttachments ? 'Please review the attached files.' : '')
}

/** Reopen an expired live session and restage its files before retrying. */
export async function submitChatPrompt(
  sessionId: string,
  sectionId: string,
  text: string,
  restage?: (sessionId: string) => Promise<Attachment[]>
): Promise<void> {
  let live = sessionId
  try {
    try {
      await promptSubmit(live, text)
      return
    } catch (error) {
      if (!/session not found/i.test(error instanceof Error ? error.message : String(error)))
        throw error
    }
    const reopened = await sectionsActions().open(sectionId)
    if (!reopened.liveSessionId || reopened.liveSessionId === live)
      throw new Error('The conversation could not be reopened.')
    live = reopened.liveSessionId
    const attachments = restage ? await restage(live) : []
    transcriptActions().appendUserMessage(live, text, attachments)
    await promptSubmit(live, text)
  } catch (error) {
    transcriptActions().errorEvent(live, error instanceof Error ? error.message : String(error))
  }
}
