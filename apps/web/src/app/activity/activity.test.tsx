import { render, screen } from '@testing-library/react'

import { useBots } from '../../stores/bots'

import { ActivityView } from './index'

vi.mock('../../lib/api', () => ({
  activityList: vi.fn().mockResolvedValue({ messages: [] }),
  activityPairs: vi.fn().mockResolvedValue({
    pairs: [{ count: 4, from_bot: 'scout', last_at: 1_700_000_000, to_bot: 'writer' }]
  })
}))

describe('activity table', () => {
  it('renders pair counts and bot names', async () => {
    useBots.setState({
      byName: {
        scout: { display_name: 'Scout' },
        writer: { display_name: 'Writer' }
      } as never,
      order: ['scout', 'writer']
    })
    render(<ActivityView />)
    expect(await screen.findByRole('row', { name: /Scout.*Writer.*4/ })).toBeVisible()
  })
})
