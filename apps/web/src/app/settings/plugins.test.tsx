import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
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
    fireEvent.click(await screen.findByText('github'))
    const picker = screen.getByRole('group', { name: 'Bots that use github' })
    const hexbot = within(picker).getByRole('button', { name: 'HexBot' })
    expect(hexbot).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(hexbot)
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('package', 'github', ['owl', 'hexbot'])
    )
    expect(screen.getByText('github-issues')).toBeInTheDocument()
    expect(screen.getByText('Asked for by Owl.')).toBeInTheDocument()
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
    fireEvent.click(await screen.findByText('github'))
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
    fireEvent.click(await screen.findByText('github'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(pluginsRemove).toHaveBeenCalledWith('github'))
    await waitFor(() => expect(screen.queryByText('github')).not.toBeInTheDocument())
  })

  it('leaves a connector without a daemon key to the daemon, which knows bot keys', async () => {
    const unset = { ...search, state: 'not_set_up' as const, state_text: 'Not set up' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({ connectors: [{ ...unset, bots: [], kind: 'connector', ready: false }] })
    )
    vi.mocked(pluginsSetBots).mockRejectedValueOnce(
      new Error('Set up Web search before giving it to a bot.')
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByText('Web search'))
    const picker = screen.getByRole('group', { name: 'Bots that use Web search' })
    fireEvent.click(within(picker).getByRole('button', { name: 'HexBot' }))
    expect(
      await screen.findByText('Set up Web search before giving it to a bot.')
    ).toBeInTheDocument()
  })

  it('turns a skill that is off for every bot back on', async () => {
    const base = list()
    vi.mocked(pluginsList).mockResolvedValue({
      ...base,
      skills: [{ ...base.skills[0]!, bots: [], disabled_globally: true }]
    })
    render(<PluginsSettings />)
    await show('Skills')
    fireEvent.click(await screen.findByText('pdf'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo Off for every bot' }))
    await waitFor(() => expect(skillsSetGlobal).toHaveBeenCalledWith('pdf', true))
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
