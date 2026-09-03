import { botTemplateFields } from './bot-templates'

describe('bot template prefill', () => {
  it('prefills title, description, and persona', () => {
    expect(botTemplateFields('coder')).toMatchObject({
      description: expect.any(String),
      persona: expect.stringContaining('code'),
      title: 'Coder'
    })
  })
})
