import { fireEvent, render, screen } from '@testing-library/react'

import type { ApprovalRequest } from '../../lib/types'

import { ApprovalCard } from './index'

const request = (overrides: Partial<ApprovalRequest>): ApprovalRequest => ({
  choices: ['once', 'session', 'deny'],
  command: 'npm install',
  reason: 'Run outside the sandbox. Downloads the dependencies.',
  receivedAt: 1,
  requestId: 'ap-1',
  sessionId: 's-1',
  ...overrides
})

describe('approval card', () => {
  it('offers only the choices the request carries', () => {
    render(<ApprovalCard approval={request({ choices: ['once', 'deny'] })} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Allow for now' })).toBeNull()
  })

  it('labels an Always allow choice from an older daemon', () => {
    const { unmount } = render(
      <ApprovalCard approval={request({ choices: ['once', 'session', 'always', 'deny'] })} />
    )

    expect(screen.getByRole('button', { name: 'Always allow' })).toBeVisible()
    unmount()
    render(<ApprovalCard approval={request({ decision: 'always' })} />)
    expect(screen.getByText('Always allowed')).toBeVisible()
  })

  it('folds to one line once answered and opens on click', () => {
    render(
      <ApprovalCard
        approval={request({ command: 'cd /tmp\npython3 run.py', decision: 'once' })}
      />
    )

    expect(screen.queryByText('Approval needed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('cd /tmp')).toBeVisible()
    expect(screen.queryByText(/Downloads the dependencies/)).toBeNull()

    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Downloads the dependencies/)).toBeVisible()
    expect(screen.getByText(/python3 run\.py/)).toBeVisible()
  })
})
