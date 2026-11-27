import { expect, it } from 'vitest'
import { messageText, parseMessage } from './message-text'

it('copies a message as its bubble reads, every paragraph at once', () => {
  const text = [
    '## Biology',
    'The 4 pm sync found the [Biology final draft](https://school.example/a/1) is now **due November 24**.',
    '- run `sync` again\n- check the calendar',
    '```sh\nhexbot jobs\n```',
    'Area is \\(\\pi r^2\\).'
  ].join('\n\n')

  expect(messageText(text)).toBe(
    [
      'Biology',
      'The 4 pm sync found the Biology final draft (https://school.example/a/1) is now due November 24.',
      '• run sync again\n• check the calendar',
      'hexbot jobs',
      'Area is πr².'
    ].join('\n\n')
  )
})

it('reads headings, code and links once for the bubble', () => {
  expect(parseMessage('# Title\n\nSee [https://a.example](https://a.example)')).toEqual([
    { kind: 'paragraph', heading: true, spans: [{ kind: 'text', text: 'Title' }] },
    {
      kind: 'paragraph',
      heading: false,
      spans: [
        { kind: 'text', text: 'See ' },
        { kind: 'link', text: 'https://a.example', url: 'https://a.example' }
      ]
    }
  ])
  // A bare address is not written twice.
  expect(messageText('See [https://a.example](https://a.example)')).toBe('See https://a.example')
})

it('reads tags as the web app does: bots, files, places in Hexbot and bare addresses', () => {
  const [block] = parseMessage(
    '@biology is created. See [the report](/Users/me/out/report.pdf), ' +
      '[Study group](hexbot:room/Study%20group) and https://www.taobao.com/.'
  )
  expect(block).toEqual({
    kind: 'paragraph',
    heading: false,
    spans: [
      { kind: 'tag', text: '@biology', tag: { kind: 'bot', handle: 'biology' } },
      { kind: 'text', text: ' is created. See ' },
      {
        kind: 'tag',
        text: 'the report',
        tag: { kind: 'file', name: 'report.pdf', path: '/Users/me/out/report.pdf' }
      },
      { kind: 'text', text: ', ' },
      { kind: 'tag', text: 'Study group', tag: { kind: 'room', room: 'Study group' } },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'https://www.taobao.com/', url: 'https://www.taobao.com/' },
      { kind: 'text', text: '.' }
    ]
  })
  // A tag copies as its words; an address is not written twice.
  expect(
    messageText('Ask @biology, open [Passwords](hexbot:settings/passwords), see https://a.example.')
  ).toBe('Ask @biology, open Passwords, see https://a.example.')
  // A path with spaces, and a target that is nothing Hexbot opens.
  expect(parseMessage('[notes](</Users/me/My Notes.md>) [x](javascript:alert(1))')[0]).toMatchObject({
    spans: [
      { kind: 'tag', tag: { kind: 'file', path: '/Users/me/My Notes.md' } },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'x' },
      { kind: 'text', text: ')' }
    ]
  })
})
