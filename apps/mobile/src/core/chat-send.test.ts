import { describe, expect, it } from 'vitest'
import { attachmentPrompt, encodeAnswer, imageMime } from './chat-send'
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
