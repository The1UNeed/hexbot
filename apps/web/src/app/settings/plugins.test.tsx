import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  accountsDisconnect,
  accountsSignInStart,
  pluginsConfigure,
  pluginsInstall,
  pluginsList,
  pluginsRemove,
  pluginsSetBots,
  skillsSetGlobal
} from '../../lib/api'
import type { Bot, Connector, PluginsList } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { usePlugins } from '../../stores/plugins'

import { PluginsSettings } from './plugins'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  accountsDisconnect: vi.fn().mockResolvedValue({ disconnected: 'gmail' }),
  accountsSignInCancel: vi.fn().mockResolvedValue({}),
  accountsSignInStart: vi.fn(),
  connectorsTest: vi.fn().mockResolvedValue({ message: 'Connected.', ok: true }),
  pluginsConfigure: vi.fn().mockResolvedValue({}),
  pluginsInstall: vi.fn().mockResolvedValue({}),
  pluginsList: vi.fn(),
  pluginsRemove: vi.fn().mockResolvedValue({ removed: true }),
  pluginsSetBots: vi.fn().mockResolvedValue({}),
  skillsSetGlobal: vi.fn().mockResolvedValue({})
}))

vi.mock('../../components/ui/confirm', () => ({ confirm: vi.fn().mockResolvedValue(true) }))

const search: Connector = {
  description: 'Search the web and read pages.',
  enabled_bots: ['hexbot', 'owl'],
  enabled_for_bot: null,
  fields: [],
  group: 'search',
  icon: 'glyph:search',
  id: 'web_search',
  last_error: null,
  name: 'Web search',
  scope: 'daemon',
  state: 'ready',
  state_text: 'Connected'
}

/** A Google or Microsoft connector, not connected unless `email` is given. */
function account(
  id: string,
  name: string,
  provider: 'google' | 'microsoft',
  email: null | string = null,
  change: Partial<PluginsList['connectors'][number]> = {}
): PluginsList['connectors'][number] {
  return {
    abilities: [`Find and read your ${name}`, "Changes follow the bot's approval mode"],
    account: { email, provider, service: id, signed_in: Boolean(email) },
    bots: [],
    description: `Work in ${name}.`,
    enabled_bots: [],
    enabled_for_bot: null,
    family: provider,
    fields: [],
    group: 'work',
    icon: 'glyph:mail',
    id,
    kind: 'connector',
    last_error: null,
    name,
    ready: Boolean(email),
    scope: 'daemon',
    state: email ? 'ready' : 'not_set_up',
    state_text: email ?? 'Not connected',
    ...change
  }
}

/** The sheet a card or a row opened. */
const sheet = (key: string) => within(screen.getByTestId(`sheet-${key}`))

function list(change: Partial<PluginsList> = {}): PluginsList {
  return {
    connectors: [{ ...search, bots: ['hexbot', 'owl'], kind: 'connector', ready: true }],
    packages: [
      {
        bots: ['owl'],
        connector: { ...search, group: 'mcp', id: 'mcp:github', name: 'github' },
        description: 'GitHub issues and pull requests',
        id: 'github',
        installed_by: 'owl',
        kind: 'package',
        name: 'github',
        ready: true,
        server: {
          args: ['-y', 'github-mcp'],
          command: 'npx',
          env: [{ hint: null, key: 'GITHUB_TOKEN', set: false }],
          headers: [],
          transport: 'stdio'
        },
        skills: [{ description: 'File GitHub issues.', name: 'github-issues' }],
        state: 'not_set_up',
        state_text: 'Needs GITHUB_TOKEN'
      }
    ],
    skills: [
      {
        bots: ['hexbot'],
        category: 'productivity',
        description: 'Read and fill PDF files.',
        enabled: true,
        id: 'pdf',
        kind: 'skill',
        name: 'pdf',
        ready: true,
        source: 'bundled'
      }
    ],
    ...change
  }
}

const bot = (name: string, display_name: string, primary = false) =>
  ({ display_name, name, primary }) as Bot

/** Switch to one of the three kinds once the list has loaded. */
async function show(kind: 'Connectors' | 'MCP servers' | 'Skills') {
  const kinds = await screen.findByRole('tablist', { name: 'Plugin kinds' })
  fireEvent.click(await within(kinds).findByRole('tab', { name: new RegExp(`^${kind}`) }))
}

describe('Settings, Plugins', () => {
  beforeEach(() => {
    vi.mocked(pluginsList).mockResolvedValue(list())
    usePlugins.getState().reset()
    useBots.setState({
      byName: { hexbot: bot('hexbot', 'HexBot', true), owl: bot('owl', 'Owl') },
      order: ['owl', 'hexbot']
    })
  })

  it('splits plugins into connectors, MCP servers and skills', async () => {
    render(<PluginsSettings />)
    expect(await screen.findByText('Web search')).toBeInTheDocument()
    expect(screen.getByText('Every bot', { selector: 'span' })).toBeInTheDocument()
    const kinds = screen.getByRole('tablist', { name: 'Plugin kinds' })
    expect(
      within(kinds)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Connectors1', 'MCP servers1', 'Skills1'])
    expect(screen.queryByText('github')).not.toBeInTheDocument()
    await show('MCP servers')
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getByText('Needs GITHUB_TOKEN')).toBeInTheDocument()
    expect(screen.queryByText('Web search')).not.toBeInTheDocument()
    await show('Skills')
    expect(screen.getByText('Productivity')).toBeInTheDocument()
    expect(screen.getByText('pdf')).toBeInTheDocument()
    // Built-in tools live in Settings, Manuals.
    expect(screen.queryByText('Built-in tools')).not.toBeInTheDocument()
    // The primary bot comes first.
    const picker = screen.getByRole('tablist', { name: 'Show plugins for' })
    expect(
      within(picker)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Every bot', 'HexBot', 'Owl'])
  })

  it('searches only the kind you are looking at', async () => {
    render(<PluginsSettings />)
    await show('Skills')
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'web' } })
    expect(screen.getByText('No skill matches that.')).toBeInTheDocument()
    expect(screen.queryByText('Web search')).not.toBeInTheDocument()
  })

  it('chooses the bots that get a package', async () => {
    render(<PluginsSettings />)
    await show('MCP servers')
    fireEvent.click(await screen.findByRole('button', { name: 'github' }))
    const picker = screen.getByRole('group', { name: 'Bots that use github' })
    const hexbot = within(picker).getByRole('switch', { name: 'github for HexBot' })
    expect(hexbot).not.toBeChecked()
    expect(within(picker).getByRole('switch', { name: 'github for Owl' })).toBeChecked()
    fireEvent.click(hexbot)
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('package', 'github', ['owl', 'hexbot'])
    )
    expect(screen.getByText('github-issues')).toBeInTheDocument()
    expect(screen.getByText('Asked for by Owl.')).toBeInTheDocument()
    // Done closes the sheet and leaves the row.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('sheet-package:github')).toBeNull())
    expect(screen.getByRole('button', { name: 'github' })).toBeInTheDocument()
  })

  it('shows one switch per plugin for the bot you pick', async () => {
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Owl' }))
    await show('Skills')
    const toggle = screen.getByRole('switch', { name: 'pdf for Owl' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('skill', 'pdf', ['hexbot', 'owl'])
    )
  })

  it('fills in a server value without sending the others back', async () => {
    render(<PluginsSettings />)
    await show('MCP servers')
    fireEvent.click(await screen.findByRole('button', { name: 'github' }))
    fireEvent.change(screen.getByLabelText('GITHUB_TOKEN for github'), {
      target: { value: 'ghp_0123456789' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save values' }))
    await waitFor(() =>
      expect(pluginsConfigure).toHaveBeenCalledWith('package', 'github', {
        env: { GITHUB_TOKEN: 'ghp_0123456789' }
      })
    )
  })

  it('adds a server with a skill for your bots', async () => {
    render(<PluginsSettings />)
    await show('MCP servers')
    fireEvent.click(await screen.findByRole('button', { name: 'Add MCP server' }))
    fireEvent.change(screen.getByLabelText('MCP server name'), { target: { value: 'linear' } })
    fireEvent.change(screen.getByLabelText('MCP command or URL'), {
      target: { value: 'https://mcp.linear.app/mcp' }
    })
    fireEvent.change(screen.getByLabelText('What the server is for'), {
      target: { value: 'Linear: issues and projects' }
    })
    fireEvent.change(screen.getByLabelText('Skill for your bots'), {
      target: { value: 'File issues in the Core team.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() =>
      expect(pluginsInstall).toHaveBeenCalledWith({
        description: 'Linear: issues and projects',
        mcp: { url: 'https://mcp.linear.app/mcp' },
        name: 'linear',
        skills: [
          {
            content:
              '---\ndescription: "Linear: issues and projects"\n---\nFile issues in the Core team.\n',
            name: 'linear-guide'
          }
        ]
      })
    )
  })

  it('removes a package for every bot', async () => {
    render(<PluginsSettings />)
    await show('MCP servers')
    fireEvent.click(await screen.findByRole('button', { name: 'github' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(pluginsRemove).toHaveBeenCalledWith('github'))
    // The sheet goes with what it showed.
    await waitFor(() => expect(screen.queryByText('github')).not.toBeInTheDocument())
  })

  it('offers set up, not bots, for a plugin that is not set up', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({ connectors: [{ ...unset, bots: [], kind: 'connector', ready: false }] })
    )
    render(<PluginsSettings />)
    // Not connected, it sits on its shelf with what it is for and one button.
    const card = within(await screen.findByTestId('plugin-connector:web_search'))
    expect(card.getByText('Search the web and read pages.')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Set up' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Connected' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Owl' }))
    expect(screen.queryByRole('switch', { name: 'Web search for Owl' })).toBeNull()
    fireEvent.click(card.getByRole('button', { name: 'Set up' }))
    expect(screen.getByText('Set up Web search before giving it to a bot.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Bots that use Web search' })).toBeNull()
    expect(pluginsSetBots).not.toHaveBeenCalled()
  })

  it('still takes a plugin that is not set up away from a bot that has it', async () => {
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({ connectors: [{ ...unset, bots: ['owl'], kind: 'connector', ready: false }] })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Web search' }))
    const picker = screen.getByRole('group', { name: 'Bots that use Web search' })
    expect(within(picker).getByRole('switch', { name: 'Web search for HexBot' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Turn on for every bot' })).toBeNull()
    fireEvent.click(within(picker).getByRole('switch', { name: 'Web search for Owl' }))
    await waitFor(() => expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'web_search', []))
  })

  it('gives a plugin to a bot whose own settings hold its key', async () => {
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [{ ...unset, bots: [], kind: 'connector', ready: false, ready_bots: ['owl'] }]
      })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Web search' }))
    const picker = screen.getByRole('group', { name: 'Bots that use Web search' })
    expect(within(picker).getByRole('switch', { name: 'Web search for HexBot' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Turn on for every bot' })).toBeNull()
    // On for no bot yet, so there is nothing to turn off.
    expect(screen.queryByRole('button', { name: 'Turn off for every bot' })).toBeNull()
    fireEvent.click(within(picker).getByRole('switch', { name: 'Web search for Owl' }))
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'web_search', ['owl'])
    )
  })

  it('keeps a grant waiting for setup when another bot changes', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          {
            ...unset,
            bots: ['owl'],
            kind: 'connector',
            ready: false,
            ready_bots: ['owl'],
            waiting_bots: ['hexbot']
          }
        ]
      })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Web search' }))
    const picker = screen.getByRole('group', { name: 'Bots that use Web search' })
    expect(within(picker).getByRole('switch', { name: 'Web search for HexBot' })).not.toBeChecked()
    fireEvent.click(within(picker).getByRole('switch', { name: 'Web search for Owl' }))
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'web_search', ['hexbot'])
    )
  })

  it('turning a plugin off for every bot also drops a grant waiting for setup', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          {
            ...unset,
            bots: ['owl'],
            kind: 'connector',
            ready: false,
            ready_bots: ['owl'],
            waiting_bots: ['hexbot']
          }
        ]
      })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Web search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off for every bot' }))
    await waitFor(() => expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'web_search', []))
  })

  it('turns a skill that is off for every bot back on', async () => {
    const base = list()
    vi.mocked(pluginsList).mockResolvedValue({
      ...base,
      skills: [{ ...base.skills[0]!, bots: [], disabled_globally: true }]
    })
    render(<PluginsSettings />)
    await show('Skills')
    fireEvent.click(await screen.findByRole('button', { name: 'pdf' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo Off for every bot' }))
    await waitFor(() => expect(skillsSetGlobal).toHaveBeenCalledWith('pdf', true))
  })

  it('shelves what is connected first, then what each account still offers', async () => {
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          { ...search, bots: ['hexbot', 'owl'], kind: 'connector', ready: true },
          account('gmail', 'Gmail', 'google', 'ana@example.com', { bots: ['hexbot'] }),
          account('google_calendar', 'Google Calendar', 'google'),
          account('word', 'Word', 'microsoft')
        ]
      })
    )
    render(<PluginsSettings />)
    const connected = within(await screen.findByRole('region', { name: 'Connected' }))
    // Connected, a card shows its account and the bots that have it.
    const gmail = within(connected.getByTestId('plugin-connector:gmail'))
    expect(gmail.getByText('ana@example.com')).toBeInTheDocument()
    expect(gmail.getByText('HexBot')).toBeInTheDocument()
    expect(gmail.queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(connected.getByTestId('plugin-connector:web_search')).toBeInTheDocument()
    // The rest sit under their account, each with what it is for.
    const google = within(screen.getByRole('region', { name: 'Google' }))
    expect(google.getByText('Work in Google Calendar.')).toBeInTheDocument()
    expect(google.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(google.queryByText('Gmail')).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Microsoft' })).getByText('Word')
    ).toBeInTheDocument()
    // With a bot in view, a connected card carries that bot's switch.
    fireEvent.click(screen.getByRole('tab', { name: 'Owl' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Gmail for Owl' }))
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'gmail', ['hexbot', 'owl'])
    )
    // An account's name finds its connectors.
    fireEvent.change(screen.getByLabelText('Search connectors'), { target: { value: 'microsoft' } })
    expect(screen.getByText('Word')).toBeInTheDocument()
    expect(screen.queryByText('Google Calendar')).toBeNull()
  })

  it('connects a connector, and others of its account, in one sign-in for the bots chosen', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          account('gmail', 'Gmail', 'google'),
          account('google_calendar', 'Google Calendar', 'google', null, {
            waiting_bots: ['owl']
          }),
          account('google_drive', 'Google Drive', 'google', 'ana@example.com'),
          account('word', 'Word', 'microsoft')
        ]
      })
    )
    vi.mocked(accountsSignInStart).mockResolvedValue({
      connected: ['gmail', 'google_calendar'],
      email: 'ana@example.com',
      login_id: 'l1',
      message: 'Connected Gmail and Google Calendar.',
      mode: 'browser',
      service: 'gmail',
      status: 'done',
      url: 'https://accounts.google.com/x'
    })
    render(<PluginsSettings />)
    const card = within(await screen.findByTestId('plugin-connector:gmail'))
    fireEvent.click(card.getByRole('button', { name: 'Connect' }))
    const opened = sheet('connector:gmail')
    expect(opened.getByText('Find and read your Gmail')).toBeInTheDocument()
    // The primary bot gets it unless the user says otherwise.
    const give = opened.getByRole('group', { name: 'Bots that get Gmail' })
    expect(within(give).getByRole('button', { name: 'HexBot' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(give).getByRole('button', { name: 'Owl' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    // Only the same account's connectors that still wait are offered.
    expect(opened.getByLabelText('Also connect Google Calendar')).not.toBeChecked()
    expect(opened.queryByLabelText('Also connect Google Drive')).toBeNull()
    expect(opened.queryByLabelText('Also connect Word')).toBeNull()
    fireEvent.click(opened.getByLabelText('Also connect Google Calendar'))
    fireEvent.click(opened.getByRole('button', { name: 'Sign in with Google' }))
    await waitFor(() =>
      expect(accountsSignInStart).toHaveBeenCalledWith('gmail', ['google_calendar'])
    )
    // Each connector it connected goes to the chosen bot, and a bot that
    // was waiting for one keeps it.
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'gmail', ['hexbot'])
    )
    expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'google_calendar', ['hexbot', 'owl'])
  })

  it('disconnects one connector and signs in again when a sign-in stopped working', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          account('gmail', 'Gmail', 'google', 'ana@example.com', { bots: ['hexbot'] }),
          account('outlook', 'Outlook', 'microsoft', 'sam@contoso.com', {
            ready: false,
            state: 'error',
            state_text: 'Sign in again',
            waiting_bots: ['owl']
          })
        ]
      })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gmail' }))
    const gmail = sheet('connector:gmail')
    expect(gmail.getByText('Signed in as ana@example.com')).toBeInTheDocument()
    expect(gmail.getByRole('switch', { name: 'Gmail for HexBot' })).toBeChecked()
    fireEvent.click(gmail.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(accountsDisconnect).toHaveBeenCalledWith('gmail'))
    fireEvent.click(gmail.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('sheet-connector:gmail')).toBeNull())

    // A sign-in that stopped working asks for it again and keeps its bots.
    const card = within(screen.getByTestId('plugin-connector:outlook'))
    expect(card.getByText('Sign in again')).toBeInTheDocument()
    fireEvent.click(card.getByRole('button', { name: 'Fix' }))
    const outlook = sheet('connector:outlook')
    expect(outlook.getByText(/sign-in for sam@contoso.com stopped working/)).toBeInTheDocument()
    expect(outlook.getByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument()
    expect(outlook.queryByRole('group', { name: 'Bots that get Outlook' })).toBeNull()
    // Its bots wait for the new sign-in; one can be taken off meanwhile,
    // and nothing adds it back.
    const owl = outlook.getByRole('switch', { name: 'Outlook for Owl' })
    expect(owl).toBeChecked()
    expect(outlook.getByRole('switch', { name: 'Outlook for HexBot' })).toBeDisabled()
    fireEvent.click(owl)
    await waitFor(() => expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'outlook', []))
    // A sign-in that no longer works can still be removed.
    fireEvent.click(outlook.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(accountsDisconnect).toHaveBeenCalledWith('outlook'))
  })

  it('takes waiting bots off one after another without bringing one back', async () => {
    vi.mocked(pluginsSetBots).mockClear()
    vi.mocked(pluginsList).mockResolvedValue(
      list({
        connectors: [
          account('outlook', 'Outlook', 'microsoft', 'sam@contoso.com', {
            ready: false,
            state: 'error',
            state_text: 'Sign in again',
            waiting_bots: ['owl', 'hexbot']
          })
        ]
      })
    )
    // The daemon has not answered the first change when the second is made.
    vi.mocked(pluginsSetBots).mockReturnValue(new Promise(() => {}))
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Outlook' }))
    const outlook = sheet('connector:outlook')
    fireEvent.click(outlook.getByRole('switch', { name: 'Outlook for Owl' }))
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenLastCalledWith('connector', 'outlook', ['hexbot'])
    )
    expect(outlook.getByRole('switch', { name: 'Outlook for Owl' })).not.toBeChecked()
    fireEvent.click(outlook.getByRole('switch', { name: 'Outlook for HexBot' }))
    await waitFor(() => expect(pluginsSetBots).toHaveBeenLastCalledWith('connector', 'outlook', []))
    vi.mocked(pluginsSetBots).mockResolvedValue({} as never)
  })

  it('keeps the latest list when an older refresh answers last', async () => {
    let answerOld: (value: PluginsList) => void = () => {}
    vi.mocked(pluginsList)
      .mockImplementationOnce(() => new Promise(resolve => (answerOld = resolve)))
      .mockResolvedValueOnce(list({ connectors: [], packages: [] }))
    const first = usePlugins.getState().refresh()
    await usePlugins.getState().refresh()
    answerOld(list())
    await first
    expect(usePlugins.getState().plugins.map(item => item.id)).toEqual(['pdf'])
    expect(usePlugins.getState().loading).toBe(false)
  })
})
