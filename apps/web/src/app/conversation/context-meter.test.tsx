import { fireEvent, render, screen } from '@testing-library/react'

import type { ContextUsage } from '../../lib/types'

import { ContextMeter, formatTokens, readContext } from './context-meter'

const context = (patch: Partial<ContextUsage> = {}): ContextUsage => ({
  compact_at: 183_616,
  compacting: false,
  tokens: 41_000,
  window: 200_000,
  ...patch
})

describe('formatTokens', () => {
  it('rounds the way people read token counts', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(4_120)).toBe('4.1k')
    expect(formatTokens(9_000)).toBe('9k')
    expect(formatTokens(41_000)).toBe('41k')
    expect(formatTokens(183_616)).toBe('184k')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('readContext', () => {
  it('says nothing until the daemon has measured the section', () => {
    expect(readContext(null)).toBeNull()
    expect(readContext(undefined)).toBeNull()
    expect(readContext(context({ tokens: null }))).toBeNull()
    expect(readContext(context({ compact_at: null, window: null }))).toBeNull()
    expect(readContext(context({ recounting: true, tokens: null, window: null }))).toBeNull()
  })

  it('keeps a neutral reading while the section is recounted after a compaction', () => {
    const reading = readContext(context({ recounting: true, tokens: null }))!

    expect(reading.percent).toBeNull()
    expect(reading.label).toBe('Context')
    expect(reading.recounting).toBe(true)
    expect(reading.high).toBe(false)
    expect(reading.compactPercent).toBe(92)
    expect(reading.detail).toBe('Recounting after the summary.')
    expect(reading.description).toBe('Context. Recounting after the summary.')

    // Compacting wins while it runs, even without a count.
    const compacting = readContext(context({ compacting: true, recounting: true, tokens: null }))!
    expect(compacting.label).toBe('Compacting')
    expect(compacting.percent).toBeNull()
    expect(compacting.recounting).toBe(false)
    expect(compacting.description).toBe(
      'Context, compacting. Older messages are being summarised now.'
    )
  })

  it('reads a low section as a percentage of the window with the compaction point', () => {
    const reading = readContext(context())!

    expect(reading.percent).toBe(21)
    expect(reading.label).toBe('21%')
    expect(reading.high).toBe(false)
    expect(reading.compactPercent).toBe(92)
    expect(reading.detail).toBe('41k of 200k tokens. Older messages are summarised at 184k.')
    expect(reading.description).toBe(
      'Context 21%. 41k of 200k tokens. Older messages are summarised at 184k.'
    )
  })

  it('turns high near the compaction point and asks for a new section', () => {
    expect(readContext(context({ tokens: 155_000 }))!.high).toBe(false)

    const reading = readContext(context({ tokens: 160_000 }))!

    expect(reading.high).toBe(true)
    expect(reading.label).toBe('80%')
    expect(reading.detail).toBe(
      '160k of 200k tokens. Older messages are summarised at 184k. Start a new section soon. Long sections make the bot slower and less accurate.'
    )
  })

  it('names the compaction while it runs instead of a percentage', () => {
    const reading = readContext(context({ compacting: true, tokens: 185_000 }))!

    expect(reading.label).toBe('Compacting')
    expect(reading.high).toBe(false)
    expect(reading.detail).toBe('185k of 200k tokens. Older messages are being summarised now.')
    expect(reading.description).toBe(
      'Context 93%, compacting. 185k of 200k tokens. Older messages are being summarised now.'
    )
  })

  it('leaves the compaction point out when the model has none', () => {
    const reading = readContext(context({ compact_at: null }))!

    expect(reading.compactPercent).toBeNull()
    expect(reading.detail).toBe('41k of 200k tokens.')
    expect(reading.high).toBe(false)
  })

  it('never reads past the window', () => {
    expect(readContext(context({ tokens: 250_000 }))!.percent).toBe(100)
  })
})

describe('ContextMeter', () => {
  it('draws nothing while the context is unknown', () => {
    const { container } = render(<ContextMeter context={null} />)

    expect(container).toBeEmptyDOMElement()

    render(<ContextMeter context={context({ tokens: null })} />)
    expect(screen.queryByRole('meter')).toBeNull()
  })

  it('draws a quiet meter with the same words for assistive tech', () => {
    render(<ContextMeter context={context()} />)

    const meter = screen.getByRole('meter')

    expect(meter).toHaveAttribute('aria-valuenow', '21')
    expect(meter).toHaveAccessibleName(
      'Context 21%. 41k of 200k tokens. Older messages are summarised at 184k.'
    )
    expect(meter).toHaveAttribute('data-tone', 'low')
    expect(meter).toHaveTextContent('Context 21%')
    expect(meter.querySelector('.bg-warning')).toBeNull()
  })

  it('turns warning when the section is nearly full', () => {
    render(<ContextMeter context={context({ tokens: 170_000 })} />)

    const meter = screen.getByRole('meter')

    expect(meter).toHaveAttribute('data-tone', 'high')
    expect(meter).toHaveTextContent('Context 85%')
    expect(meter.querySelector('.bg-warning')).not.toBeNull()
    expect(meter).toHaveAccessibleName(/Start a new section soon/)
  })

  it('says Compacting while older messages are summarised', () => {
    render(<ContextMeter context={context({ compacting: true, tokens: 185_000 })} />)

    const meter = screen.getByRole('meter')

    expect(meter).toHaveAttribute('data-tone', 'compacting')
    expect(meter).toHaveTextContent(/^Compacting$/)
    expect(meter).toHaveAccessibleName(/being summarised now/)
  })

  it('stays as a neutral pill while the section is recounted', () => {
    render(<ContextMeter context={context({ recounting: true, tokens: null })} />)

    const meter = screen.getByRole('meter')

    expect(meter).toHaveAttribute('data-tone', 'recounting')
    expect(meter).not.toHaveAttribute('aria-valuenow')
    expect(meter).toHaveAttribute('aria-valuetext', 'Context')
    expect(meter).toHaveTextContent(/^Context$/)
    expect(meter).toHaveAccessibleName('Context. Recounting after the summary.')
  })

  it('takes keyboard focus and opens the numbers on it', async () => {
    render(<ContextMeter context={context()} />)

    const meter = screen.getByRole('meter')

    expect(meter).toHaveAttribute('tabindex', '0')
    fireEvent.focus(meter)
    expect(
      await screen.findByText('41k of 200k tokens. Older messages are summarised at 184k.')
    ).toBeVisible()
  })
})
