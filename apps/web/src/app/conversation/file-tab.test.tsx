import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Bot, Message, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { fileTab, isFileTab, useVisuals, visualsActions } from '../../stores/visuals'

import { blobFromDataUrl, editRequest, filesOf, mimeOf, openFile } from './file-tab'
import { VisualPanel } from './visual-frame'

const api = vi.hoisted(() => ({ filesRead: vi.fn(), filesWrite: vi.fn() }))
const chat = vi.hoisted(() => ({ sendText: vi.fn() }))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...api
}))

vi.mock('./index', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...chat
}))

const call = (partial: Partial<ToolCall>): ToolCall => ({
  args: { content: '# Plan', path: '/work/plan.md' },
  durationS: 0,
  name: 'write',
  result: null,
  startedAt: 0,
  status: 'ok',
  toolId: partial.toolId ?? 't',
  ...partial
})

const bot = {
  avatar: null,
  created_at: 0,
  description: '',
  display_name: 'Scout',
  dream_enabled: true,
  last_activity_at: 0,
  model: 'glm-5',
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

function transcript(toolCalls: ToolCall[], streaming = false) {
  const message: Message = {
    attachments: [],
    createdAt: 0,
    id: 'm',
    role: 'assistant',
    streaming,
    text: 'Done.',
    toolCalls
  }

  useTranscripts.setState({
    bySession: {
      s: {
        approvals: [],
        clarifies: [],
        error: null,
        info: null,
        messages: [message],
        status: null,
        streamingMessageId: streaming ? 'm' : null,
        usage: null
      } as never
    }
  })
}

describe('filesOf', () => {
  it('lists each file the bot wrote or edited once, live or restored', () => {
    expect(
      filesOf({
        toolCalls: [
          call({ toolId: 'a' }),
          call({ args: '{"path":"/work/plan.md"}', name: 'edit', toolId: 'b' }),
          call({ args: { path: 'notes/pins.csv' }, name: 'edit', toolId: 'c' }),
          call({
            args: { path: '/s/attachments/4157abc3ebd7498086605acf7dd52ace-bench-plan.md' },
            name: 'edit',
            toolId: 'f'
          }),
          call({ name: 'write', status: 'error', toolId: 'd', args: { path: '/work/bad.md' } }),
          call({ name: 'read', toolId: 'e', args: { path: '/work/read.md' } })
        ]
      })
    ).toEqual([
      { mime: 'text/markdown', name: 'plan.md', path: '/work/plan.md' },
      { mime: 'text/csv', name: 'pins.csv', path: 'notes/pins.csv' },
      {
        mime: 'text/markdown',
        name: 'bench-plan.md',
        path: '/s/attachments/4157abc3ebd7498086605acf7dd52ace-bench-plan.md'
      }
    ])
  })
})

describe('editRequest', () => {
  it('names the file so the bot edits that one', () => {
    expect(editRequest('Shorten', 'plan.md', '/work/plan.md')).toBe(
      'Shorten\n\nEdit the file in place: `/work/plan.md`'
    )
    expect(editRequest('What is on page 3?', 'deck.pdf', '/a/deck.pdf', false)).toBe(
      'What is on page 3?\n\nFile: `/a/deck.pdf`'
    )
    expect(editRequest('Summarise it', 'deck.pdf')).toBe('Summarise it\n\nThis is about deck.pdf.')
    expect(mimeOf('Report.PDF')).toBe('application/pdf')
  })
})

describe('blobFromDataUrl', () => {
  it('decodes without fetch, which the app CSP refuses for data: URLs', async () => {
    const blob = blobFromDataUrl('data:application/pdf;base64,JVBERi0=')!

    expect(blob.type).toBe('application/pdf')
    expect(await blob.text()).toBe('%PDF-')
    expect(blobFromDataUrl('data:text/plain,hello')).toBeNull()
  })
})

describe('file tabs', () => {
  afterEach(() => visualsActions().closeAll())

  it('opening the same file twice shows its one tab', () => {
    openFile('s', { mime: 'text/markdown', name: 'plan.md', path: '/work/plan.md' })
    openFile('s', { mime: 'text/markdown', name: 'plan.md', path: '/work/plan.md' })

    const { active, tabs } = useVisuals.getState()
    expect(tabs).toHaveLength(1)
    expect(isFileTab(tabs[0]!)).toBe(true)
    expect(active).toBe('file:/work/plan.md')
  })
})

describe('a file beside the chat', () => {
  beforeEach(() => {
    useBots.setState({ byName: { scout: bot } })
    useUi.setState({ lastSection: { bot: 'scout', section: 'daily' } })
    transcript([])
    api.filesRead.mockResolvedValue({
      mime: 'text/markdown',
      modified: 1,
      version: 'v1',
      name: 'plan.md',
      path: '/work/plan.md',
      size: 20,
      text: 'Ship the board Friday'
    })
    api.filesWrite.mockResolvedValue({
      modified: 5,
      path: '/work/plan.md',
      size: 30,
      version: 'v5'
    })
    chat.sendText.mockResolvedValue(true)
  })

  afterEach(() => {
    visualsActions().closeAll()
    vi.clearAllMocks()
  })

  it('opens in the panel, asks the bot with a quick tool, and follows its edit', async () => {
    act(() =>
      visualsActions().open(
        fileTab('plan.md', { mime: 'text/markdown', path: '/work/plan.md', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    expect(await screen.findByText('Ship the board Friday')).toBeInTheDocument()
    expect(api.filesRead).toHaveBeenCalledWith('s', '/work/plan.md')

    fireEvent.click(screen.getByRole('button', { name: 'Shorten' }))
    await waitFor(() =>
      expect(chat.sendText).toHaveBeenCalledWith(
        's',
        'daily',
        'Shorten plan.md.\n\nEdit the file in place: `/work/plan.md`'
      )
    )

    // The bot edits the file: its finished step reads it again.
    api.filesRead.mockResolvedValue({
      mime: 'text/markdown',
      modified: 2,
      version: 'v2',
      name: 'plan.md',
      path: '/work/plan.md',
      size: 9,
      text: 'Ship Friday'
    })
    act(() => transcript([call({ args: { path: '/work/plan.md' }, name: 'edit' })]))

    expect(await screen.findByText('Ship Friday')).toBeInTheDocument()
    expect(screen.getByText('Updated by Scout')).toBeInTheDocument()
  })

  it('switches to source when the bot adds what the formatted view would drop', async () => {
    act(() =>
      visualsActions().open(
        fileTab('plan.md', { mime: 'text/markdown', path: '/work/plan.md', sessionId: 's' })
      )
    )
    render(<VisualPanel />)
    expect(await screen.findByText('Ship the board Friday')).toBeInTheDocument()

    const table = 'Ship the board Friday\n\n| Pin | Use |\n| --- | --- |\n| GPIO15 | JTAG |'
    api.filesRead.mockResolvedValue({
      mime: 'text/markdown',
      modified: 2,
      version: 'v2',
      name: 'plan.md',
      path: '/work/plan.md',
      size: table.length,
      text: table
    })
    act(() => transcript([call({ args: { path: '/work/plan.md' }, name: 'edit' })]))

    expect(await screen.findByLabelText('plan.md source')).toHaveValue(table)
  })

  it('holds the quick tools while the bot is working', async () => {
    transcript([], true)
    act(() =>
      visualsActions().open(
        fileTab('plan.md', { mime: 'text/markdown', path: '/work/plan.md', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    await screen.findByText('Ship the board Friday')
    expect(screen.getByRole('button', { name: 'Polish' })).toBeDisabled()
    expect(screen.getByPlaceholderText('Scout is working…')).toBeDisabled()
  })

  it('saves what the user types, naming the version it edited', async () => {
    act(() =>
      visualsActions().open(
        fileTab('pins.csv', { mime: 'text/csv', path: '/work/pins.csv', sessionId: 's' })
      )
    )
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 3,
      version: 'v3',
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 7,
      text: 'pin,use'
    })
    render(<VisualPanel />)

    const field = await screen.findByLabelText('pins.csv source')
    expect(screen.getByRole('button', { name: 'Fix bugs' })).toBeInTheDocument()
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO15,JTAG' } })

    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.csv',
          'pin,use\nGPIO15,JTAG',
          'v3'
        ),
      { timeout: 3000 }
    )

    // Once the edit is saved, the bot's next change still shows.
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 6,
      version: 'v6',
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 30,
      text: 'pin,use\nGPIO15,JTAG source select'
    })
    act(() => transcript([call({ args: { path: '/work/pins.csv' }, name: 'edit' })]))
    await waitFor(() =>
      expect(screen.getByLabelText('pins.csv source')).toHaveValue(
        'pin,use\nGPIO15,JTAG source select'
      )
    )
  })

  it('saves an edit typed while the bot changed the file against the version it started from', async () => {
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 3,
      version: 'v3',
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 7,
      text: 'pin,use'
    })
    act(() =>
      visualsActions().open(
        fileTab('pins.csv', { mime: 'text/csv', path: '/work/pins.csv', sessionId: 's' })
      )
    )
    render(<VisualPanel />)
    const field = await screen.findByLabelText('pins.csv source')

    // The user types; before the save runs, the bot edits the same file.
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO9,BOOT' } })
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 9,
      version: 'v9',
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 20,
      text: "pin,use\nthe bot's row"
    })
    act(() => transcript([call({ args: { path: '/work/pins.csv' }, name: 'edit' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    // The draft stays, and its save names version 3, so the daemon can refuse it.
    expect(field).toHaveValue('pin,use\nGPIO9,BOOT')
    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.csv',
          'pin,use\nGPIO9,BOOT',
          'v3'
        ),
      { timeout: 3000 }
    )
  })

  it('keeps an unsaved edit when another tab is shown and back', async () => {
    api.filesRead.mockImplementation((_session: string, path: string) =>
      Promise.resolve({
        mime: 'text/csv',
        modified: 3,
        version: 'v3',
        name: path.split('/').pop(),
        path,
        size: 7,
        text: 'pin,use'
      })
    )
    api.filesWrite.mockRejectedValue(new Error('the file changed since it was opened'))
    act(() => {
      visualsActions().open(
        fileTab('pins.csv', { mime: 'text/csv', path: '/work/pins.csv', sessionId: 's' })
      )
      visualsActions().open(
        fileTab('parts.csv', { mime: 'text/csv', path: '/work/parts.csv', sessionId: 's' })
      )
      visualsActions().activate('file:/work/pins.csv')
    })
    render(<VisualPanel />)

    fireEvent.change(await screen.findByLabelText('pins.csv source'), {
      target: { value: 'pin,use\nGPIO9,BOOT' }
    })
    act(() => visualsActions().activate('file:/work/parts.csv'))
    await screen.findByLabelText('parts.csv source')
    act(() => visualsActions().activate('file:/work/pins.csv'))

    expect(screen.getByLabelText('pins.csv source')).toHaveValue('pin,use\nGPIO9,BOOT')
  })

  async function openPins() {
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      name: 'pins.csv',
      path: '/work/pins.csv',
      modified: 3,
      version: 'v3',
      size: 7,
      text: 'pin,use'
    })
    act(() =>
      visualsActions().open(
        fileTab('pins.csv', { mime: 'text/csv', path: '/work/pins.csv', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    return screen.findByLabelText('pins.csv source')
  }

  it('keeps its version when the bot rewrites the file unchanged', async () => {
    const field = await openPins()
    // The same contents hash the same, whatever the new modification time.
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      name: 'pins.csv',
      path: '/work/pins.csv',
      modified: 9,
      version: 'v3',
      size: 7,
      text: 'pin,use'
    })
    act(() => transcript([call({ args: { path: '/work/pins.csv' }, name: 'write' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.csv',
          'pin,use\nGPIO2,ADC',
          'v3'
        ),
      { timeout: 3000 }
    )
  })

  it('keeps the editor and its edit when a refresh fails', async () => {
    const field = await openPins()
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    api.filesRead.mockRejectedValue(new Error('not connected'))
    act(() => transcript([call({ args: { path: '/work/pins.csv' }, name: 'edit' })]))

    expect(await screen.findByRole('alert')).toHaveTextContent('not connected')
    expect(screen.getByLabelText('pins.csv source')).toHaveValue('pin,use\nGPIO2,ADC')
  })

  it('saves the edit on screen before a quick tool asks the bot', async () => {
    const field = await openPins()
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fix bugs' }))

    await waitFor(() => expect(chat.sendText).toHaveBeenCalled())
    expect(api.filesWrite).toHaveBeenCalledWith('s', '/work/pins.csv', 'pin,use\nGPIO2,ADC', 'v3')
    expect(api.filesWrite.mock.invocationCallOrder[0]!).toBeLessThan(
      chat.sendText.mock.invocationCallOrder[0]!
    )
  })

  it('sends nothing when the edit on screen does not save', async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(new Error('the file changed since it was opened'))
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    fireEvent.change(screen.getByLabelText('Ask Scout about this file'), {
      target: { value: 'Sort by pin' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Scout' }))

    await waitFor(() => expect(api.filesWrite).toHaveBeenCalled())
    await act(async () => {})
    expect(chat.sendText).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Ask Scout about this file')).toHaveValue('Sort by pin')
  })

  it('keeps a file open when closing the panel cannot save its edit', async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(new Error('not connected'))
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }))

    await waitFor(() => expect(api.filesWrite).toHaveBeenCalled())
    await act(async () => {})
    expect(useVisuals.getState().tabs).toHaveLength(1)
    expect(screen.getByLabelText('pins.csv source')).toHaveValue('pin,use\nGPIO2,ADC')

    // Once it saves, closing closes.
    api.filesWrite.mockResolvedValue({
      modified: 5,
      path: '/work/pins.csv',
      size: 20,
      version: 'v5'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }))
    await waitFor(() => expect(useVisuals.getState().tabs).toHaveLength(0))
  })

  it("lets the user drop a refused edit for the bot's version, then close", async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(
      new JsonRpcGatewayError('the file changed since it was opened', { code: 4209 })
    )
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })

    const load = await screen.findByRole(
      'button',
      { name: "Load Scout's version" },
      { timeout: 3000 }
    )

    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      name: 'pins.csv',
      path: '/work/pins.csv',
      modified: 9,
      version: 'v9',
      size: 20,
      text: "pin,use\nthe bot's row"
    })
    // Changed elsewhere (another app, an outside editor): no step of the bot's
    // refreshed the tab, so loading reads the file as it is now.
    const refused = api.filesWrite.mock.calls.length

    fireEvent.click(load)
    await waitFor(() =>
      expect(screen.getByLabelText('pins.csv source')).toHaveValue("pin,use\nthe bot's row")
    )
    await act(async () => {})
    expect(api.filesWrite).toHaveBeenCalledTimes(refused)

    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }))
    await waitFor(() => expect(useVisuals.getState().tabs).toHaveLength(0))
  })

  it('keeps the edit when the version to load cannot be read', async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(
      new JsonRpcGatewayError('the file changed since it was opened', { code: 4209 })
    )
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })

    const load = await screen.findByRole(
      'button',
      { name: "Load Scout's version" },
      { timeout: 3000 }
    )

    api.filesRead.mockRejectedValue(new Error('not connected'))
    fireEvent.click(load)

    expect(await screen.findByText('not connected')).toBeInTheDocument()
    expect(screen.getByLabelText('pins.csv source')).toHaveValue('pin,use\nGPIO2,ADC')
  })

  it("drops a read that started before the user's save landed", async () => {
    const field = await openPins()

    let answer: (file: unknown) => void = () => {}
    api.filesRead.mockReturnValue(new Promise(resolve => (answer = resolve)))
    act(() => transcript([call({ args: { path: '/work/pins.csv' }, name: 'edit' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    api.filesWrite.mockResolvedValue({
      modified: 5,
      path: '/work/pins.csv',
      size: 20,
      version: 'v5'
    })
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    await waitFor(() => expect(api.filesWrite).toHaveBeenCalled(), { timeout: 3000 })

    await act(async () =>
      answer({
        mime: 'text/csv',
        name: 'pins.csv',
        path: '/work/pins.csv',
        modified: 3,
        version: 'v3',
        size: 7,
        text: 'pin,use'
      })
    )
    expect(screen.getByLabelText('pins.csv source')).toHaveValue('pin,use\nGPIO2,ADC')
  })

  it('offers a download for a file it cannot show', async () => {
    api.filesRead.mockResolvedValue({
      data_url: 'data:application/zip;base64,UEs=',
      mime: 'application/octet-stream',
      modified: 1,
      version: 'v1',
      name: 'board.zip',
      path: '/work/board.zip',
      size: 2
    })
    act(() =>
      visualsActions().open(
        fileTab('board.zip', { mime: 'application/zip', path: '/work/board.zip', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    expect(
      await screen.findByText('No preview for this file. Scout can still read it.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Polish' })).toBeNull()
    expect(screen.getByLabelText('Ask Scout about this file')).toBeEnabled()
  })
})
