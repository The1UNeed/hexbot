import { feeling, feelingAbout, feelingAfter, type Moment, momentOf } from './emotions'
import type { Message, ToolCall } from './types'

function message(overrides: Partial<Message>): Message {
  return {
    attachments: [],
    createdAt: 0,
    id: 'm',
    role: 'assistant',
    streaming: false,
    text: '',
    toolCalls: [],
    ...overrides
  }
}

const call = (status: ToolCall['status']): ToolCall => ({
  args: {},
  durationS: null,
  name: 'terminal',
  result: null,
  startedAt: 0,
  status,
  toolId: `t${Math.random()}`
})

const reply = (overrides: Partial<NonNullable<Moment['reply']>>) => ({
  errors: 0,
  failed: false,
  id: 'r',
  status: 'ok',
  steps: 0,
  streaming: false,
  text: 'Here it is.',
  workedMs: 1000,
  ...overrides
})

describe('emotions', () => {
  it('takes what you say as praise, alarm or a question to look into', () => {
    expect(feelingAbout('Thanks, that was perfect')).toBe('shy')
    expect(feelingAbout('nice work 👍')).toBe('shy')
    expect(feelingAbout('The site is down, urgent')).toBe('surprised')
    expect(feelingAbout('WHY IS EVERYTHING BROKEN')).toBe('surprised')
    expect(feelingAbout('Can you look at the logs?')).toBe('curious')
  })

  it('feels about how a reply ended', () => {
    expect(feelingAfter(reply({ failed: true }))).toBe('sad')
    expect(feelingAfter(reply({ status: 'interrupted' }))).toBeNull()
    expect(feelingAfter(reply({ text: "Sorry, I couldn't reach the server." }))).toBe('sad')
    expect(feelingAfter(reply({ text: 'All 42 tests pass 🎉' }))).toBe('celebrating')
    expect(feelingAfter(reply({ steps: 9 }))).toBe('proud')
    expect(feelingAfter(reply({ workedMs: 90_000 }))).toBe('proud')
    expect(feelingAfter(reply({ text: 'Which branch should I use?' }))).toBe('curious')
    expect(feelingAfter(reply({}))).toBeNull()
  })

  it('reacts to what changed: your message, failed steps, and the end of a reply', () => {
    const said = message({ id: 'u1', role: 'user', text: 'thank you!' })
    const working = message({ id: 'r1', streaming: true, toolCalls: [call('ok')] })

    // What you said lands as the bot's turn starts, not before.
    expect(feeling(momentOf([]), momentOf([said]))).toBeNull()
    expect(feeling(momentOf([said]), momentOf([said, working]))).toBe('shy')
    // Reloaded history, finished and with new ids, is not news.
    expect(
      feeling(momentOf([said]), momentOf([{ ...said, id: 'u2' }, message({ id: 'r9' })]))
    ).toBeNull()

    const before = momentOf([said, working])
    const oneError = momentOf([said, { ...working, toolCalls: [call('ok'), call('error')] }])
    expect(feeling(before, oneError)).toBe('confused')

    const threeErrors = momentOf([
      said,
      { ...working, toolCalls: [call('error'), call('error'), call('error')] }
    ])

    expect(feeling(oneError, threeErrors)).toBe('frustrated')

    const done = momentOf([
      said,
      { ...working, streaming: false, text: 'Merged it.', status: 'ok' }
    ])

    expect(feeling(before, done)).toBe('celebrating')

    const failed = momentOf([said, { ...working, error: 'Provider down', streaming: false }])
    expect(feeling(before, failed)).toBe('sad')
  })
})
