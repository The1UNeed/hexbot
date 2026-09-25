import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WaitingBanner } from './waiting-banner'

describe('WaitingBanner', () => {
  it('says who is waiting in a room and just waits in a section', () => {
    const { rerender } = render(<WaitingBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting on you')

    rerender(<WaitingBanner name="Scout" />)
    expect(screen.getByRole('status')).toHaveTextContent('Scout is waiting on you')
  })
})
