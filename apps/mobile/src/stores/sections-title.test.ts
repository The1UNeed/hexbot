import type * as api from '../lib/api'
import { sectionsList } from '../lib/api'
import type { Section } from '../lib/types'

import { sectionsActions, titleFromPrompt, useSections } from './sections'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsList: vi.fn()
}))

const listed = (sections: Section[]) =>
  vi.mocked(sectionsList).mockResolvedValue({ sections } as Awaited<ReturnType<typeof sectionsList>>)

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
  useSections.setState({
    byId: { [item.id]: item },
    idsByBot: { [item.bot]: [item.id] },
    sendingTitles: {}
  })

describe('section titles', () => {
  it('cleans a first message the way the daemon does', () => {
    expect(titleFromPrompt('  "Plan the garden."  ')).toBe('Plan the garden')
    expect(titleFromPrompt('What can you help me with?')).toBe('What can you help me with?')
    expect(titleFromPrompt('one\ntwo')).toBe('one two')
    expect(titleFromPrompt('x'.repeat(80))).toHaveLength(60)
    // Rust trims U+0085 and keeps U+FEFF; JavaScript's trim does the opposite.
    expect(titleFromPrompt('\u0085Plan the garden.')).toBe('Plan the garden')
    expect(titleFromPrompt('"\ufeffPlan"')).toBe('\ufeffPlan')
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

  it('keeps the sent title through a refresh that started before the send', async () => {
    seed(section())
    sectionsActions().markTouched('s1', 'Plan the garden')
    listed([section({ message_count: 1 })])
    await sectionsActions().refresh()
    expect(useSections.getState().byId.s1?.title).toBe('Plan the garden')
  })

  it("takes the daemon's title once the first message settles", async () => {
    seed(section())
    sectionsActions().markTouched('s1', 'Plan the garden')
    // The daemon refused the message (a spent budget, say) and kept the default.
    listed([section()])
    await sectionsActions().settleTitle('s1')
    expect(useSections.getState().byId.s1?.title).toBe('New section')

    sectionsActions().markTouched('s1', 'Try again')
    expect(useSections.getState().byId.s1?.title).toBe('Try again')
  })
})
