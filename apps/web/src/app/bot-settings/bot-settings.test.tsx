import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Connector } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'

import { ConnectorsTab } from './connectors'
import {
  deleteNotesQuestion,
  DreamingBlock,
  MemoryEditor,
  noteDay,
  noteDayLabel,
  NotesBlock
} from './memory'
import { ModelTab } from './model'
import { ToolsTab } from './tools'

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

describe('memory editor', () => {
  it('shows the counter and refuses text over the cap', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<MemoryEditor cap={2_000} label="About you" onSave={save} value="hello" />)
    expect(screen.getByText('5 / 2000')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    const input = screen.getByLabelText('About you')
    fireEvent.change(input, { target: { value: 'x'.repeat(2_001) } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('2000 characters or fewer')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves an edit', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<MemoryEditor cap={2_000} label="About you" onSave={save} value="hello" />)
    fireEvent.change(screen.getByLabelText('About you'), { target: { value: 'Name: Alex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith('Name: Alex')
  })
})

describe('notes', () => {
  // The daemon's day, not the client's clock: a Client in another timezone
  // still calls the daemon's files Today and Yesterday.
  const today = '2026-10-07'

  it("names days in the user's words, by the daemon's day", () => {
    expect(noteDayLabel('2026-10-07', today)).toBe('Today')
    expect(noteDayLabel('2026-10-06', today)).toBe('Yesterday')
    expect(noteDayLabel('2026-10-03', today)).toMatch(/Sat/)
    expect(noteDayLabel('2026-10-03', today)).not.toMatch(/2026/)
    expect(noteDayLabel('2025-12-31', today)).toMatch(/2025/)
    expect(noteDayLabel('2026-01-01', '2026-01-02')).toBe('Yesterday')
    expect(noteDay(new Date(2026, 0, 2))).toBe('2026-01-02')
    expect(deleteNotesQuestion('2026-10-07', today)).toBe("Delete today's notes?")
    expect(deleteNotesQuestion('2026-10-06', today)).toBe("Delete yesterday's notes?")
    expect(deleteNotesQuestion('2026-10-03', today)).toMatch(/^Delete the notes for Sat, /)
  })

  it('lists days newest first, edits the chosen day and deletes one', async () => {
    const call = fakeRpc({
      'hexbot.memory.notes.delete': () => ({ deleted: true }),
      'hexbot.memory.notes.list': () => ({
        cap: 4000,
        days: [
          { date: '2026-10-07', text: 'Went over the Q3 export.\nVendor column is stale.' },
          { date: '2026-10-06', text: 'Set up the export.' }
        ],
        retention_days: 30,
        today
      }),
      'hexbot.memory.notes.set': params => ({ cap: 4000, date: params.date, text: params.text })
    })

    render(<NotesBlock bot="scout" />)
    expect(await screen.findByRole('button', { name: /Today/, pressed: true })).toBeVisible()
    expect(screen.getByRole('button', { name: /Yesterday/, pressed: false })).toBeVisible()
    expect(screen.getByText('2 notes')).toBeVisible()
    expect(screen.getByLabelText('Notes for Today')).toHaveValue(
      'Went over the Q3 export.\nVendor column is stale.'
    )
    expect(screen.getByText(/Short notes the bot keeps each day/)).toBeVisible()
    expect(screen.getByText(/Days older than 30 days are removed/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Yesterday/ }))
    expect(screen.getByRole('button', { name: /Yesterday/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    const editor = screen.getByLabelText('Notes for Yesterday')
    expect(editor).toHaveValue('Set up the export.')
    fireEvent.change(editor, { target: { value: 'Set up the export, twice.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.memory.notes.set', {
        bot: 'scout',
        date: '2026-10-06',
        expected: 'Set up the export.',
        text: 'Set up the export, twice.'
      })
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledWith("Delete yesterday's notes?")
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.memory.notes.delete', {
        bot: 'scout',
        date: '2026-10-06',
        expected: 'Set up the export, twice.'
      })
    )
    await waitFor(() => expect(screen.queryByRole('button', { name: /Yesterday/ })).toBeNull())
    // The editor moves to the day that is left.
    expect(screen.getByLabelText('Notes for Today')).toBeVisible()
    confirm.mockRestore()
    setActiveRpc(null)
  })

  it('keeps a note the bot added while the day was being edited', async () => {
    // The day on the daemon gains a line after the tab loaded it.
    let stored = 'Set up the export.'

    const call = fakeRpc({
      'hexbot.memory.notes.list': () => ({
        cap: 4000,
        days: [{ date: today, text: stored }],
        retention_days: 30,
        today
      }),
      'hexbot.memory.notes.set': params => {
        if (params.expected !== stored) {
          throw Object.assign(new Error("The bot added to this day's notes since you opened it."), {
            code: 4209
          })
        }

        stored = String(params.text)

        return { cap: 4000, date: params.date, text: params.text }
      }
    })

    render(<NotesBlock bot="scout" />)
    const editor = await screen.findByLabelText('Notes for Today')
    stored = 'Set up the export.\nAlex wants the CSV too.'
    fireEvent.change(editor, { target: { value: 'Set up the export pipeline.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.memory.notes.set', {
        bot: 'scout',
        date: today,
        expected: 'Set up the export.\nAlex wants the CSV too.',
        text: 'Set up the export pipeline.\nAlex wants the CSV too.'
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Notes for Today')).toHaveValue(
        'Set up the export pipeline.\nAlex wants the CSV too.'
      )
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    // A rewrite must leave the user's draft intact.
    stored = 'Rewritten elsewhere.'
    fireEvent.change(screen.getByLabelText('Notes for Today'), {
      target: { value: 'Set up the export pipeline, again.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Your draft is kept/)
    await waitFor(() =>
      expect(screen.getByLabelText('Notes for Today')).toHaveValue(
        'Set up the export pipeline, again.'
      )
    )
    setActiveRpc(null)
  })

  it('says when there are no notes yet', async () => {
    fakeRpc({
      'hexbot.memory.notes.list': () => ({ cap: 4000, days: [], retention_days: 30, today })
    })
    render(<NotesBlock bot="scout" />)
    expect(await screen.findByText('No notes yet')).toBeVisible()
    expect(screen.getByText(/Short notes the bot keeps each day/)).toBeVisible()
    expect(screen.queryByRole('textbox')).toBeNull()
    setActiveRpc(null)
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
    fireEvent.click(screen.getByLabelText('Enable dreaming'))
    expect(save).toHaveBeenCalledWith({ dream_enabled: false })
    setActiveRpc(null)
  })

  it('shows what a dream changed and restores the memory from before it', async () => {
    const call = fakeRpc({
      'hexbot.dreaming.list': () => ({
        dreams: [
          {
            bot: 'scout',
            id: 'd1',
            memory_after: 'Likes tea\n§\nWorks in Auckland',
            memory_before: 'Likes tea',
            started_at: 1,
            status: 'complete',
            summary: 'Added where the user works.'
          },
          {
            bot: 'scout',
            id: 'd2',
            memory_after: 'Likes tea',
            memory_before: 'Likes tea',
            started_at: 0,
            status: 'complete',
            summary: 'Nothing new.'
          }
        ]
      }),
      'hexbot.dreaming.restore': () => ({ bot: 'scout', memory_md: 'Likes tea' }),
      'hexbot.dreaming.status': () => ({
        enabled: true,
        last_error: null,
        last_run_at: 1,
        last_status: 'complete',
        next_run_at: 2
      })
    })

    const restored = vi.fn()
    render(<DreamingBlock bot={bot} onRestored={restored} onSave={vi.fn()} />)
    expect(await screen.findByText('Dream log')).toBeVisible()
    // Only the dream that changed memory offers a diff.
    expect(screen.getAllByRole('button', { name: 'What changed' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'What changed' }))
    expect(screen.getByText('Likes tea')).toBeVisible()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /Restore memory/ }))
    await waitFor(() => expect(restored).toHaveBeenCalledWith('Likes tea'))
    confirm.mockRestore()
    expect(call).toHaveBeenCalledWith('hexbot.dreaming.restore', { id: 'd1' })
    setActiveRpc(null)
  })
})

describe('model tab', () => {
  it('shows the default reasoning level and saves a new one', async () => {
    fakeRpc({
      'hexbot.models.list': () => ({ all: [], curated: [] }),
      'hexbot.providers.list': () => ({ providers: [] })
    })
    const save = vi.fn()
    render(<ModelTab bot={bot} onSave={save} />)
    const reasoning = screen.getByRole('combobox', { name: 'Reasoning' })
    expect(reasoning).toHaveTextContent('Medium')
    fireEvent.click(reasoning)
    const high = await screen.findByRole('option', { name: 'High' })
    // Base UI commits only a highlighted item, as a pointer over it would be.
    fireEvent.mouseMove(high)
    fireEvent.click(high)
    expect(save).toHaveBeenCalledWith({ reasoning_effort: 'high' })
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

describe('tools tab', () => {
  it('shows only the tools this computer is set up for', () => {
    const onSave = vi.fn()
    render(
      <ToolsTab
        bot={{ ...bot, available_tools: ['terminal', 'files'], tools: ['files'] }}
        onSave={onSave}
      />
    )
    expect(screen.getByRole('switch', { name: 'Files' })).toBeChecked()
    expect(screen.queryByRole('switch', { name: 'Browser' })).not.toBeInTheDocument()
    expect(screen.queryByText('Senses')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Terminal' }))
    expect(onSave).toHaveBeenCalledWith({ tools: ['files', 'terminal'] })
  })

  it('shows every tool when the daemon does not say what is set up', () => {
    render(<ToolsTab bot={bot} onSave={vi.fn()} />)
    expect(screen.getByRole('switch', { name: 'Browser' })).toBeInTheDocument()
  })
})
