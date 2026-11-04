import { describe, expect, it } from 'vitest'

import { mediaOf, splitAttached } from './media'

describe('splitAttached', () => {
  it('takes the files you sent from under your words', () => {
    const kept = '/home/runtime/sessions/s/attachments/0123456789abcdef0123456789abcdef-clip.mp4'

    expect(splitAttached(`Here you go\n\nAttached files:\n${kept}\n/x/voice.m4a`)).toEqual({
      files: [
        { kind: 'video', mime: 'video/mp4', name: 'clip.mp4', path: kept },
        { kind: 'audio', mime: 'audio/mp4', name: 'voice.m4a', path: '/x/voice.m4a' }
      ],
      text: 'Here you go'
    })
    expect(splitAttached('\n\nAttached files:\n/x/notes.txt')).toEqual({
      files: [{ kind: 'file', mime: 'text/plain', name: 'notes.txt', path: '/x/notes.txt' }],
      text: ''
    })
  })

  it('leaves a message without files as it is', () => {
    expect(splitAttached('Attached files: none, sorry')).toEqual({
      files: [],
      text: 'Attached files: none, sorry'
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
