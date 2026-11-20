import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Bot, Message, ToolCall } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useFileComments } from '../../stores/file-comments'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'
import { useUi } from '../../stores/ui'
import { fileTab, isFileTab, useVisuals, visualsActions } from '../../stores/visuals'

import { blobFromDataUrl, filesOf, flushOpenFiles, mimeOf, openFile } from './file-tab'
import { VisualPanel } from './visual-frame'

const api = vi.hoisted(() => ({
  filesRead: vi.fn(),
  filesWrite: vi.fn(),
  filesWriteBytes: vi.fn()
}))

vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<object>()),
  ...api
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
  it('lists each file the bot shared once, live or restored, and none it only wrote', () => {
    const share = 'hexbot_share_file'

    expect(
      filesOf({
        toolCalls: [
          call({ toolId: 'a' }),
          call({ args: { path: '/work/test_plan.py' }, name: 'write', toolId: 'w' }),
          call({ args: '{"path":"/work/plan.md"}', name: share, toolId: 'b' }),
          call({ args: { path: 'notes/pins.csv' }, name: share, toolId: 'c' }),
          call({ args: { path: 'notes/pins.csv' }, name: share, toolId: 'c2' }),
          call({
            args: { path: '/s/attachments/4157abc3ebd7498086605acf7dd52ace-bench-plan.md' },
            name: share,
            toolId: 'f'
          }),
          call({ name: share, status: 'error', toolId: 'd', args: { path: '/work/bad.md' } }),
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

describe('mimeOf', () => {
  it('knows a file by its name', () => {
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
    useFileComments.setState({ byChat: {}, outbox: {} })
  })

  afterEach(() => {
    visualsActions().closeAll()
    vi.clearAllMocks()
  })

  it("opens in the panel with no field of its own, and follows the bot's edit", async () => {
    act(() =>
      visualsActions().open(
        fileTab('plan.md', { mime: 'text/markdown', path: '/work/plan.md', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    expect(await screen.findByText('Ship the board Friday')).toBeInTheDocument()
    expect(api.filesRead).toHaveBeenCalledWith('s', '/work/plan.md')
    // The chat's own composer is the one place to write to the bot.
    expect(screen.queryByLabelText('Ask Scout about this file')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Quick tools' })).toBeNull()

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

  it("shows the bot's change in the formatted view after it landed in source view", async () => {
    act(() =>
      visualsActions().open(
        fileTab('plan.md', { mime: 'text/markdown', path: '/work/plan.md', sessionId: 's' })
      )
    )
    render(<VisualPanel />)
    expect(await screen.findByText('Ship the board Friday')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByText('View source'))
    await screen.findByLabelText('plan.md source')

    api.filesRead.mockResolvedValue({
      mime: 'text/markdown',
      modified: 2,
      name: 'plan.md',
      path: '/work/plan.md',
      size: 11,
      text: 'Ship Monday',
      version: 'v2'
    })
    act(() => transcript([call({ args: { path: '/work/plan.md' }, name: 'edit' })]))
    await waitFor(() => expect(screen.getByLabelText('plan.md source')).toHaveValue('Ship Monday'))

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(await screen.findByText('View formatted'))
    expect(await screen.findByText('Ship Monday')).toBeInTheDocument()
    expect(screen.queryByText('Ship the board Friday')).toBeNull()
  })

  it('leaves a comment on selected text for the next message', async () => {
    const field = await openPins()

    field.focus()
    ;(field as HTMLTextAreaElement).setSelectionRange(4, 7)
    fireEvent.mouseUp(field)
    fireEvent.click(await screen.findByRole('button', { name: 'Comment' }))
    fireEvent.change(screen.getByLabelText('Comment for Scout'), {
      target: { value: 'Rename this pin' }
    })
    fireEvent.keyDown(screen.getByLabelText('Comment for Scout'), { key: 'Enter' })

    expect(useFileComments.getState().byChat.daily).toEqual([
      expect.objectContaining({
        name: 'pins.conf',
        note: 'Rename this pin',
        path: '/work/pins.conf',
        quote: 'use',
        where: 'line 1'
      })
    ])
    expect(screen.queryByLabelText('Comment for Scout')).toBeNull()
  })

  it('offers no comments on a file from a thread between bots', async () => {
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 3,
      version: 'v3',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 7,
      text: 'pin,use\nGPIO2,ADC'
    })
    act(() =>
      openFile('s', { mime: 'text/plain', name: 'pins.conf', path: '/work/pins.conf' }, false)
    )
    render(<VisualPanel />)

    const field = await screen.findByLabelText('pins.conf source')
    field.focus()
    ;(field as HTMLTextAreaElement).setSelectionRange(0, 3)
    fireEvent.mouseUp(field)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
  })

  it('saves what the user types, naming the version it edited', async () => {
    act(() =>
      visualsActions().open(
        fileTab('pins.conf', { mime: 'text/plain', path: '/work/pins.conf', sessionId: 's' })
      )
    )
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 3,
      version: 'v3',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 7,
      text: 'pin,use'
    })
    render(<VisualPanel />)

    const field = await screen.findByLabelText('pins.conf source')
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO15,JTAG' } })

    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.conf',
          'pin,use\nGPIO15,JTAG',
          'v3'
        ),
      { timeout: 3000 }
    )

    // Once the edit is saved, the bot's next change still shows.
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 6,
      version: 'v6',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 30,
      text: 'pin,use\nGPIO15,JTAG source select'
    })
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'edit' })]))
    await waitFor(() =>
      expect(screen.getByLabelText('pins.conf source')).toHaveValue(
        'pin,use\nGPIO15,JTAG source select'
      )
    )
  })

  it("reads, saves and follows through the chat's new session after a daemon restart", async () => {
    useSections.setState({ liveSessionId: { daily: 'gone' } })
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 3,
      version: 'v3',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 7,
      text: 'pin,use'
    })
    act(() =>
      openFile(
        'gone',
        { mime: 'text/plain', name: 'pins.conf', path: '/work/pins.conf' },
        true,
        'daily'
      )
    )
    render(<VisualPanel />)
    const field = await screen.findByLabelText('pins.conf source')
    expect(api.filesRead).toHaveBeenLastCalledWith('gone', '/work/pins.conf')

    // The daemon restarts and the chat reopens with a new live session.
    act(() => useSections.setState({ liveSessionId: { daily: 's' } }))
    await waitFor(() => expect(api.filesRead).toHaveBeenLastCalledWith('s', '/work/pins.conf'))

    fireEvent.change(field, { target: { value: 'pin,use\nGPIO15,JTAG' } })
    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.conf',
          'pin,use\nGPIO15,JTAG',
          'v3'
        ),
      { timeout: 3000 }
    )

    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 6,
      version: 'v6',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 30,
      text: 'pin,use\nGPIO15,JTAG source select'
    })
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'edit' })]))
    await waitFor(() =>
      expect(screen.getByLabelText('pins.conf source')).toHaveValue(
        'pin,use\nGPIO15,JTAG source select'
      )
    )
    useSections.setState({ liveSessionId: {} })
  })

  it('saves an edit typed while the bot changed the file against the version it started from', async () => {
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 3,
      version: 'v3',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 7,
      text: 'pin,use'
    })
    act(() =>
      visualsActions().open(
        fileTab('pins.conf', { mime: 'text/plain', path: '/work/pins.conf', sessionId: 's' })
      )
    )
    render(<VisualPanel />)
    const field = await screen.findByLabelText('pins.conf source')

    // The user types; before the save runs, the bot edits the same file.
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO9,BOOT' } })
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      modified: 9,
      version: 'v9',
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 20,
      text: "pin,use\nthe bot's row"
    })
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'edit' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    // The draft stays, and its save names version 3, so the daemon can refuse it.
    expect(field).toHaveValue('pin,use\nGPIO9,BOOT')
    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.conf',
          'pin,use\nGPIO9,BOOT',
          'v3'
        ),
      { timeout: 3000 }
    )
  })

  it('keeps the editor and its edit when the bot makes the file too large to edit here', async () => {
    api.filesWrite.mockRejectedValue(
      new JsonRpcGatewayError('the file changed since it was opened', { code: 4209 })
    )
    const field = await openPins()
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO9,BOOT' } })

    const large = {
      data_url: 'data:text/csv;base64,cGluLHVzZQ==',
      mime: 'text/plain',
      modified: 9,
      name: 'pins.conf',
      path: '/work/pins.conf',
      size: 3 * 1024 * 1024,
      version: 'v9'
    }

    api.filesRead.mockResolvedValue(large)
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'write' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    expect(
      await screen.findByText(/Scout changed this file, and it can no longer be edited here/)
    ).toBeVisible()
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO9,BOOT')
    expect(screen.queryByText(/No preview for this file/)).toBeNull()

    // Only the user's choice replaces the editor.
    fireEvent.click(screen.getByRole('button', { name: "Load Scout's version" }))
    expect(await screen.findByText(/No preview for this file/)).toBeVisible()
    expect(screen.queryByLabelText('pins.conf source')).toBeNull()
  })

  it('keeps an unsaved edit when another tab is shown and back', async () => {
    api.filesRead.mockImplementation((_session: string, path: string) =>
      Promise.resolve({
        mime: 'text/plain',
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
        fileTab('pins.conf', { mime: 'text/plain', path: '/work/pins.conf', sessionId: 's' })
      )
      visualsActions().open(
        fileTab('parts.conf', { mime: 'text/plain', path: '/work/parts.conf', sessionId: 's' })
      )
      visualsActions().activate('file:/work/pins.conf')
    })
    render(<VisualPanel />)

    fireEvent.change(await screen.findByLabelText('pins.conf source'), {
      target: { value: 'pin,use\nGPIO9,BOOT' }
    })
    act(() => visualsActions().activate('file:/work/parts.conf'))
    await screen.findByLabelText('parts.conf source')
    act(() => visualsActions().activate('file:/work/pins.conf'))

    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO9,BOOT')
  })

  async function openPins() {
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      name: 'pins.conf',
      path: '/work/pins.conf',
      modified: 3,
      version: 'v3',
      size: 7,
      text: 'pin,use'
    })
    act(() =>
      visualsActions().open(
        fileTab('pins.conf', { mime: 'text/plain', path: '/work/pins.conf', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    return screen.findByLabelText('pins.conf source')
  }

  it('keeps its version when the bot rewrites the file unchanged', async () => {
    const field = await openPins()
    // The same contents hash the same, whatever the new modification time.
    api.filesRead.mockResolvedValue({
      mime: 'text/plain',
      name: 'pins.conf',
      path: '/work/pins.conf',
      modified: 9,
      version: 'v3',
      size: 7,
      text: 'pin,use'
    })
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'write' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    await waitFor(
      () =>
        expect(api.filesWrite).toHaveBeenCalledWith(
          's',
          '/work/pins.conf',
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
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'edit' })]))

    expect(await screen.findByRole('alert')).toHaveTextContent('not connected')
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO2,ADC')
  })

  it('saves the edit on screen before a message goes', async () => {
    const field = await openPins()
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC,3V3' } })

    expect(await flushOpenFiles()).toBe(true)
    expect(api.filesWrite).toHaveBeenCalledWith(
      's',
      '/work/pins.conf',
      'pin,use\nGPIO2,ADC,3V3',
      'v3'
    )
  })

  it('holds the message when the edit on screen does not save', async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(new Error('the file changed since it was opened'))
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC,3V3' } })

    expect(await flushOpenFiles()).toBe(false)
    expect(await screen.findByRole('alert')).toHaveTextContent('the file changed')
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO2,ADC,3V3')
  })

  it('keeps a file open when closing the panel cannot save its edit', async () => {
    const field = await openPins()
    api.filesWrite.mockRejectedValue(new Error('not connected'))
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }))

    await waitFor(() => expect(api.filesWrite).toHaveBeenCalled())
    await act(async () => {})
    expect(useVisuals.getState().tabs).toHaveLength(1)
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO2,ADC')

    // Once it saves, closing closes.
    api.filesWrite.mockResolvedValue({
      modified: 5,
      path: '/work/pins.conf',
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
      mime: 'text/plain',
      name: 'pins.conf',
      path: '/work/pins.conf',
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
      expect(screen.getByLabelText('pins.conf source')).toHaveValue("pin,use\nthe bot's row")
    )
    await act(async () => {})
    expect(api.filesWrite).toHaveBeenCalledTimes(refused)

    fireEvent.click(screen.getByRole('button', { name: 'Close the side panel' }))
    await waitFor(() => expect(useVisuals.getState().tabs).toHaveLength(0))
  })

  it("drops a refused table edit for the bot's version without writing it again", async () => {
    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 3,
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 7,
      text: 'pin,use\nGPIO2,ADC\n',
      version: 'v3'
    })
    api.filesWrite.mockRejectedValue(
      new JsonRpcGatewayError('the file changed since it was opened', { code: 4209 })
    )
    act(() =>
      visualsActions().open(
        fileTab('pins.csv', { mime: 'text/csv', path: '/work/pins.csv', sessionId: 's' })
      )
    )
    render(<VisualPanel />)

    fireEvent.doubleClick(await screen.findByText('ADC'))
    fireEvent.change(screen.getByLabelText('Edit B2'), { target: { value: 'JTAG' } })
    fireEvent.keyDown(screen.getByLabelText('Edit B2'), { key: 'Enter' })

    const load = await screen.findByRole(
      'button',
      { name: "Load Scout's version" },
      { timeout: 3000 }
    )

    const refused = api.filesWrite.mock.calls.length

    api.filesRead.mockResolvedValue({
      mime: 'text/csv',
      modified: 9,
      name: 'pins.csv',
      path: '/work/pins.csv',
      size: 20,
      text: "pin,use\nthe bot's row\n",
      version: 'v9'
    })
    fireEvent.click(load)

    expect(await screen.findByText("the bot's row")).toBeInTheDocument()
    await act(async () => {})
    expect(api.filesWrite).toHaveBeenCalledTimes(refused)
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
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO2,ADC')
  })

  it("drops a read that started before the user's save landed", async () => {
    const field = await openPins()

    let answer: (file: unknown) => void = () => {}
    api.filesRead.mockReturnValue(new Promise(resolve => (answer = resolve)))
    act(() => transcript([call({ args: { path: '/work/pins.conf' }, name: 'edit' })]))
    await waitFor(() => expect(api.filesRead).toHaveBeenCalledTimes(2))

    api.filesWrite.mockResolvedValue({
      modified: 5,
      path: '/work/pins.conf',
      size: 20,
      version: 'v5'
    })
    fireEvent.change(field, { target: { value: 'pin,use\nGPIO2,ADC' } })
    await waitFor(() => expect(api.filesWrite).toHaveBeenCalled(), { timeout: 3000 })

    await act(async () =>
      answer({
        mime: 'text/plain',
        name: 'pins.conf',
        path: '/work/pins.conf',
        modified: 3,
        version: 'v3',
        size: 7,
        text: 'pin,use'
      })
    )
    expect(screen.getByLabelText('pins.conf source')).toHaveValue('pin,use\nGPIO2,ADC')
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
    expect(screen.queryByLabelText('Ask Scout about this file')).toBeNull()
  })
})
