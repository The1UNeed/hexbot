import { KICKOFF_MARKER, kickoffPrompt } from './bot-kickoff'

describe('bot kickoff', () => {
  it('puts the new name in context, behind the marker the history filter looks for', () => {
    expect(kickoffPrompt({ display_name: 'research' })).toContain(`${KICKOFF_MARKER} "research"`)
    expect(kickoffPrompt({ display_name: '  ' })).toContain(`${KICKOFF_MARKER} "this bot"`)
  })

  it('passes on the description the user typed, and leaves the line out without one', () => {
    const prompt = kickoffPrompt({ description: 'Tracks GPU prices', display_name: 'scout', title: '' })

    expect(prompt).toContain('The user described you as: Tracks GPU prices')
    expect(kickoffPrompt({ display_name: 'scout' })).not.toContain('described you as')
  })
})
