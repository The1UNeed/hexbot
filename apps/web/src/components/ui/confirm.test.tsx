import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { confirm, ConfirmHost } from './confirm'

async function ask(question: Parameters<typeof confirm>[0]) {
  let answer!: Promise<boolean>
  act(() => {
    answer = confirm(question)
  })

  return { answer, dialog: await screen.findByRole('alertdialog') }
}

describe('confirm', () => {
  it('asks in the app window and answers Yes', async () => {
    render(<ConfirmHost />)

    const { answer, dialog } = await ask({
      detail: 'Its history goes with it.',
      title: 'Delete “General”?'
    })

    expect(dialog).toHaveTextContent('Delete “General”?')
    expect(dialog).toHaveTextContent('Its history goes with it.')
    expect(dialog).toHaveAccessibleName('Delete “General”?')
    expect(dialog).toHaveAccessibleDescription('Its history goes with it.')
    const buttons = within(dialog).getAllByRole('button')
    expect(buttons.map(button => button.textContent)).toEqual(['No', 'Yes'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes' }))
    await expect(answer).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('focuses No first and keeps outside clicks from confirming', async () => {
    render(<ConfirmHost />)
    const { answer, dialog } = await ask({ title: 'Delete the notes?' })

    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'No' })).toHaveFocus())
    fireEvent.click(document.body)
    expect(dialog).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await expect(answer).resolves.toBe(false)
  })

  it('answers No for No, Escape, and a newer question', async () => {
    render(<ConfirmHost />)
    const first = await ask({ title: 'Leave this room?' })
    fireEvent.click(within(first.dialog).getByRole('button', { name: 'No' }))
    await expect(first.answer).resolves.toBe(false)

    const second = await ask({ title: 'Leave this room?' })
    fireEvent.keyDown(second.dialog, { key: 'Escape' })
    await expect(second.answer).resolves.toBe(false)

    const third = await ask({ title: 'Delete the notes?' })
    const fourth = await ask({ title: 'Restore the memory?' })
    await expect(third.answer).resolves.toBe(false)
    expect(fourth.dialog).toHaveTextContent('Restore the memory?')
    fireEvent.click(within(fourth.dialog).getByRole('button', { name: 'Yes' }))
    await expect(fourth.answer).resolves.toBe(true)
  })
})
