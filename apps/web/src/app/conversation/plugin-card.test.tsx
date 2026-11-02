import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'

import { approvalRespond } from '../../lib/api'
import type { ApprovalRequest, PluginForm } from '../../lib/types'
import { useTranscripts } from '../../stores/transcripts'

import { ApprovalCard } from './index'

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal()),
  approvalReceived: vi.fn().mockResolvedValue({}),
  approvalRespond: vi.fn().mockResolvedValue({ resolved: true })
}))

const notion: PluginForm = {
  action: 'setup',
  bot: 'HexBot',
  description: 'Read and write pages and databases in your workspace.',
  fields: [
    {
      help: 'Notion integration token',
      key: 'NOTION_API_KEY',
      label: 'Notion API key',
      secret: true,
      set: false,
      url: 'https://www.notion.so/my-integrations'
    }
  ],
  icon: 'notion',
  id: 'connector:notion',
  kind: 'plugin',
  name: 'Notion'
}

const cardFor = (form: PluginForm): ApprovalRequest => ({
  choices: ['once', 'deny'],
  command: `Set up ${form.name}`,
  form,
  receivedAt: 1,
  requestId: 'ap-1',
  sessionId: 's-1'
})

describe('plugin card', () => {
  beforeEach(() => {
    vi.mocked(approvalRespond).mockClear()
    useTranscripts.getState().dropAll()
    useTranscripts.getState().approvalRequest('s-1', {
      choices: ['once', 'deny'],
      command: 'Set up Notion',
      form: notion,
      request_id: 'ap-1'
    })
  })

  it('keeps the form from a request', () => {
    expect(useTranscripts.getState().bySession['s-1']!.approvals[0]!.form).toEqual(notion)
  })

  it('sets a plugin up behind Connect and sends the key with the answer only', async () => {
    const { rerender } = render(<ApprovalCard approval={cardFor(notion)} />)

    expect(screen.getByRole('group', { name: 'Connect Notion' })).toBeVisible()
    expect(screen.getByText(notion.description!)).toBeVisible()
    expect(screen.queryByLabelText('Notion API key')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    const key = screen.getByLabelText('Notion API key')
    expect(key).toHaveFocus()
    expect(key).toHaveAttribute('type', 'password')
    expect(screen.getByRole('link', { name: 'Get one' })).toHaveAttribute(
      'href',
      'https://www.notion.so/my-integrations'
    )
    const connect = screen.getByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()
    fireEvent.change(key, { target: { value: ' secret_abc ' } })
    fireEvent.click(connect)

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', {
        provider: null,
        values: { NOTION_API_KEY: 'secret_abc' }
      })
    )
    const settled = useTranscripts.getState().bySession['s-1']!.approvals[0]!
    expect(settled.decision).toBe('once')
    expect(JSON.stringify(useTranscripts.getState().bySession['s-1'])).not.toContain('secret_abc')

    rerender(<ApprovalCard approval={settled} />)
    expect(screen.getByText('Saved')).toBeVisible()
    expect(screen.queryByLabelText('Notion API key')).toBeNull()
  })

  it('asks for the chosen provider only, and lets a saved key stay', async () => {
    const search: PluginForm = {
      ...notion,
      fields: [
        { key: 'EXA_API_KEY', label: 'Exa API key', provider: 'exa', set: true, hint: '…a1b2' },
        { key: 'TAVILY_API_KEY', label: 'Tavily API key', provider: 'tavily', set: false }
      ],
      icon: 'glyph:search',
      id: 'connector:web_search',
      name: 'Web search',
      provider: 'exa',
      providers: [
        { id: 'exa', label: 'Exa' },
        { id: 'tavily', label: 'Tavily' }
      ]
    }

    render(<ApprovalCard approval={cardFor(search)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByLabelText('Exa API key')).toHaveAttribute('placeholder', 'Saved …a1b2')
    expect(screen.queryByLabelText('Tavily API key')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Tavily' }))
    expect(screen.queryByLabelText('Exa API key')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Tavily API key'), { target: { value: 'tv-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', {
        provider: 'tavily',
        values: { TAVILY_API_KEY: 'tv-1' }
      })
    )
  })

  it('shows what an install runs, and its keys, and nothing else', async () => {
    const install: PluginForm = {
      action: 'install',
      bot: 'Researcher',
      description: 'GitHub issues and pull requests',
      detail: 'runs the MCP server `npx -y @modelcontextprotocol/server-github` on this computer',
      fields: [{ key: 'GITHUB_TOKEN', label: 'GITHUB_TOKEN', place: 'env', secret: true, set: false }],
      id: 'package:github',
      kind: 'plugin',
      name: 'github',
      other: true,
      run: ['npx -y @modelcontextprotocol/server-github', 'GITHUB_HOST=github.com']
    }

    render(<ApprovalCard approval={cardFor(install)} />)
    expect(screen.getByText('For Researcher')).toBeVisible()
    expect(screen.getByText(/npx -y @modelcontextprotocol\/server-github/)).toHaveTextContent(
      'npx -y @modelcontextprotocol/server-github GITHUB_HOST=github.com'
    )
    expect(screen.getByLabelText('GITHUB_TOKEN')).toBeVisible()
    expect(screen.queryByText(/never sees it/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'once', {
        provider: null,
        values: {}
      })
    )
  })

  it('declines without sending anything typed', async () => {
    render(<ApprovalCard approval={cardFor(notion)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Notion API key'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() =>
      expect(approvalRespond).toHaveBeenCalledWith('s-1', 'ap-1', 'deny', undefined)
    )
  })

  it('keeps the form and says why when the daemon refuses', async () => {
    vi.mocked(approvalRespond).mockRejectedValueOnce(new Error('Enter the Notion API key.'))
    render(<ApprovalCard approval={cardFor(notion)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Notion API key'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the Notion API key.')
    expect(screen.getByLabelText('Notion API key')).toBeVisible()
  })
})
