import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { accountsSignInStart, pluginsList, pluginsSetBots } from '../../../lib/api'
import type { Bot, PluginsList } from '../../../lib/types'
import { useBots } from '../../../stores/bots'
import { usePluginAccess } from '../../../stores/plugin-access'
import { usePlugins } from '../../../stores/plugins'
import { useUi } from '../../../stores/ui'
import { PluginsSettings } from '../plugins'

vi.mock('../../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  accountsSignInStart: vi.fn(),
  pluginsList: vi.fn(),
  pluginsSetBots: vi.fn().mockResolvedValue({})
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

type Row = PluginsList['connectors'][number]

const connector = (id: string, name: string, bots: string[], change: Partial<Row> = {}): Row => ({
  bots,
  description: '',
  enabled_bots: bots,
  enabled_for_bot: null,
  fields: [],
  group: 'search',
  icon: 'glyph:search',
  id,
  kind: 'connector',
  last_error: null,
  name,
  ready: true,
  scope: 'daemon',
  state: 'ready',
  state_text: 'Connected',
  ...change
})

const gmail = (bots: string[]) =>
  connector('gmail', 'Gmail', bots, {
    account: { email: 'me@work.co', provider: 'google', service: 'gmail', signed_in: true },
    family: 'google',
    group: 'work'
  })

/** Google Calendar: still to connect, or connected by the sign-in the test makes. */
const calendar = (connected: boolean) =>
  connector('google_calendar', 'Google Calendar', [], {
    account: {
      email: connected ? 'me@work.co' : null,
      provider: 'google',
      service: 'google_calendar',
      signed_in: connected
    },
    family: 'google',
    group: 'work',
    ready: connected,
    state: connected ? 'ready' : 'not_set_up'
  })

const list = (gmailBots: string[], calendarConnected = false): PluginsList => ({
  connectors: [
    connector('web_search', 'Web search', ['hexbot', 'ada', 'bea', 'owl']),
    gmail(gmailBots),
    calendar(calendarConnected)
  ],
  packages: [],
  skills: []
})

const bot = (name: string, display_name: string, title = '', primary = false) =>
  ({ display_name, name, primary, title }) as Bot

const cell = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) })

describe('Settings, Plugins as a table', () => {
  beforeEach(() => {
    vi.mocked(pluginsSetBots).mockClear()
    vi.mocked(pluginsList).mockResolvedValue(list(['hexbot']))
    usePlugins.getState().reset()
    usePluginAccess.getState().reset()
    useUi.setState({ accessTable: true })
    useBots.setState({
      byName: {
        ada: bot('ada', 'Ada', 'Sales'),
        bea: bot('bea', 'Bea', 'sales'),
        hexbot: bot('hexbot', 'HexBot', 'Primary bot', true),
        owl: bot('owl', 'Owl', 'Reads papers')
      },
      order: ['owl', 'ada', 'bea', 'hexbot']
    })
  })

  it('stays off until it is switched on in Experimental', async () => {
    useUi.setState({ accessTable: false })
    render(<PluginsSettings />)

    expect(await screen.findByRole('tablist', { name: 'Plugin kinds' })).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('folds bots that share a label and plugins, with one stop for the Tab key', async () => {
    render(<PluginsSettings />)

    const grid = await screen.findByRole('grid', { name: 'Bots and their plugins' })

    await waitFor(() => expect(within(grid).getByText('2 Sales bots')).toBeInTheDocument())
    // A label only one bot carries groups nothing: Owl is a row of its own.
    expect(within(grid).getByRole('button', { name: 'Owl, open its plugins' })).toBeInTheDocument()
    expect(cell('Gmail for HexBot')).toHaveAttribute('aria-checked', 'true')
    expect(cell('Gmail for 2 Sales bots')).toHaveAttribute('aria-checked', 'false')
    // One cell in the tab order, whatever the size of the table.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    // A connector still to connect is not a column; it waits under Add plugin.
    expect(screen.queryByRole('button', { name: /^Google Calendar, / })).not.toBeInTheDocument()
  })

  it('adds an account from the table: choose, sign in, then the bots that get it', async () => {
    vi.mocked(accountsSignInStart).mockResolvedValue({
      connected: ['google_calendar'],
      email: 'me@work.co',
      login_id: 'login-1',
      message: '',
      mode: 'browser',
      service: 'google_calendar',
      status: 'done',
      url: ''
    })
    render(<PluginsSettings />)
    await screen.findByText('2 Sales bots')

    fireEvent.click(screen.getAllByRole('button', { name: 'Add plugin' })[0]!)

    const add = await screen.findByRole('dialog', { name: 'Add a plugin' })

    expect(within(add).getByText('me@work.co · 1 of 2 connected')).toBeInTheDocument()
    fireEvent.click(within(add).getByRole('button', { name: 'Google account' }))

    // What is connected already is listed, and cannot be ticked again.
    const services = await screen.findByRole('dialog', { name: 'Google account' })

    expect(within(services).getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(within(services).queryByRole('checkbox', { name: 'Connect Gmail' })).not.toBeInTheDocument()
    fireEvent.click(within(services).getByRole('checkbox', { name: 'Connect Google Calendar' }))
    fireEvent.click(within(services).getByRole('button', { name: 'Continue with 1' }))

    vi.mocked(pluginsList).mockResolvedValue(list(['hexbot'], true))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))
    await waitFor(() => expect(accountsSignInStart).toHaveBeenCalledWith('google_calendar', [], undefined))

    // Connected, and nobody has it: the last step stages who gets it.
    const give = await screen.findByRole('dialog', { name: 'Give it to bots' })

    expect(within(give).getByText('Google Calendar is connected as me@work.co.')).toBeInTheDocument()
    fireEvent.click(within(give).getByRole('button', { name: /^Sales bots/ }))
    expect(within(give).getByText('2 bots get Google Calendar.')).toBeInTheDocument()
    fireEvent.click(within(give).getByRole('button', { name: 'Add to changes' }))

    expect(cell('Google Calendar for 2 Sales bots')).toHaveAttribute('aria-checked', 'true')
    expect(pluginsSetBots).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Review 1 change' })).toBeInTheDocument()
  })

  it('offers a new sign-in where one stopped working, and keeps grants out of the plugin window', async () => {
    vi.mocked(pluginsList).mockResolvedValue({
      ...list(['hexbot']),
      connectors: [
        connector('web_search', 'Web search', ['hexbot']),
        connector('gmail', 'Gmail', [], {
          account: { email: 'me@work.co', provider: 'google', service: 'gmail', signed_in: true },
          family: 'google',
          group: 'work',
          ready: false,
          state: 'error',
          waiting_bots: ['hexbot']
        })
      ]
    })
    render(<PluginsSettings />)

    expect(await screen.findByText('me@work.co needs a new sign-in.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))

    const again = await screen.findByRole('dialog', { name: 'Sign in again' })

    expect(within(again).getByText(/the bots that had Gmail keep it/)).toBeInTheDocument()
    fireEvent.click(within(again).getByRole('button', { name: 'Close' }))

    // A plugin's own window is about the plugin; its bots are the table's.
    fireEvent.click(screen.getByRole('button', { name: /^Web search, / }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Web search' }))
    await screen.findByTestId('sheet-connector:web_search')
    expect(screen.queryByRole('switch', { name: 'Web search for HexBot' })).not.toBeInTheDocument()
  })

  it('changes nothing until the review is applied, then puts back exactly that on Undo', async () => {
    render(<PluginsSettings />)
    await screen.findByText('2 Sales bots')

    fireEvent.click(cell('Gmail for 2 Sales bots'))
    expect(cell('Gmail for 2 Sales bots')).toHaveAttribute('aria-checked', 'true')
    expect(pluginsSetBots).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Review 1 change' }))

    const review = await screen.findByRole('dialog', { name: 'Review 1 change for 2 bots' })

    expect(within(review).getByText('All 2 Sales bots')).toBeInTheDocument()
    expect(within(review).getByText('Their first plugin from me@work.co')).toBeInTheDocument()

    vi.mocked(pluginsList).mockResolvedValue(list(['hexbot', 'ada', 'bea']))
    fireEvent.click(within(review).getByRole('button', { name: 'Apply 1 change' }))

    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'gmail', ['hexbot', 'ada', 'bea'])
    )

    vi.mocked(pluginsList).mockResolvedValue(list(['hexbot']))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))

    await waitFor(() => expect(pluginsSetBots).toHaveBeenLastCalledWith('connector', 'gmail', ['hexbot']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
  })

  it('keeps the changes that wait when Settings closes, and Undo when it fails', async () => {
    const first = render(<PluginsSettings />)

    await screen.findByText('2 Sales bots')
    fireEvent.click(cell('Gmail for 2 Sales bots'))
    first.unmount()

    render(<PluginsSettings />)
    await screen.findByText('2 Sales bots')
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 change' }))
    vi.mocked(pluginsList).mockResolvedValue(list(['hexbot', 'ada', 'bea']))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 1 change' }))

    vi.mocked(pluginsSetBots).mockRejectedValueOnce(new Error('The daemon did not answer.'))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail: The daemon did not answer.')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('keeps what a plugin refuses staged and says why', async () => {
    vi.mocked(pluginsSetBots).mockRejectedValueOnce(new Error('Set up Gmail before giving it to a bot.'))
    render(<PluginsSettings />)
    await screen.findByText('2 Sales bots')

    fireEvent.click(cell('Gmail for 2 Sales bots'))
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 change' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 1 change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail: Set up Gmail before giving it to a bot.')
    expect(screen.getByRole('button', { name: 'Review 1 change' })).toBeInTheDocument()
  })

  it('takes a sentence, and stops at a word it cannot place', async () => {
    render(<PluginsSettings />)
    await screen.findByText('2 Sales bots')

    const field = screen.getByRole('textbox', { name: 'Find a bot, or type a change' })

    fireEvent.change(field, { target: { value: 'give Sale bots Gmail' } })
    expect(screen.getByText('"sale" is not a bot, a label or a plugin here. Nothing is changed.')).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'give Sales bots Gmail' } })
    expect(screen.getByText('2 Sales bots get Gmail.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add to changes' }))
    expect(screen.getByRole('button', { name: 'Review 1 change' })).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'what does Owl have?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Owl' }))
    expect(await screen.findByRole('dialog', { name: 'Owl, plugins' })).toBeInTheDocument()
  })
})
