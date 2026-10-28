import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import {
  pluginsConfigure,
  pluginsInstall,
  pluginsList,
  pluginsRemove,
  pluginsSetBots
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
  pluginsSetBots: vi.fn().mockResolvedValue({})
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
    capabilities: [
      {
        bots: [],
        description: 'Use the shared computer.',
        id: 'computer_use',
        kind: 'capability',
        name: 'Computer use',
        ready: false,
        setup: 'Install Cua with `uv tool install cua` and start Docker.'
      }
    ],
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

describe('Settings, Plugins', () => {
  beforeEach(() => {
    vi.mocked(pluginsList).mockResolvedValue(list())
    usePlugins.getState().reset()
    useBots.setState({
      byName: { hexbot: bot('hexbot', 'HexBot', true), owl: bot('owl', 'Owl') },
      order: ['owl', 'hexbot']
    })
  })

  it('puts connectors, MCP servers, skills and built-in tools on one page', async () => {
    render(<PluginsSettings />)
    const connectors = await screen.findByRole('region', { name: 'Connectors' })
    expect(within(connectors).getByText('Web search')).toBeInTheDocument()
    expect(within(connectors).getByText('Every bot')).toBeInTheDocument()
    const servers = screen.getByRole('region', { name: 'MCP servers' })
    expect(within(servers).getByText('github')).toBeInTheDocument()
    expect(within(servers).getByText('Needs GITHUB_TOKEN')).toBeInTheDocument()
    expect(within(servers).getByText('Owl')).toBeInTheDocument()
    const skills = screen.getByRole('region', { name: 'Skills' })
    expect(within(skills).getByText('Productivity')).toBeInTheDocument()
    expect(within(skills).getByText('pdf')).toBeInTheDocument()
    const tools = screen.getByRole('region', { name: 'Built-in tools' })
    expect(within(tools).getByText(/uv tool install cua/)).toBeInTheDocument()
    // The primary bot comes first.
    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent)
    expect(tabs).toEqual(['Every bot', 'HexBot', 'Owl'])
  })

  it('chooses the bots that get a package', async () => {
    render(<PluginsSettings />)
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
    const toggle = screen.getByRole('switch', { name: 'pdf for Owl' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(pluginsSetBots).toHaveBeenCalledWith('skill', 'pdf', ['hexbot', 'owl'])
    )
    // A built-in tool that isn't set up says so instead of offering a switch.
    expect(screen.queryByRole('switch', { name: 'Computer use for Owl' })).not.toBeInTheDocument()
  })

  it('fills in a server value without sending the others back', async () => {
    render(<PluginsSettings />)
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
    fireEvent.click(await screen.findByText('github'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(pluginsRemove).toHaveBeenCalledWith('github'))
    await waitFor(() => expect(screen.queryByText('github')).not.toBeInTheDocument())
  })

  it('takes a plugin that is not set up away but does not give it', async () => {
    const broken = { ...search, state: 'error' as const, state_text: 'Key rejected' }
    vi.mocked(pluginsList).mockResolvedValue(
      list({ connectors: [{ ...broken, bots: ['owl'], kind: 'connector', ready: false }] })
    )
    render(<PluginsSettings />)
    fireEvent.click(await screen.findByText('Web search'))
    const picker = screen.getByRole('group', { name: 'Bots that use Web search' })
    expect(within(picker).getByRole('button', { name: 'HexBot' })).toBeDisabled()
    fireEvent.click(within(picker).getByRole('button', { name: 'Owl' }))
    await waitFor(() => expect(pluginsSetBots).toHaveBeenCalledWith('connector', 'web_search', []))
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
    expect(usePlugins.getState().plugins.map(item => item.id)).toEqual(['pdf', 'computer_use'])
    expect(usePlugins.getState().loading).toBe(false)
  })
})
