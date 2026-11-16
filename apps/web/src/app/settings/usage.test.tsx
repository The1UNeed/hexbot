import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usageReport, usageSummary } from '../../lib/api'
import type { UsageReport } from '../../lib/types'

import { UsageSettings } from './usage'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  usageReport: vi.fn(),
  usageSummary: vi.fn()
}))

const unknown = Object.assign(new Error('unknown method: hexbot.usage.report'), { code: -32601 })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Settings, Usage', () => {
  it('charts the report with its cost against the window before', async () => {
    vi.mocked(usageReport).mockImplementation(async edges => {
      const report: UsageReport = {
        earlier: { cost: 0.5, tokens: 100 },
        previous: { calls: 1, cost: 1, tokens: 10 },
        rows: [
          {
            bot: 'owl',
            cache_read: 30,
            cache_write: 0,
            calls: 2,
            cost: 2.5,
            input: 10,
            model: 'gpt-6.1-sol',
            output: 5,
            place: 'chat',
            provider: 'openai-codex',
            t: edges.at(-2)!
          }
        ],
        since: edges[0]!,
        until: edges.at(-1)!
      }

      return report
    })
    render(<UsageSettings />)

    // In the headline and on the bot's row.
    expect(await screen.findAllByText('$2.50')).toHaveLength(2)
    expect(screen.getByText(/up from \$1\.00 in the previous 30 days/)).toBeVisible()
    expect(screen.getByText('Daily cost')).toBeVisible()
    // Usage with no dates shows only for all time.
    expect(screen.queryByText(/earlier version/)).toBeNull()
  })

  it('keeps a chosen bot in its filter in a range where it made no calls', async () => {
    const used = {
      bot: 'owl',
      cache_read: 0,
      cache_write: 0,
      calls: 1,
      cost: 1,
      input: 10,
      model: 'm',
      output: 1,
      place: 'chat' as const,
      provider: 'p'
    }

    vi.mocked(usageReport).mockImplementation(async edges => ({
      earlier: { cost: 0, tokens: 0 },
      previous: { calls: 0, cost: 0, tokens: 0 },
      // Only the 30-day window, the first asked for, has a call.
      rows: edges.length > 30 ? [{ ...used, t: edges.at(-2)! }] : [],
      since: edges[0]!,
      until: edges.at(-1)!
    }))
    render(<UsageSettings />)

    fireEvent.click(await screen.findByRole('button', { name: /owl/ }))
    fireEvent.click(screen.getByRole('tab', { name: '24 hours' }))

    expect(await screen.findByText(/No model calls in the last 24 hours/)).toBeVisible()
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('owl')
  })

  it('shows an older daemon’s totals', async () => {
    vi.mocked(usageReport).mockRejectedValue(unknown)
    vi.mocked(usageSummary).mockResolvedValue({
      by_bot: [],
      estimated_cost_usd: 3,
      input_tokens: 100,
      output_tokens: 10
    })
    render(<UsageSettings />)

    expect(await screen.findByText(/Update this daemon/)).toBeVisible()
    expect(screen.getByText('$3.00')).toBeVisible()
  })

  it('says so when an older daemon’s totals fail too', async () => {
    vi.mocked(usageReport).mockRejectedValue(unknown)
    vi.mocked(usageSummary).mockRejectedValue(new Error('Connection closed'))
    render(<UsageSettings />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Usage is unavailable: Connection closed'
    )
  })
})
