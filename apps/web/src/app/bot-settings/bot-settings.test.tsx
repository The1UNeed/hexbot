import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { vi } from 'vitest'

import { ConfirmHost } from '../../components/ui/confirm'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, Connector } from '../../lib/types'
import { useConnectors } from '../../stores/connectors'
import { useMe } from '../../stores/me'

import { ApprovalsTab } from './approvals'
import { ConnectorsTab } from './connectors'
import {
  deleteNotesQuestion,
  DreamingBlock,
  MemoryEditor,
  MemoryTab,
  noteDay,
  noteDayLabel,
  NotesBlock
} from './memory'
import { ModelTab } from './model'
import { PersonaTab } from './persona'
import { requirementText, SkillsTab } from './skills'
import { ToolsTab } from './tools'

const router = vi.hoisted(() => ({
  history: { location: {}, subscribe: () => () => undefined },
  subscribe: () => () => undefined
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => router,
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
    expect(save).toHaveBeenCalledWith('Name: Alex', 'hello')
  })
})

describe('soul and memory limits', () => {
  it('counts the soul against its limit and keeps a soul over it from saving', () => {
    const save = vi.fn()
    render(<PersonaTab bot={{ ...bot, persona: 'hello', soul_cap: 10 }} onSave={save} />)
    expect(screen.getByText(/5 \/ 10 characters/)).toBeVisible()
    const soul = screen.getByLabelText('Soul')
    fireEvent.change(soul, { target: { value: 'x'.repeat(11) } })
    fireEvent.blur(soul)
    expect(screen.getByRole('alert')).toHaveTextContent('11 / 10 characters · shorten it to save')
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(soul, { target: { value: 'x'.repeat(10) } })
    fireEvent.blur(soul)
    expect(save).toHaveBeenCalledWith({ persona: 'x'.repeat(10) })
  })

  it("sets the bot's own limit, refuses one out of range, and empties back to the default", () => {
    const save = vi.fn()
    const { rerender } = render(<PersonaTab bot={{ ...bot, soul_cap: 4000 }} onSave={save} />)
    const limit = screen.getByLabelText('Soul limit')
    expect(limit).toHaveAttribute('placeholder', '4000')
    fireEvent.change(limit, { target: { value: '100' } })
    fireEvent.blur(limit)
    expect(screen.getByRole('alert')).toHaveTextContent('Use a whole number from 500 to 20,000.')
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(limit, { target: { value: '6000' } })
    fireEvent.blur(limit)
    expect(save).toHaveBeenCalledWith({ soul_char_limit: 6000 })
    rerender(<PersonaTab bot={{ ...bot, soul_cap: 6000, soul_char_limit: 6000 }} onSave={save} />)
    expect(screen.getByText(/0 \/ 6000 characters/)).toBeVisible()
    fireEvent.change(limit, { target: { value: '' } })
    fireEvent.blur(limit)
    expect(save).toHaveBeenLastCalledWith({ soul_char_limit: null })
  })

  it('leaves the soul unlimited and offers no limit on a daemon from before limits', () => {
    const save = vi.fn()
    render(<PersonaTab bot={bot} onSave={save} />)
    expect(screen.queryByLabelText('Soul limit')).toBeNull()
    const soul = screen.getByLabelText('Soul')
    fireEvent.change(soul, { target: { value: 'x'.repeat(5000) } })
    fireEvent.blur(soul)
    expect(screen.getByText(/5000 characters/)).toBeVisible()
    expect(save).toHaveBeenCalledWith({ persona: 'x'.repeat(5000) })
  })
})

describe('memory tab', () => {
  it('keeps the limit, notes and dreaming but leaves editing memory to the Fingerprint tab', async () => {
    const call = fakeRpc({
      'hexbot.dreaming.list': () => ({ dreams: [] }),
      'hexbot.dreaming.status': () => ({ enabled: true, last_error: null, next_run_at: 2 }),
      'hexbot.memory.notes.list': () => ({
        cap: 4000,
        days: [],
        retention_days: 30,
        today: '2026-11-04'
      })
    })

    const save = vi.fn()
    render(<MemoryTab bot={{ ...bot, memory_cap: 2200 }} onSave={save} />)
    expect(await screen.findByText('Dream now')).toBeVisible()
    expect(screen.queryByLabelText('Bot memory')).toBeNull()
    expect(call).not.toHaveBeenCalledWith('hexbot.memory.bot.get', expect.anything())
    const limit = screen.getByLabelText('Memory limit')
    fireEvent.change(limit, { target: { value: '3000' } })
    fireEvent.blur(limit)
    expect(save).toHaveBeenCalledWith({ memory_char_limit: 3000 })
    setActiveRpc(null)
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

    render(
      <>
        <NotesBlock bot="scout" />
        <ConfirmHost />
      </>
    )
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const question = await screen.findByRole('alertdialog')
    expect(question).toHaveTextContent("Delete yesterday's notes?")
    expect(call).not.toHaveBeenCalledWith('hexbot.memory.notes.delete', expect.anything())
    fireEvent.click(within(question).getByRole('button', { name: 'Yes' }))
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
    render(
      <>
        <DreamingBlock bot={bot} onRestored={restored} onSave={vi.fn()} />
        <ConfirmHost />
      </>
    )
    expect(await screen.findByText('Dream log')).toBeVisible()
    // Only the dream that changed memory offers a diff.
    expect(screen.getAllByRole('button', { name: 'What changed' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'What changed' }))
    expect(screen.getByText('Likes tea')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Restore memory/ }))
    const question = await screen.findByRole('alertdialog')
    expect(question).toHaveTextContent('Restore the memory from before this dream?')
    fireEvent.click(within(question).getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(restored).toHaveBeenCalledWith('Likes tea'))
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

  it('offers fast mode only on a model that has it, in both directions', async () => {
    const opus = { fast: true, id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' }
    const sonnet = { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' }
    fakeRpc({
      'hexbot.models.list': () => ({ all: [sonnet], curated: [opus] }),
      'hexbot.providers.list': () => ({ providers: [] })
    })
    const save = vi.fn()
    const onOpus = { ...bot, model: opus.id, provider: 'anthropic' }
    const { rerender } = render(<ModelTab bot={onOpus} onSave={save} />)
    const fast = await screen.findByRole('switch', { name: 'Fast mode' })
    expect(fast).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(fast)
    expect(save).toHaveBeenLastCalledWith({ fast: true })
    rerender(<ModelTab bot={{ ...onOpus, fast: true }} onSave={save} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    expect(save).toHaveBeenLastCalledWith({ fast: false })
    rerender(<ModelTab bot={{ ...onOpus, model: sonnet.id }} onSave={save} />)
    expect(screen.queryByRole('switch', { name: 'Fast mode' })).toBeNull()
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

  const xSearch = (configured: boolean) =>
    connector({
      fields: [],
      id: 'x_search',
      name: 'X search',
      providers: [
        { configured, id: 'supergrok', label: 'SuperGrok or X Premium+', sign_in: 'xai-oauth' },
        { configured: false, id: 'x_api', label: 'X API' }
      ]
    })

  it('asks for the X search subscription sign-in before anything else', async () => {
    fakeRpc({ 'hexbot.connectors.list': () => ({ connectors: [xSearch(false)] }) })
    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    // Not signed in: the sign-in is the one primary button.
    expect(await screen.findByRole('button', { name: 'Sign in with xAI' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Connect and test' })).toBeNull()
    // The sign-in is the daemon's: there is no value to keep for one bot.
    expect(screen.queryByLabelText('Bot only')).toBeNull()
  })

  it('keeps a value for one bot on the provider the other bots use', async () => {
    const field = (key: string, label: string, provider: string) => ({
      advanced: false,
      help: '',
      hint: null,
      key,
      label,
      provider,
      secret: true,
      set: provider === 'x_api',
      url: null
    })

    const keyed = connector({
      fields: [field('X_BEARER_TOKEN', 'Bearer token', 'x_api'), field('XAI_API_KEY', 'xAI key', 'xai')],
      id: 'x_search',
      name: 'X search',
      provider: 'x_api',
      providers: [
        { configured: true, id: 'x_api', label: 'X API' },
        { configured: false, id: 'xai', label: 'xAI API' }
      ],
      state: 'error'
    })

    fakeRpc({ 'hexbot.connectors.list': () => ({ connectors: [keyed] }) })
    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }))
    expect(await screen.findByLabelText('Bot only')).toBeVisible()
    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    const xai = await screen.findByRole('option', { name: 'xAI API' })
    fireEvent.mouseMove(xai)
    fireEvent.click(xai)
    // Another provider is set up for every bot, never for one alone.
    await waitFor(() => expect(screen.queryByLabelText('Bot only')).toBeNull())
  })

  it('connects X search with a subscription already signed in', async () => {
    const call = fakeRpc({
      'hexbot.connectors.list': () => ({ connectors: [xSearch(true)] }),
      'hexbot.connectors.setup': () => ({
        connector: xSearch(true),
        test: { message: 'Signed in.', ok: true }
      })
    })

    render(<ConnectorsTab bot={bot} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    expect(await screen.findByText('Signed in.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Connect and test' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('hexbot.connectors.setup', {
        bot: 'scout',
        bot_only: false,
        enable_for_bot: true,
        id: 'x_search',
        provider: 'supergrok',
        values: {}
      })
    )
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
    expect(screen.queryByRole('switch', { name: 'Vision' })).not.toBeInTheDocument()
    expect(screen.queryByText('Senses')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Terminal' }))
    expect(onSave).toHaveBeenCalledWith({ tools: ['files', 'terminal'] })
  })

  it('shows every tool when the daemon does not say what is set up', () => {
    render(<ToolsTab bot={bot} onSave={vi.fn()} />)
    expect(screen.getByRole('switch', { name: 'Vision' })).toBeInTheDocument()
  })

  it('leaves Computer use, code and the browser to Settings, Manuals', () => {
    render(<ToolsTab bot={bot} onSave={vi.fn()} />)

    for (const name of ['Computer use', 'Code execution', 'Browser']) {
      expect(screen.queryByRole('switch', { name })).not.toBeInTheDocument()
    }

    expect(screen.getByText('Working directory')).toBeInTheDocument()
  })
})

describe('bot approvals on older daemons', () => {
  it.each([
    ['member', 'smart', false],
    ['member', 'off', true],
    ['admin', 'smart', true],
    [undefined, 'smart', true]
  ] as const)('role %s, mode %s offers Bypass: %s', (role, approval_mode, bypass) => {
    useMe.setState({ me: { display_name: 'Alex', id: 'local', role } })
    render(<ApprovalsTab bot={{ ...bot, approval_mode }} onSave={vi.fn()} />)
    expect(screen.queryByRole('radio', { name: /^Bypass/ }) !== null).toBe(bypass)
    expect(screen.getByRole('radio', { name: /^Auto/ })).toBeVisible()
    expect(screen.getByRole('radio', { name: /^Manual/ })).toBeVisible()

    if (approval_mode === 'off') {
      expect(screen.getByRole('radio', { name: /^Bypass/ })).toBeChecked()
    }
  })
})

describe('skills', () => {
  it('shows what a skill waiting for setup needs and leaves it out of the saved list', async () => {
    fakeRpc({
      'hexbot.skills.list': () => ({
        skills: [
          {
            category: 'apple',
            description: 'Send texts.',
            enabled: false,
            enabled_for_bot: true,
            missing: [{ kind: 'command', name: 'imsg' }],
            name: 'imessage',
            ready: false
          },
          {
            category: 'apple',
            description: 'Write notes.',
            enabled: false,
            enabled_for_bot: false,
            missing: [],
            name: 'notes',
            ready: true
          }
        ]
      })
    })
    const save = vi.fn().mockResolvedValue(undefined)
    render(<SkillsTab bot={bot} onSave={save} />)

    expect(await screen.findByText('Needs imsg installed')).toBeVisible()
    const waiting = screen.getByRole('switch', { name: 'imessage' })
    expect(waiting).toBeDisabled()
    expect(waiting).not.toBeChecked()

    fireEvent.click(screen.getByRole('switch', { name: 'notes' }))
    expect(save).toHaveBeenCalledWith({ skills: ['notes'] })
  })

  it('names platforms and keys in plain words', () => {
    expect(
      requirementText([
        { kind: 'platform', name: ['macos'] },
        { kind: 'env', name: 'TENOR_API_KEY' }
      ])
    ).toBe('Only on macOS · Needs TENOR_API_KEY')
  })
})
