import type * as Router from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'

import { useConnection } from '../stores/connection'

import { Route } from './connect'

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => vi.fn()
}))

it('shows the lost-key explanation and saved address on the sign-in screen', () => {
  localStorage.clear()
  useConnection.setState({
    target: {
      kind: 'remote',
      host: 'daemon.test',
      port: 443,
      tls: true,
      deviceToken: 'saved-token'
    },
    status: 'unauthorized',
    error: 'The saved device key no longer matches this daemon. Sign in again.'
  })
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The saved device key no longer matches this daemon. Sign in again.'
  )
  expect(screen.getByDisplayValue('daemon.test:443')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in with Hex Connect' })).toBeEnabled()
  expect(useConnection.getState().target).toMatchObject({ deviceToken: 'saved-token' })
})
