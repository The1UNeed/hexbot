import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { approvalRespond } from '../../lib/api'
import type { ApprovalRequest } from '../../lib/types'
import { useTranscripts } from '../../stores/transcripts'

import { ApprovalCard } from './index'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  approvalReceived: vi.fn().mockResolvedValue({}),
  approvalRespond: vi.fn().mockResolvedValue({ resolved: true })
}))

const card: ApprovalRequest = {
  choices: ['once', 'deny'],
  command: 'Sign in to Schoology',
  form: { kind: 'sign_in', site: 'app.schoology.com', title: 'Schoology', username: 'alex' },
  receivedAt: 1,
  requestId: 'ap-1',
  sessionId: 's-1'
}

describe('sign-in card', () => {
  beforeEach(() => {
    vi.mocked(approvalRespond).mockClear()
    useTranscripts.getState().dropAll()
    useTranscripts.getState().approvalRequest('s-1', {
      choices: ['once', 'deny'],
      command: card.command,
      form: card.form,
      request_id: 'ap-1'
    })
  })

  it('sends what was typed with the answer and shows Submitted after', async () => {
    const { rerender } = render(<ApprovalCard approval={card} />)

    expect(screen.getByText('Sign in to Schoology')).toBeVisible()
    expect(screen.getByText('Secure form')).toBeVisible()
    expect(screen.getByLabelText('Username or email')).toHaveValue('alex')
    const signIn = screen.getByRole('button', { name: 'Sign in' })
    expect(signIn).toBeDisabled()

    const password = screen.getByLabelText('Password')
    // Named by its label alone, not the show button beside it.
    expect(password).toHaveAccessibleName('Password')
    expect(password).toHaveAttribute('type', 'password')
    fireEvent.change(password, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    fireEvent.click(signIn)

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', {
        password: 'hunter2',
        username: 'alex'
      })
    )
    const settled = useTranscripts.getState().bySession['s-1']!.approvals[0]!
    expect(settled.decision).toBe('once')
    // The transcript keeps the card, never what was typed.
    expect(JSON.stringify(useTranscripts.getState().bySession['s-1'])).not.toContain('hunter2')

    rerender(<ApprovalCard approval={settled} />)
    expect(screen.getByText('Submitted')).toBeVisible()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('cancels without sending anything typed', async () => {
    render(<ApprovalCard approval={card} />)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'deny', undefined)
    )
  })

  it('keeps the form and says why when the daemon refuses', async () => {
    vi.mocked(approvalRespond).mockRejectedValueOnce(new Error('request is no longer waiting'))
    render(<ApprovalCard approval={card} />)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('request is no longer waiting')
    expect(screen.getByLabelText('Password')).toBeVisible()
  })
})
