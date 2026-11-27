import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Attachment } from '../lib/types'

import { holdCopy, RELEASE_AFTER_MS } from './page-copies'
import { transcriptActions, useTranscripts } from './transcripts'
import { fileTab, visualsActions } from './visuals'

const revoked: string[] = []
let made = 0

beforeEach(() => {
  vi.useFakeTimers()
  revoked.length = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:page/${++made}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void revoked.push(url))
})

afterEach(() => {
  visualsActions().closeAll()
  useTranscripts.setState({ bySession: {} })
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const sent = (url: string): Attachment => ({
  id: 'a',
  kind: 'video',
  mime: 'video/mp4',
  name: 'clip.mp4',
  size: 9,
  url
})

it('keeps a sent file while its message or tab shows it, then releases it', () => {
  const url = holdCopy(new Blob(['clip']))
  transcriptActions().appendUserMessage('s', 'Watch this', [sent(url)])
  vi.advanceTimersByTime(RELEASE_AFTER_MS)
  expect(revoked).toEqual([])

  // Opened beside the chat, it stays while the tab does.
  visualsActions().open(fileTab('clip.mp4', { mime: 'video/mp4', sessionId: 's', url }))
  transcriptActions().dropAll()
  vi.advanceTimersByTime(RELEASE_AFTER_MS)
  expect(revoked).toEqual([])

  visualsActions().closeAll()
  vi.advanceTimersByTime(RELEASE_AFTER_MS)
  expect(revoked).toEqual([url])
})
