import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { splitAddresses } from '../../lib/addresses'
import { approvalRespond } from '../../lib/api'
import type { ApprovalRequest, EmailDraftForm } from '../../lib/types'
import { useTranscripts } from '../../stores/transcripts'

import { ApprovalCard } from './index'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  approvalReceived: vi.fn().mockResolvedValue({}),
  approvalRespond: vi.fn().mockResolvedValue({ resolved: true })
}))

const form: EmailDraftForm = {
  bcc: [],
  body: 'Hi Ana,\nFriday works.',
  cc: [],
  from: 'alice@example.com',
  kind: 'email_draft',
  reply_to: 'm1',
  service: 'google',
  service_name: 'Gmail',
  subject: 'Re: Friday',
  to: ['ana@example.com']
}

const card: ApprovalRequest = {
  choices: ['once', 'deny'],
  command: 'Email to ana@example.com',
  form,
  receivedAt: 1,
  requestId: 'ap-1',
  sessionId: 's-1'
}

describe('email draft card', () => {
  beforeEach(() => {
    vi.mocked(approvalRespond).mockClear()
    useTranscripts.getState().dropAll()
    useTranscripts.getState().approvalRequest('s-1', {
      choices: ['once', 'deny'],
      command: card.command,
      form,
      request_id: 'ap-1'
    })
  })

  it('keeps the draft card the daemon sent', () => {
    expect(useTranscripts.getState().bySession['s-1']!.approvals[0]!.form).toEqual(form)
  })

  it('sends the draft as the user left it and folds to Sent', async () => {
    const { rerender } = render(<ApprovalCard approval={card} />)

    expect(screen.getByRole('group', { name: 'Email draft to ana@example.com' })).toBeVisible()
    expect(screen.getByText('alice@example.com')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cc' }))
    fireEvent.change(screen.getByLabelText('Cc'), {
      target: { value: 'bo@example.org, Cy <cy@example.org>' }
    })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Re: Friday at 6' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi Ana,\nSix works.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', {
        draft: {
          bcc: [],
          body: 'Hi Ana,\nSix works.',
          cc: ['bo@example.org', 'Cy <cy@example.org>'],
          reply_to: 'm1',
          subject: 'Re: Friday at 6',
          to: ['ana@example.com']
        },
        mail_action: 'send'
      })
    )
    const settled = useTranscripts.getState().bySession['s-1']!.approvals[0]!
    expect(settled).toMatchObject({ decision: 'once', outcome: { mail_action: 'send' } })
    rerender(<ApprovalCard approval={settled} />)
    expect(screen.getByText('Sent')).toBeVisible()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })

  it('saves to Drafts without someone to send it to, but never sends without one', async () => {
    render(<ApprovalCard approval={card} />)
    fireEvent.change(screen.getByLabelText('To'), { target: { value: ' ' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith(
        's-1',
        'ap-1',
        'once',
        expect.objectContaining({ mail_action: 'save' })
      )
    )
    expect(useTranscripts.getState().bySession['s-1']!.approvals[0]!.outcome?.mail_action).toBe(
      'save'
    )
  })

  it('sends only from Send or Cmd+Enter, never from Enter in a field', async () => {
    render(<ApprovalCard approval={card} />)
    fireEvent.keyDown(screen.getByLabelText('To'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByLabelText('Subject'), { key: 'Enter' })
    expect(approvalRespond).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith(
        's-1',
        'ap-1',
        'once',
        expect.objectContaining({ mail_action: 'send' })
      )
    )
  })

  it('says where to look when the app gave up waiting for the mailbox', async () => {
    vi.mocked(approvalRespond).mockRejectedValueOnce(
      new Error('request timed out after 30s: approval.respond')
    )
    render(<ApprovalCard approval={card} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Gmail is taking a while. Look in Drafts before you save it again.'
    )
    vi.mocked(approvalRespond).mockRejectedValueOnce(
      new Error('request timed out after 30s: approval.respond')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Look in Sent before you send it again.')
    )
  })

  it('keeps unsent edits when the card is shown again', () => {
    const first = render(<ApprovalCard approval={card} />)
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mine, not the bot’s' } })
    first.unmount()
    render(<ApprovalCard approval={card} />)
    expect(screen.getByLabelText('Subject')).toHaveValue('Mine, not the bot’s')
  })

  it('folds to the email another app sent, with its edits', () => {
    useTranscripts.getState().resolveApproval('s-1', 'ap-1', 'once', {
      draft: { ...form, body: 'Sent from my phone.', subject: 'Friday at 6' },
      mail_action: 'send'
    })
    render(<ApprovalCard approval={useTranscripts.getState().bySession['s-1']!.approvals[0]!} />)
    expect(screen.getByText('Friday at 6')).toBeVisible()
    expect(screen.getByText('Sent from my phone.')).toBeVisible()
    expect(screen.getByText('Sent')).toBeVisible()
  })

  it('discards without sending anything and keeps the form when the daemon refuses', async () => {
    vi.mocked(approvalRespond).mockRejectedValueOnce(
      new Error('cy@example isn’t an email address.')
    )
    const { rerender } = render(<ApprovalCard approval={card} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('isn’t an email address')
    expect(screen.getByLabelText('Message')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(approvalRespond).toHaveBeenLastCalledWith('s-1', 'ap-1', 'deny'))
    rerender(<ApprovalCard approval={useTranscripts.getState().bySession['s-1']!.approvals[0]!} />)
    expect(screen.getByText('Not sent')).toBeVisible()
  })

  it('reads addresses separated by commas or semicolons', () => {
    expect(splitAddresses('a@b.co; Bo <bo@c.de>, ,')).toEqual(['a@b.co', 'Bo <bo@c.de>'])
  })

  it('keeps a name that holds a comma with its address', () => {
    expect(
      splitAddresses('Lima, Ana <ana@contoso.com>; "Doe, Jo" <jo@example.com>, bo@example.org')
    ).toEqual(['Lima, Ana <ana@contoso.com>', '"Doe, Jo" <jo@example.com>', 'bo@example.org'])
  })
})
