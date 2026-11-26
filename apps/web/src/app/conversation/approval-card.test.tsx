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
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Allow for now' })).toBeNull()
  })

  it('offers Allow once, Always allow, and Deny and tucks raw commands behind Show command when titled', () => {
    render(
      <ApprovalCard
        approval={request({
          choices: ['once', 'always', 'deny'],
          command: 'git push origin main',
          reason: 'Pushes commits directly to main.',
          rule: 'Allow pushing to main on origin',
          title: 'Push changes to GitHub'
        })}
      />
    )

    expect(screen.getByText('Push changes to GitHub')).toBeVisible()
    expect(screen.getByText('Pushes commits directly to main.')).toBeVisible()
    expect(screen.getByText('Always allow saves: Allow pushing to main on origin')).toBeVisible()
    expect(screen.queryByText('git push origin main')).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Show command/ }))
    expect(screen.getByText('git push origin main')).toBeVisible()
  })

  it('labels Always allow and shows the saved rule when expanded after answering', () => {
    render(
      <ApprovalCard
        approval={request({
          command: 'git push origin main',
          decision: 'always',
          rule: 'Allow pushing to main on origin',
          title: 'Push changes to GitHub'
        })}
      />
    )

    expect(screen.getByText('Always allowed')).toBeVisible()
    expect(screen.getByText('Push changes to GitHub')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('Saved rule: Allow pushing to main on origin')).toBeVisible()
  })

  it('folds to one line once answered and opens on click', () => {
    render(
      <ApprovalCard approval={request({ command: 'cd /tmp\npython3 run.py', decision: 'once' })} />
    )

    expect(screen.queryByText('Approval needed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.getByText('cd /tmp')).toBeVisible()
    expect(screen.queryByText(/Downloads the dependencies/)).toBeNull()

    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Downloads the dependencies/)).toBeVisible()
    expect(screen.getByText(/python3 run\.py/)).toBeVisible()
  })
})
