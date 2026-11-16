import { describe, expect, it, vi } from 'vitest'
import {
  attachInParts,
  attachmentPrompt,
  encodeAnswer,
  imageMime,
  PART_CHARS,
  WholeFilesOnly
} from './chat-send'
import { avatarSrc, botPhoto } from './avatar'

describe('attachments and avatars', () => {
  it('gives attachment-only submissions a nonempty prompt', () => {
    expect(attachmentPrompt('  ', true)).toBe('Please review the attached files.')
    expect(attachmentPrompt('  Summarize  ', true)).toBe('Summarize')
    expect(attachmentPrompt('  ', false)).toBe('')
  })
  it('detects image MIME by filename when the picker leaves it out or returns a generic MIME', () => {
    expect(imageMime('PHOTO.JPEG')).toBe('image/jpeg')
    expect(imageMime('chart.png', 'application/octet-stream')).toBe('image/png')
    expect(imageMime('file', 'image/webp')).toBe('image/webp')
    expect(imageMime('notes.txt', 'text/plain')).toBeUndefined()
  })
  it('preserves full avatar URLs and prefixes raw bytes only once', () => {
    expect(avatarSrc({ data: 'data:image/png;base64,abc', mime: 'image/png' })).toBe(
      'data:image/png;base64,abc'
    )
    expect(avatarSrc({ data: 'abc', mime: 'image/png' })).toBe('data:image/png;base64,abc')
    expect(avatarSrc(null)).toBeNull()
  })
  it('treats a picked face as no photo, so Use its face never deletes it', () => {
    const png = { data: 'abc', mime: 'image/png' }
    expect(botPhoto({ avatar: png, face: { color: 'mint', shape: 'blob' } })).toBeNull()
    expect(botPhoto({ avatar: png, face: null })).toBe('data:image/png;base64,abc')
    expect(botPhoto({ avatar: null })).toBeNull()
    expect(botPhoto(undefined)).toBeNull()
  })
})

describe('question answers', () => {
  it('sends multiple choices as a JSON array, so a choice with a comma stays whole', () => {
    expect(encodeAnswer(true, ['Paris, France', 'Rome'], '')).toBe('["Paris, France","Rome"]')
    expect(encodeAnswer(true, ['Rome'], ' Oslo ')).toBe('["Rome","Oslo"]')
    expect(encodeAnswer(false, ['Rome'], '')).toBe('Rome')
    expect(encodeAnswer(false, ['Rome'], 'Oslo')).toBe('Oslo')
  })
})

describe('uploads in parts', () => {
  it('sends a file in parts, saying how much the daemon has, then names the upload', async () => {
    const rpc = vi.fn(async () => ({ id: 'srv-1' }))
    const base64 = 'QUJD'.repeat(PART_CHARS / 4 + 2)
    const progress: number[] = []
    const reply = await attachInParts(
      rpc as never,
      's1',
      'file.attach',
      { name: 'notes.txt', data_url: `data:text/plain;base64,${base64}` },
      'u1',
      { onProgress: value => progress.push(value) }
    )
    expect(reply).toEqual({ id: 'srv-1' })
    const calls = rpc.mock.calls as unknown as [string, Record<string, unknown>][]
    expect(calls.map(([method, p]) => [method, p.offset, String(p.data ?? '').length])).toEqual([
      ['attachments.part', 0, PART_CHARS],
      ['attachments.part', (PART_CHARS / 4) * 3, 8],
      ['file.attach', undefined, 0]
    ])
    expect(calls[2]![1]).toEqual({ name: 'notes.txt', session_id: 's1', upload: 'u1' })
    // Whole only when the daemon answers the attach.
    expect(progress).toEqual([0.99, 0.99])
  })
  it('sends the file whole to a daemon without part uploads', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unknown runtime method'), { code: -32601 }))
      .mockResolvedValue({ id: 'srv-1' })
    const params = { content_base64: 'iVBORw==', filename: 'photo.png' }
    await attachInParts(rpc as never, 'old', 'image.attach_bytes', params, 'u1')
    expect(rpc).toHaveBeenLastCalledWith('image.attach_bytes', { ...params, session_id: 'old' })
    // Asked once: the next file there goes whole straight away.
    await attachInParts(rpc as never, 'old', 'image.attach_bytes', params, 'u2')
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'attachments.part',
      'image.attach_bytes',
      'image.attach_bytes'
    ])
  })
  it('stages nothing ahead of Send on a daemon without part uploads', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unknown runtime method'), { code: -32601 }))
    await expect(
      attachInParts(rpc as never, 'older', 'file.attach', { name: 'a', data_url: 'data:,YQ==' }, 'u1', {
        ahead: true
      })
    ).rejects.toBeInstanceOf(WholeFilesOnly)
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('sends no more parts once the file is taken out', async () => {
    let wanted = true
    const rpc = vi.fn(async () => {
      wanted = false
      return {}
    })
    const params = { name: 'big', data_url: `data:,${'QUJD'.repeat(PART_CHARS / 2)}` }
    await expect(
      attachInParts(rpc as never, 's1', 'file.attach', params, 'u1', { wanted: () => wanted })
    ).rejects.toThrow('taken out')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
