import { expect, it } from 'vitest'
import { messageCode, messageText, parseMessage } from './message-text'

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

it('copies only the code of a message that has some', () => {
  const text = 'Run this:\n\n```sh\nhexbot jobs\n```\n\nThen this:\n\n```\nhexbot pair\n```'
  expect(messageCode(text)).toBe('hexbot jobs\n\nhexbot pair')
  expect(messageCode('Inline `code` is part of the words.')).toBeNull()
})
