import type { Section } from '../lib/types'

import { sectionsActions, titleFromPrompt, useSections } from './sections'

const section = (overrides: Partial<Section> = {}) =>
  ({
    bot: 'owl',
    id: 's1',
    message_count: 0,
    preview: '',
    title: 'New section',
    title_by: null,
    ...overrides
  }) as Section

const seed = (item: Section) =>
  useSections.setState({ byId: { [item.id]: item }, idsByBot: { [item.bot]: [item.id] } })

describe('section titles', () => {
  it('cleans a first message the way the daemon does', () => {
    expect(titleFromPrompt('  "Plan the garden."  ')).toBe('Plan the garden')
    expect(titleFromPrompt('What can you help me with?')).toBe('What can you help me with?')
    expect(titleFromPrompt('one\ntwo')).toBe('one two')
    expect(titleFromPrompt('x'.repeat(80))).toHaveLength(60)
  })

  it('titles an unnamed section from the message the user just sent', () => {
    seed(section())
    sectionsActions().markTouched('s1', 'Plan the garden.')

    expect(useSections.getState().byId.s1).toMatchObject({
      message_count: 1,
      title: 'Plan the garden'
    })
  })

  it('keeps a title the user or the bot already set', () => {
    seed(section({ message_count: 2, title: 'Garden', title_by: 'bot' }))
    sectionsActions().markTouched('s1', 'Something else')
    expect(useSections.getState().byId.s1?.title).toBe('Garden')

    seed(section({ title: 'Taxes' }))
    sectionsActions().markTouched('s1', 'Something else')
    expect(useSections.getState().byId.s1).toMatchObject({ message_count: 1, title: 'Taxes' })
  })
})
