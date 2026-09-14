import { fireEvent, render, screen } from '@testing-library/react'

import { useConnection } from '../stores/connection'

import { ConnectionLost, useConnectionLost } from './connection-lost'

const navigate = vi.fn()
const retryNow = vi.fn(() => Promise.resolve())
let pathname = '/b/scout/s/daily'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname } })
}))

vi.mock('../lib/bridge', () => ({
  getBridge: () => null,
  hasLocalRuntime: () => false
}))

vi.mock('../lib/connection', () => ({
  getSupervisor: () => ({ retryNow }),
  setLocalDaemonPort: vi.fn()
}))

function Harness() {
  return useConnectionLost() ? <ConnectionLost /> : <p>app</p>
}

describe('ConnectionLost', () => {
  beforeEach(() => {
    pathname = '/b/scout/s/daily'
    navigate.mockClear()
    retryNow.mockClear()
    useConnection.setState({
      attempt: 0,
      daemon: null,
      status: 'connected',
      target: { kind: 'local' }
    })
  })

  it('stays out of the way while connected', () => {
    render(<Harness />)

    expect(screen.getByText('app')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-lost')).not.toBeInTheDocument()
  })

  it('locks the window when the connection drops', () => {
    useConnection.setState({
      attempt: 3,
      daemon: { daemon_name: 'Studio' } as never,
      status: 'reconnecting'
    })
    render(<Harness />)

    const dialog = screen.getByRole('alertdialog', { name: 'Connection lost' })

    expect(dialog).toHaveFocus()
    expect(dialog).toHaveTextContent('Hexbot lost its connection to Studio.')
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting, attempt 3…')
    expect(screen.queryByText('app')).not.toBeInTheDocument()
  })

  it('locks the app pages when the daemon never answered', () => {
    useConnection.setState({ status: 'offline' })
    render(<Harness />)

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Hexbot cannot reach the daemon.')
  })

  it.each(['/connect', '/onboarding'])('leaves %s to its own first contact', page => {
    pathname = page
    useConnection.setState({ status: 'offline' })
    render(<Harness />)

    expect(screen.getByText('app')).toBeInTheDocument()
  })

  it('covers onboarding once a connection it had drops', () => {
    pathname = '/onboarding'
    useConnection.setState({ status: 'reconnecting' })
    render(<Harness />)

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('never covers the connect screen', () => {
    pathname = '/connect'
    useConnection.setState({ status: 'reconnecting' })
    render(<Harness />)

    expect(screen.getByText('app')).toBeInTheDocument()
  })

  it('retries now and offers another daemon', () => {
    useConnection.setState({ status: 'reconnecting' })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(retryNow).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Connect to another daemon' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/connect' })
  })
})
