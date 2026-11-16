import { JsonRpcGatewayError } from '@hermes/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DiscordStatus } from '../../lib/types'
import { useDiscord } from '../../stores/discord'

import { DiscordTab } from './discord'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { room: string } }) => (
    <a href={`/r/${params.room}`}>{children}</a>
  )
}))

const owl = { display_name: 'Owl', name: 'owl', primary: false } as Bot

const online = (patch: Partial<DiscordStatus> = {}): DiscordStatus => ({
  application_id: '900',
  bot: 'owl',
  connected_at: 1,
  error: null,
  invite_url:
    'https://discord.com/oauth2/authorize?client_id=900&scope=bot&permissions=274877975552',
  rooms: [{ channel_name: 'general', guild_name: 'Test Server', id: 'r1' }],
  status: 'online',
  user_id: '100',
  username: 'Owl',
  ...patch
})

describe('a bot in Discord', () => {
  beforeEach(() => {
    useDiscord.setState({ byBot: {}, errors: {} })
  })

  it('walks through making an app, connects with the pasted token, then offers the invite', async () => {
    let connected: DiscordStatus | null = null

    const call = vi.fn((method: string) => {
      if (method === 'hexbot.discord.connect') {
        connected = online({ rooms: [] })

        return Promise.resolve({ discord: connected })
      }

      return Promise.resolve({ discord: connected })
    })

    setActiveRpc({ call } as never)
    render(<DiscordTab bot={owl} />)
    expect(await screen.findByText('2. Under Bot, turn on Message Content Intent')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Discord Developer Portal' })).toHaveAttribute(
      'href',
      'https://discord.com/developers/applications'
    )
    const connect = screen.getByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Discord bot token'), {
      target: { value: '  T-owl  ' }
    })
    fireEvent.click(connect)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.discord.connect', { bot: 'owl', token: 'T-owl' })
    )
    expect(await screen.findByText('Online in Discord')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Add to a server' })).toHaveAttribute(
      'href',
      online().invite_url
    )
    expect(screen.getByText(/then @mention it in a channel/)).toBeVisible()
  })

  it('says why Discord refused a token, beside the field', async () => {
    const call = vi.fn((method: string) =>
      method === 'hexbot.discord.connect'
        ? Promise.reject(
            new JsonRpcGatewayError(
              'Turn on Message Content Intent under Bot in the Discord Developer Portal, then connect again.',
              { code: 4253 }
            )
          )
        : Promise.resolve({ discord: null })
    )

    setActiveRpc({ call } as never)
    render(<DiscordTab bot={owl} />)
    fireEvent.change(await screen.findByLabelText('Discord bot token'), {
      target: { value: 'T-plain' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Turn on Message Content Intent/)
  })

  it('lists its Discord rooms and follows the daemon when the connection drops', async () => {
    let status = online()
    const call = vi.fn(() => Promise.resolve({ discord: status }))

    setActiveRpc({ call } as never)
    render(<DiscordTab bot={owl} />)
    expect(await screen.findByRole('link', { name: /#general/ })).toHaveAttribute('href', '/r/r1')
    expect(screen.getByText(/It never sees About you/)).toBeVisible()

    // The connection drops elsewhere: the daemon says so and the tab follows.
    status = online({
      error: 'Discord closed the connection (4012). Connect again.',
      status: 'error'
    })
    routeEvent({ payload: { bot: 'owl' }, type: 'hexbot.discord.changed' } as never)
    expect(await screen.findByText(/Discord closed the connection/)).toBeVisible()
    expect(screen.getByText('Connect again')).toBeVisible()
  })

  it('asks for a newer daemon when this one has no Discord', async () => {
    setActiveRpc({
      call: vi.fn(() =>
        Promise.reject(
          new JsonRpcGatewayError('unknown method: hexbot.discord.get', { code: -32601 })
        )
      )
    } as never)
    render(<DiscordTab bot={owl} />)
    expect(await screen.findByText('Update the daemon to connect bots to Discord.')).toBeVisible()
  })
})
