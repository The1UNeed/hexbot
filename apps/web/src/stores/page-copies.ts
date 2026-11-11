/**
 * Object URLs for files only this page holds, such as a PDF or video just
 * sent. A message plays or opens its file from one; once no message or side
 * tab shows it any more, it is released, so sending large files does not keep
 * every one of them for as long as the page is open.
 */

import { useTranscripts } from './transcripts'
import { isFileTab, useVisuals } from './visuals'

const held = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** How long a copy outlives its last message or tab, so a row that is replaced in place keeps it. */
export const RELEASE_AFTER_MS = 5000

/** A URL for `file` that is released when nothing shows it. */
export function holdCopy(file: Blob): string {
  const url = URL.createObjectURL(file)
  held.add(url)
  schedule()

  return url
}

function inUse(): Set<string> {
  const used = new Set<string>()

  for (const transcript of Object.values(useTranscripts.getState().bySession)) {
    for (const message of transcript?.messages ?? []) {
      for (const attachment of message.attachments) {
        if (attachment.url) {
          used.add(attachment.url)
        }
      }
    }
  }

  for (const tab of useVisuals.getState().tabs) {
    if (isFileTab(tab) && tab.file.url) {
      used.add(tab.file.url)
    }
  }

  return used
}

function release() {
  timer = undefined
  const used = inUse()

  for (const url of held) {
    if (!used.has(url)) {
      held.delete(url)
      URL.revokeObjectURL(url)
    }
  }
}

function schedule() {
  if (held.size && timer === undefined) {
    timer = setTimeout(release, RELEASE_AFTER_MS)
  }
}

useTranscripts.subscribe(schedule)
useVisuals.subscribe(schedule)
