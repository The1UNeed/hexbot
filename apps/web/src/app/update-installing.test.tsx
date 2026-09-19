import { render, screen } from '@testing-library/react'

import { useUpdates } from '../stores/updates'

import { UpdateInstalling } from './update-installing'

describe('UpdateInstalling', () => {
  it('names the version and offers no buttons', () => {
    useUpdates.getState().setApp({
      availableVersion: '0.1.6',
      channel: 'stable',
      checkedAt: null,
      currentVersion: '0.1.5',
      downloadedVersion: '0.1.6',
      errorContext: null,
      message: null,
      percent: 100,
      status: 'installing'
    })
    render(<UpdateInstalling />)
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Hexbot is installing version 0.1.6 and will restart when it is done.'
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
