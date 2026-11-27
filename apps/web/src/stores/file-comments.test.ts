import { beforeEach, describe, expect, it } from 'vitest'

import { fileCommentsActions, useFileComments, withComments } from './file-comments'

describe('comments on files', () => {
  beforeEach(() => useFileComments.setState({ byChat: {}, outbox: {} }))

  it('go with the message, each naming its file, place and words', () => {
    const text = withComments('Tidy this up.', [
      {
        id: '1',
        name: 'plan.md',
        note: 'Shorter',
        path: '/w/plan.md',
        quote: 'A long  line\nhere',
        where: 'line 4'
      },
      {
        id: '2',
        name: 'shot.png',
        note: 'Blur the email',
        where: 'the marked area at 10, 20 (30×40 px)'
      }
    ])

    expect(text).toBe(
      'Tidy this up.\n\nMy comments:\n' +
        '1. [plan.md](</w/plan.md>), line 4, on "A long line here": Shorter\n' +
        '2. shot.png, the marked area at 10, 20 (30×40 px): Blur the email\n\n' +
        'Where a comment asks for a change, edit the file in place.'
    )
    expect(withComments('Just words', [])).toBe('Just words')
    expect(withComments('  ', [{ id: '1', name: 'a.md', note: 'x' }])).toMatch(
      /^Please work through my comments on these files\./
    )
  })

  it('are taken once, and come back when a send fails', () => {
    const actions = fileCommentsActions()

    actions.add('daily', { name: 'a.md', note: 'one' })
    actions.add('daily', { name: 'a.md', note: 'two' })
    const taken = actions.take('daily')

    expect(taken.map(comment => comment.note)).toEqual(['one', 'two'])
    expect(fileCommentsActions().take('daily')).toEqual([])
    actions.add('daily', { name: 'a.md', note: 'three' })
    actions.restore('daily', taken)
    expect(useFileComments.getState().byChat.daily!.map(comment => comment.note)).toEqual([
      'one',
      'two',
      'three'
    ])

    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    actions.attach('daily', file)
    expect(fileCommentsActions().takeFiles('daily')).toEqual([file])
    expect(fileCommentsActions().takeFiles('daily')).toEqual([])
  })
})
