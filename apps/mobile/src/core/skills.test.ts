import { describe, expect, it } from 'vitest'

import { requirementText } from './skills'

describe('requirementText', () => {
  it('says what a skill waits for', () => {
    expect(
      requirementText([
        { kind: 'platform', name: ['macos', 'linux'] },
        { kind: 'command', name: 'memo' },
        { kind: 'env', name: 'NOTION_API_KEY' }
      ])
    ).toBe('Only on macOS or Linux · Needs memo installed · Needs NOTION_API_KEY')
  })
})
