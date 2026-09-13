import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Connector } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import { ConnectorsTab } from './connectors'
import { DreamingBlock, MemorySectionEditor } from './memory'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn()
}))

const bot = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Scout',
  dream_enabled: true,
  last_activity_at: 0,
  may_write_core: false,
  model: null,
  name: 'scout',
  owner_id: 'local',
  persona: '',
  provider: null,
  sections_recent: [],
  sections_total: 0,
  shareable: false,
  skills: [],
  title: '',
  tools: [],
  updated_at: 0
} satisfies Bot

const connector = (patch: Partial<Connector>): Connector => ({
  description: 'Read and write pages.',
  enabled_bots: [],
  enabled_for_bot: false,
  fields: [
    {
      advanced: false,
      help: 'Create an internal integration.',
      hint: null,
      key: 'NOTION_API_KEY',
      label: 'Integration token',
      secret: true,
      set: false,
      url: 'https://www.notion.so/my-integrations'
    }
  ],
  group: 'work',
  icon: 'notion',
  id: 'notion',
  last_error: null,
  name: 'Notion',
  scope: 'daemon',
  state: 'not_set_up',
  state_text: 'Not set up',
  ...patch
})

function fakeRpc(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const call = vi.fn((method: string, params: Record<string, unknown> = {}) => {
    const handler = handlers[method]

    return handler
      ? Promise.resolve(handler(params))
      : Promise.reject(new Error(`unexpected ${method}`))
  })

  setActiveRpc({ call } as never)

  return call
}

describe('core memory editor', () => {
  it('shows the counter and refuses text over the section cap', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<MemorySectionEditor cap={4_000} label="user" onSave={save} value="hello" />)
    expect(screen.getByText('5 / 4000')).toBeVisible()
    const input = screen.getByLabelText('user memory')
    fireEvent.change(input, { target: { value: 'x'.repeat(4_001) } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert')).toHaveTextContent('4000 characters or fewer')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('dreaming block', () => {
  it('loads status and updates the per-bot toggle', async () => {
    fakeRpc({
      'hexbot.dreaming.list': () => ({ dreams: [] }),
      'hexbot.dreaming.status': () => ({
        enabled: true,
        last_error: null,
        last_run_at: 1,
        last_status: 'complete',
        next_run_at: 2
      })
    })
    const save = vi.fn().mockResolvedValue(undefined)
    render(<DreamingBlock bot={bot} onSave={save} />)
    expect(await screen.findByText('Dream now')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('May write core memory'))
    expect(save).toHaveBeenCalledWith({ may_write_core: true })
    setActiveRpc(null)
  })
})

describe('connectors page', () => {
  beforeEach(() => {
    useConnectors.setState({ byBot: {}, error: null, loading: false })
  })
  afterEach(() => setActiveRpc(null))

  it('offers Set up, a switch, or Fix depending on the connector state', async () => {
    fakeRpc({
      'hexbot.connectors.list': () => ({
        connectors: [
          connector({}),
          connector({
            enabled_for_bot: true,
            id: 'x_search',
            name: 'X search',
            state: 'ready',
            state_text: 'Connected'
          }),
          connector({
            id: 'linear',
            last_error: { at: 1, text: 'Linear said 401.' },
            name: 'Linear',
            state: 'error',
            state_text: 'Token expired'
          })
        ]
      })
    })
    render(<ConnectorsTab bot={bot} />)
    const notion = await screen.findByTestId('connector-notion')
    expect(notion).toHaveTextContent('Set up')
    expect(screen.getByLabelText('X search for Scout')).toBeChecked()
    expect(screen.getByTestId('connector-linear')).toHaveTextContent('Fix')
    expect(screen.getByTestId('connector-linear')).toHaveTextContent('Token expired')
  })

  it('flips the per-bot switch through the daemon', async () => {
    const call = fakeRpc({
      'hexbot.connectors.list': () => ({
        connectors: [connector({ id: 'x_search', name: 'X search', state: 'ready' })]
      }),
      'hexbot.connectors.set_for_bot': params => ({
        connector: connector({
          enabled_for_bot: Boolean(params.enabled),
          id: 'x_search',
          name: 'X search',
          state: 'ready'
        })
      })
    })

    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByLabelText('X search for Scout'))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.connectors.set_for_bot', {
        bot: 'scout',
        enabled: true,
        id: 'x_search'
      })
    )
    expect(screen.getByLabelText('X search for Scout')).toBeChecked()
  })

  it('keeps the set-up sheet open with the message when the test fails', async () => {
    const call = fakeRpc({
      'hexbot.connectors.list': () => ({ connectors: [connector({})] }),
      'hexbot.connectors.setup': () => ({
        connector: connector({ state: 'error', state_text: 'Refused' }),
        test: { message: 'Notion refused the token.', ok: false }
      })
    })

    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    expect(await screen.findByText('Set up Notion')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Integration token'), {
      target: { value: 'ntn_secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect and test' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Notion refused the token.')
    expect(screen.getByText('Set up Notion')).toBeVisible()
    expect(call).toHaveBeenCalledWith('hexbot.connectors.setup', {
      bot: 'scout',
      bot_only: false,
      enable_for_bot: true,
      id: 'notion',
      values: { NOTION_API_KEY: 'ntn_secret' }
    })
  })

  it('shows only the selected provider’s fields and sends only those', async () => {
    const call = fakeRpc({
      'hexbot.connectors.list': () => ({
        connectors: [
          connector({
            fields: [
              {
                advanced: false,
                help: '',
                hint: null,
                key: 'EXA_API_KEY',
                label: 'Exa API key',
                provider: 'exa',
                secret: true,
                set: false,
                url: null
              },
              {
                advanced: false,
                help: '',
                hint: null,
                key: 'TAVILY_API_KEY',
                label: 'Tavily API key',
                provider: 'tavily',
                secret: true,
                set: false,
                url: null
              }
            ],
            group: 'search',
            icon: 'glyph:search',
            id: 'web_search',
            name: 'Web search',
            provider: null,
            providers: [
              { configured: false, id: 'exa', label: 'Exa' },
              { configured: false, id: 'tavily', label: 'Tavily' }
            ]
          })
        ]
      }),
      'hexbot.connectors.setup': () => ({
        connector: connector({ id: 'web_search', state: 'ready', state_text: 'Connected' }),
        test: { message: 'Connected.', ok: true }
      })
    })

    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    // The first provider is selected by default, so only its field shows.
    expect(await screen.findByLabelText('Exa API key')).toBeVisible()
    expect(screen.queryByLabelText('Tavily API key')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Exa API key'), { target: { value: 'exa_1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect and test' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.connectors.setup', {
        bot: 'scout',
        bot_only: false,
        enable_for_bot: true,
        id: 'web_search',
        provider: 'exa',
        values: { EXA_API_KEY: 'exa_1' }
      })
    )
  })

  it('closes the sheet once the test passes', async () => {
    fakeRpc({
      'hexbot.connectors.list': () => ({ connectors: [connector({})] }),
      'hexbot.connectors.setup': () => ({
        connector: connector({ state: 'ready', state_text: 'Connected' }),
        test: { message: 'Connected.', ok: true }
      })
    })
    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    fireEvent.change(await screen.findByLabelText('Integration token'), {
      target: { value: 'ntn_secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect and test' }))
    await waitFor(() => expect(screen.queryByText('Set up Notion')).not.toBeInTheDocument())
  })
})
