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
  command: 'Add your OpenAI API key',
  form: {
    env: 'OPENAI_API_KEY',
    kind: 'api_key',
    site: 'platform.openai.com',
    title: 'OpenAI',
    url: 'https://platform.openai.com/api-keys'
  },
  receivedAt: 1,
  requestId: 'ap-1',
  sessionId: 's-1'
}

describe('API key card', () => {
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

  it('keeps the form, not a sign-in, and sends only the key', async () => {
    expect(useTranscripts.getState().bySession['s-1']?.approvals[0]?.form?.kind).toBe('api_key')
    const { rerender } = render(<ApprovalCard approval={card} />)

    expect(screen.getByRole('group', { name: 'Add your OpenAI API key' })).toBeVisible()
    expect(screen.getByText('API key, as OPENAI_API_KEY')).toBeVisible()
    expect(screen.queryByLabelText('Username or email')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))

    const key = screen.getByLabelText('API key')
    expect(key).toHaveFocus()
    expect(key).toHaveAttribute('type', 'password')
    expect(screen.getByRole('link', { name: 'Get one' })).toHaveAttribute(
      'href',
      'https://platform.openai.com/api-keys'
    )
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.change(key, { target: { value: '  ' } })
    expect(save).toBeDisabled()
    fireEvent.change(key, { target: { value: 'sk-test' } })
    fireEvent.click(save)

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', { key: 'sk-test' })
    )
    rerender(<ApprovalCard approval={{ ...card, decision: 'once' }} />)
    expect(screen.getByText('Saved')).toBeVisible()
    expect(screen.queryByDisplayValue('sk-test')).toBeNull()
  })

  it('declines without sending a key', async () => {
    render(<ApprovalCard approval={card} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'deny', undefined)
    )
  })
})
