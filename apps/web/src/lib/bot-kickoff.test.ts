import { KICKOFF_MARKER, kickoffPrompt } from './bot-kickoff'

describe('bot kickoff', () => {
  it('puts the new name in context, behind the marker the history filter looks for', () => {
    expect(kickoffPrompt('research')).toContain(`${KICKOFF_MARKER} "research"`)
    expect(kickoffPrompt('  ')).toContain(`${KICKOFF_MARKER} "this bot"`)
  })
})
