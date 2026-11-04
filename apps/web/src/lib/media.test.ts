import { describe, expect, it } from 'vitest'

import { mediaOf, splitAttached } from './media'

describe('splitAttached', () => {
  const kept = (name: string) =>
    `/home/runtime/sessions/s/attachments/0123456789abcdef0123456789abcdef-${name}`

  it('takes the files you sent from under your words', () => {
    expect(
      splitAttached(`Here you go\n\nAttached files:\n${kept('clip.mp4')}\n${kept('voice.m4a')}`)
    ).toEqual({
      files: [
        { kind: 'video', mime: 'video/mp4', name: 'clip.mp4', path: kept('clip.mp4') },
        { kind: 'audio', mime: 'audio/mp4', name: 'voice.m4a', path: kept('voice.m4a') }
      ],
      text: 'Here you go'
    })
    expect(splitAttached(`\n\nAttached files:\n${kept('notes.txt')}`)).toEqual({
      files: [{ kind: 'file', mime: 'text/plain', name: 'notes.txt', path: kept('notes.txt') }],
      text: ''
    })
  })

  it('keeps words you wrote under the same heading', () => {
    const quoted = 'Summarize this email:\n\nAttached files:\nThe invoice will follow tomorrow.'

    expect(splitAttached(quoted)).toEqual({ files: [], text: quoted })
    // The daemon's own list is the last one; the quote above it stays.
    expect(splitAttached(`${quoted}\n\nAttached files:\n${kept('a.mp3')}`)).toEqual({
      files: [{ kind: 'audio', mime: 'audio/mpeg', name: 'a.mp3', path: kept('a.mp3') }],
      text: quoted
    })
  })
})

describe('mediaOf', () => {
  it('finds each file the media tools made, once, and nothing from other tools', () => {
    const call = (name: string, result: unknown, status = 'ok') => ({ name, result, status })

    expect(
      mediaOf([
        call(
          'image_generate',
          '{"images":[{"media":"MEDIA:/a/one.png"},{"media":"MEDIA:/a/two.png"}]}'
        ),
        call('video_generate', {
          content: [{ text: '{"media":"MEDIA:/a/lake.mp4"}', type: 'text' }],
          details: { media: 'MEDIA:/a/lake.mp4' }
        }),
        call('web_extract', '{"text":"MEDIA:/etc/passwd"}'),
        call('text_to_speech', '{"error":"failed"}', 'error')
      ]).map(file => [file.kind, file.path])
    ).toEqual([
      ['image', '/a/one.png'],
      ['image', '/a/two.png'],
      ['video', '/a/lake.mp4']
    ])
  })
})
