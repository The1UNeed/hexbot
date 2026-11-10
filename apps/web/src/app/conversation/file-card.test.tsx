import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { cardSize, FileCard, kindOf } from './file-card'

describe('FileCard', () => {
  it('shows the name cut in the middle, keeping the extension, and the size', () => {
    const onOpen = vi.fn()
    render(
      <FileCard name="esp32-c6-mini-1_mini-1u_datasheet_en.pdf" onOpen={onOpen} size={973691} />
    )

    // Read whole by a screen reader; drawn as the stem, which truncates, and ".pdf", which stays.
    expect(screen.getByText('esp32-c6-mini-1_mini-1u_datasheet_en.pdf')).toHaveClass('sr-only')
    expect(screen.getByText('esp32-c6-mini-1_mini-1u_datasheet_en')).toHaveClass('truncate')
    expect(screen.getByText('.pdf')).toHaveClass('shrink-0')
    expect(screen.getByText('951kB')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Open esp32-c6-mini-1_mini-1u_datasheet_en.pdf' })
    )
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('names the kind when there is no size, and can be removed from a draft', () => {
    const onRemove = vi.fn()
    render(<FileCard name="plan.md" onRemove={onRemove} />)

    expect(screen.getByText('Text')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open plan.md' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove plan.md' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('colours the page by file type', () => {
    expect(kindOf('Board.PDF').label).toBe('PDF')
    expect(kindOf('budget.xlsx').label).toBe('Spreadsheet')
    expect(kindOf('deck.key').label).toBe('Presentation')
    expect(kindOf('main.rs').label).toBe('Code')
    expect(kindOf('Makefile').label).toBe('File')
    expect([cardSize(512), cardSize(973691), cardSize(5 * 1024 * 1024)]).toEqual([
      '512B',
      '951kB',
      '5.0MB'
    ])
  })
})
