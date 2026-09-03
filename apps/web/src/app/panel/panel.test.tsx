import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { MemorySectionEditor } from './index'

describe('core memory editor', () => {
  it('shows the counter and refuses text over the section cap', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<MemorySectionEditor cap={4_000} label="user" onSave={save} value="hello" />)
    expect(screen.getByText('5 / 4000')).toBeVisible()
    const input = screen.getByLabelText('user memory')
    fireEvent.change(input, { target: { value: 'x'.repeat(4_001) } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert')).toHaveTextContent('4000 characters or fewer')
    expect(save).not.toHaveBeenCalled()
  })
})
