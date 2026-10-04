import { DeviceProofError } from '@hermes/shared'
import type * as Router from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'

import { useConnection } from '../stores/connection'

import { Route } from './connect'

vi.mock('../lib/dpop', () => ({
  proofHeaders: async () => ({}),
  deviceKey: async () => null,
  deviceProof: vi.fn()
}))

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => vi.fn()
}))

beforeEach(() => {
  localStorage.clear()
  useConnection.setState({ target: null, error: null, proofError: null })
})
afterEach(() => {
  delete window.hexbot
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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
    proofError: new DeviceProofError('dpop_key_mismatch')
  })
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The saved device key no longer matches this daemon. Pair it again.'
  )
  expect(screen.getByDisplayValue('daemon.test:443')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in with Hex Connect' })).toBeEnabled()
  expect(useConnection.getState().target).toMatchObject({ deviceToken: 'saved-token' })
})

it.each([
  [{ code: 'invalid_code' }, 'The pairing code is invalid or expired.'],
  [
    { code: 'dpop_clock_skew', serverTime: 1000, proofTime: 1600 },
    "This device's clock differs from the daemon by 10 minutes. Check both clocks, then retry."
  ],
  [{ code: 'dpop_proof_required' }, 'The app could not load its saved key. Retry the connection.'],
  [{ code: 'unreachable' }, 'The daemon could not be reached.']
])('maps bridge error codes to renderer copy: %j', async (error, message) => {
  const pair = vi.fn(async () => ({ ok: false as const, error }))
  window.hexbot = { pair } as unknown as Window['hexbot']
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)
  fireEvent.change(screen.getByTestId('connect-code-input'), { target: { value: 'CODE' } })
  fireEvent.click(screen.getByTestId('connect-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(pair).toHaveBeenCalledOnce()
  expect(
    screen.queryByText(/Error invoking remote method|Allow browser storage/)
  ).not.toBeInTheDocument()
})

it('never renders a raw IPC exception or a stale network error', async () => {
  useConnection.setState({ error: 'Failed to fetch' })
  window.hexbot = {
    pair: vi
      .fn()
      .mockRejectedValue(new Error("Error invoking remote method 'hexbot:pair': secret diagnostic"))
  } as unknown as Window['hexbot']
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('connect-code-input'), { target: { value: 'CODE' } })
  fireEvent.click(screen.getByTestId('connect-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent('The daemon could not be reached.')
  expect(screen.queryByText(/secret diagnostic|Failed to fetch/)).not.toBeInTheDocument()
})

it('does not save a keyless target when this page cannot keep its sign-in cookie', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/api/auth/ws-ticket')
        ? new Response('', { status: 401 })
        : new Response('{"ok":true,"daemon_name":"Studio"}')
    )
  )
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)
  fireEvent.change(screen.getByTestId('connect-code-input'), { target: { value: 'CODE' } })
  fireEvent.click(screen.getByTestId('connect-submit'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    "This browser can't keep a key or a sign-in cookie for Studio from this page. Open http://127.0.0.1:9119 directly to connect to Studio."
  )
  expect(useConnection.getState().target).toBeNull()
  expect(localStorage.getItem('hexbot.target')).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('checks cookie acceptance before saving a keyless Connect target', async () => {
  localStorage.setItem('hexbot.connect.session', 'session')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/daemons')) {
        return new Response(
          '{"daemons":[{"id":"studio","name":"Studio","tunnel_hostname":"studio.test"}]}'
        )
      }

      if (url.endsWith('/grant')) {
        return new Response(
          '{"grant":"grant","daemon":{"host":"studio.test","port":443,"tls":true}}'
        )
      }

      if (url.endsWith('/api/auth/ws-ticket')) {
        return new Response('', { status: 401 })
      }

      return new Response('{"ok":true}')
    })
  )
  const ConnectPage = Route.options.component as ComponentType
  render(<ConnectPage />)
  fireEvent.click(await screen.findByRole('button', { name: /Studio/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    "This browser can't keep a key or a sign-in cookie for Studio from this page."
  )
  expect(useConnection.getState().target).toBeNull()
  expect(localStorage.getItem('hexbot.target')).toBeNull()
})
