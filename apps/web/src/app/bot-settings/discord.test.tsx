import { JsonRpcGatewayError } from '@hermes/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DiscordStatus } from '../../lib/types'
import { useDiscord } from '../../stores/discord'
import { usePlugins } from '../../stores/plugins'

import { DiscordTab } from './discord'

const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { room: string } }) => (
    <a href={`/r/${params.room}`}>{children}</a>
  ),
  useNavigate: () => navigate
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
    navigate.mockReset()
  })

  it('stays off until Discord is turned on for the bot in Plugins', () => {
    setActiveRpc({ call: vi.fn() } as never)
    render(<DiscordTab bot={{ ...owl, discord: false }} />)
    expect(screen.getByText('Discord is off for Owl.')).toBeVisible()
    expect(screen.queryByLabelText('Discord bot token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Plugins' }))
    expect(navigate).toHaveBeenCalledWith({ params: { tab: 'plugins' }, to: '/settings/$tab' })
    expect(usePlugins.getState().sought).toEqual({ kind: 'plugin', name: 'Discord' })
  })

  it('chooses how the bot acts, for every server and for one', async () => {
    let status = online({
      mode: 'reads',
      servers: [
        { id: 'g1', mode: null, name: 'Friends' },
        { id: 'g2', mode: null, name: 'Community' }
      ]
    })

    const call = vi.fn((method: string, params: { guild_id?: string; mode: string }) => {
      if (method === 'hexbot.discord.set_mode') {
        status = params.guild_id
          ? {
              ...status,
              servers: status.servers!.map(server =>
                server.id === params.guild_id ? { ...server, mode: params.mode as never } : server
              )
            }
          : { ...status, mode: params.mode as never }
      }

      return Promise.resolve({ discord: status })
    })

    setActiveRpc({ call } as never)
    render(<DiscordTab bot={{ ...owl, discord: true }} />)
    const group = await screen.findByRole('radiogroup', { name: 'How Owl acts in Discord' })
    expect(screen.getByRole('radio', { name: /Mentions, reads along/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(group).toBeVisible()
    expect(screen.getByText('Each server can have its own choice below.')).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: /Mentions only/ }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.discord.set_mode', { bot: 'owl', mode: 'mentions' })
    )
    expect(await screen.findByRole('radio', { checked: true, name: /Mentions only/ })).toBeVisible()
    // One server where it joins in, and the cost of that said.
    fireEvent.click(screen.getByRole('combobox', { name: 'How Owl acts in Community' }))
    const active = await screen.findByRole('option', { name: 'Active member' })
    // Base UI commits only a highlighted item, as a pointer over it would be.
    fireEvent.mouseMove(active)
    fireEvent.click(active)
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.discord.set_mode', {
        bot: 'owl',
        guild_id: 'g2',
        mode: 'active'
      })
    )
    expect(await screen.findByText(/spends tokens on messages that don't mention it/)).toBeVisible()
    expect(screen.getByText(/change its permissions in Discord/)).toBeVisible()
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
