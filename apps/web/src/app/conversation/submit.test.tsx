import { JsonRpcGatewayError } from '@hermes/shared'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useDrafts } from '../../stores/drafts'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'

import { ConversationColumn } from './index'

let params = { bot: 'owl', section: 'chat' }
vi.mock('@tanstack/react-router', () => {
  const router = {
    matchRoutes: () => [{ params: params }],
    history: { location: {}, subscribe: () => () => {} },
    subscribe: () => () => {}
  }

  return {
    useRouter: () => router,
    useNavigate: () => vi.fn(),
    useParams: () => params
  }
})

const section = (id = 'chat', live = 'durable-id') =>
  ({ id, bot: 'owl', title: 'Trip', live_session_id: live, peer_bot: null }) as Section

const missing = () => new JsonRpcGatewayError('session not found', { code: 4001 })

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

let call: Mock<(method: string, input: Record<string, unknown>) => Promise<unknown>>
let accepted: unknown[]
let opens: number
let submits: number
let reopenedId: string
let reopenError: Error | null
let retryError: Error | null
let firstError: Error
let heldOpen: ReturnType<typeof deferred> | null
let staged: Map<string, Record<string, unknown>>
let acceptedFiles: Record<string, unknown>[][]

beforeEach(() => {
  params = { bot: 'owl', section: 'chat' }
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { chat: section() },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  useDrafts.setState({ byId: {} })
  accepted = []
  acceptedFiles = []
  staged = new Map()
  opens = 0
  submits = 0
  reopenedId = 'durable-id'
  reopenError = null
  retryError = null
  firstError = missing()
  heldOpen = null
  call = vi.fn((method: string, input: Record<string, unknown>) => {
    if (method === 'hexbot.sections.create') {
      return Promise.resolve({ section: section(params.section) })
    }

    if (method === 'hexbot.sections.open') {
      opens++

      if (opens > 1 && heldOpen) {
        return heldOpen.promise
      }

      if (opens > 1 && reopenError) {
        return Promise.reject(reopenError)
      }

      return Promise.resolve({
        section: section(String(input.id), opens > 1 ? reopenedId : 'durable-id'),
        messages: [{ role: 'assistant', text: 'Earlier reply', timestamp: 1 }]
      })
    }

    if (method === 'prompt.submit') {
      submits++

      if (submits === 1) {
        // A missing process can discard all previously staged uploads.
        staged.clear()

        return Promise.reject(firstError)
      }

      if (retryError) {
        return Promise.reject(retryError)
      }

      const ids = input.attachments as string[] | undefined

      const files = [...staged].filter(
        ([id, upload]) => upload.session_id === input.session_id && (!ids || ids.includes(id))
      )

      if (ids?.some(id => !staged.has(id))) {
        return Promise.reject(new JsonRpcGatewayError('attachment not found', { code: 4204 }))
      }

      acceptedFiles.push(files.map(([, upload]) => upload))
      staged.clear()
      accepted.push(input)

      return Promise.resolve({ status: 'started' })
    }

    if (method === 'file.attach') {
      const id = `upload-${call.mock.calls.length}`
      staged.set(id, input)

      return Promise.resolve({ attached: true, id })
    }

    return Promise.resolve({ connectors: [] })
  })
  setActiveRpc({ call } as never)
})

async function send() {
  const field = await screen.findByRole('textbox', { name: 'Message' })
  await waitFor(() => expect(field).toBeEnabled())
  fireEvent.change(field, { target: { value: 'Read my plan' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

it.each(['durable-id', 'replacement-id'])(
  'resends exactly once after reopening as %s',
  async id => {
    reopenedId = id
    render(<ConversationColumn />)
    await send()
    await waitFor(() => expect(accepted).toHaveLength(1))
    expect(submits).toBe(2)
    expect(opens).toBe(2)
    expect(accepted[0]).toMatchObject({ session_id: id, text: 'Read my plan' })
    expect(screen.getAllByTestId('user-message')).toHaveLength(1)
    expect(screen.getByText('Earlier reply')).toBeVisible()
    expect(
      useTranscripts.getState().bySession[id]?.messages.filter(message => message.role === 'user')
    ).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  }
)

it.each(['durable-id', 'replacement-id'])(
  'keeps attachment bytes and one visible user row on %s',
  async id => {
    reopenedId = id
    const view = render(<ConversationColumn />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
    const file = new File(['actual plan bytes'], 'plan.txt', { type: 'text/plain' })
    fireEvent.change(view.container.querySelector('input[type=file]')!, {
      target: { files: [file] }
    })
    await send()
    await waitFor(() => expect(accepted).toHaveLength(1))
    expect(screen.getAllByTestId('user-message')).toHaveLength(1)

    const user = useTranscripts
      .getState()
      .bySession[id]?.messages.find(message => message.role === 'user')

    expect(user?.attachments[0]).toMatchObject({ name: 'plan.txt', size: file.size })
    const uploads = call.mock.calls.filter(([method]) => method === 'file.attach')
    expect(uploads).toHaveLength(2)
    expect(acceptedFiles).toEqual([[uploads[1]?.[1]]])
    expect(uploads[1]?.[1]).toMatchObject({
      session_id: id,
      name: 'plan.txt',
      data_url: 'data:text/plain;base64,YWN0dWFsIHBsYW4gYnl0ZXM='
    })
  }
)

it.each(['reopen', 'retry'])('shows the actual %s failure and stops retrying', async phase => {
  if (phase === 'reopen') {
    reopenError = new Error('Reopen unavailable')
  } else {
    retryError = missing()
  }

  render(<ConversationColumn />)
  await send()
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent(
    phase === 'reopen' ? 'Reopen unavailable' : 'session not found'
  )
  expect(useTranscripts.getState().bySession['durable-id']?.error).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(accepted).toHaveLength(0)
  expect(opens).toBe(2)
  expect(submits).toBe(phase === 'reopen' ? 1 : 2)
  expect(screen.getAllByTestId('user-message')).toHaveLength(1)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Read my plan')
})

it.each([
  new Error('Network disconnected: session not found'),
  new JsonRpcGatewayError('Provider session not found', { code: 5201 }),
  new JsonRpcGatewayError('session not found', { code: 5200 })
])('never automatically reopens for other errors: %s', async error => {
  firstError = error
  render(<ConversationColumn />)
  await send()
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent(error.message)

  if (!(error instanceof JsonRpcGatewayError) || error.code !== 5201) {
    expect(useTranscripts.getState().bySession['durable-id']?.error).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  }
  expect(opens).toBe(1)
  expect(submits).toBe(1)
})

it.each(['navigate', 'daemon', 'epoch', 'unmount'])(
  'cancels a held reopen after %s',
  async action => {
    heldOpen = deferred()
    const view = render(<ConversationColumn />)
    await send()
    await waitFor(() => expect(opens).toBe(2))

    if (action === 'navigate') {
      params = { bot: 'owl', section: 'other' }
      view.rerender(<ConversationColumn />)
    } else if (action === 'daemon') {
      act(() => useConnection.setState({ target: { kind: 'local', origin: 'http://another' } }))
    } else if (action === 'epoch') {
      act(() => useConnection.setState({ epoch: 'second' }))
    } else {
      view.unmount()
    }

    await act(async () => heldOpen!.resolve({ section: section(), messages: [] }))
    expect(submits).toBe(1)
    expect(accepted).toHaveLength(0)
  }
)

it('keeps text and files available when the single retry fails', async () => {
  retryError = new Error('Retry refused')
  const view = render(<ConversationColumn />)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['keep me'], 'plan.txt', { type: 'text/plain' })] }
  })
  await send()
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent('Retry refused')
  expect(useTranscripts.getState().bySession['durable-id']?.error).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Read my plan')
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
  expect(submits).toBe(2)
  expect(accepted).toHaveLength(0)
})

it('does not resend after navigation during attachment restaging', async () => {
  const upload = deferred()
  const original = call.getMockImplementation()!
  let uploads = 0
  call.mockImplementation((method: string, input: Record<string, unknown>) => {
    if (method === 'file.attach' && ++uploads === 2) {
      return upload.promise
    }

    return original(method, input)
  })
  const view = render(<ConversationColumn />)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['keep me'], 'plan.txt', { type: 'text/plain' })] }
  })
  await send()
  await waitFor(() => expect(uploads).toBe(2))
  params = { bot: 'owl', section: 'other' }
  view.rerender(<ConversationColumn />)
  await act(async () => upload.resolve({ attached: true, id: 'late-upload' }))
  expect(submits).toBe(1)
  expect(accepted).toHaveLength(0)
})

it.each(['navigate', 'daemon', 'epoch', 'unmount'])(
  'cancels before prompt acceptance when the first upload outlives %s',
  async action => {
    const upload = deferred()
    const original = call.getMockImplementation()!
    call.mockImplementation((method, input) =>
      method === 'file.attach' ? upload.promise : original(method, input)
    )
    const view = render(<ConversationColumn />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
    fireEvent.change(view.container.querySelector('input[type=file]')!, {
      target: { files: [new File(['keep me'], 'plan.txt', { type: 'text/plain' })] }
    })
    await send()
    await waitFor(() =>
      expect(call.mock.calls.some(([method]) => method === 'file.attach')).toBe(true)
    )

    if (action === 'navigate') {
      params = { bot: 'owl', section: 'other' }
      view.rerender(<ConversationColumn />)
    } else if (action === 'daemon') {
      act(() => useConnection.setState({ target: { kind: 'local', origin: 'http://another' } }))
    } else if (action === 'epoch') {
      act(() => useConnection.setState({ epoch: 'second' }))
    } else {
      view.unmount()
    }

    await act(async () => upload.resolve({ attached: true, id: 'late-upload' }))
    expect(submits).toBe(0)
    expect(accepted).toHaveLength(0)
  }
)

it('submits the optimistic UUID and only its server upload IDs when the daemon supports identity', async () => {
  useConnection.setState({ daemon: { one_chat: true, transcript_identity: true } as DaemonInfo })
  const original = call.getMockImplementation()!
  call.mockImplementation((method, input) => {
    if (method === 'prompt.submit') {
      accepted.push(input)

      return Promise.resolve({ status: 'submitted', input_id: input.input_id })
    }

    return original(method, input)
  })
  const view = render(<ConversationColumn />)
  await screen.findByText('Earlier reply')
  staged.set('other-client-upload', { session_id: 'durable-id', name: 'private-other.txt' })
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['own bytes'], 'plan.txt', { type: 'text/plain' })] }
  })
  await send()
  await waitFor(() => expect(accepted).toHaveLength(1))
  const submitted = accepted[0] as Record<string, unknown>

  const local = useTranscripts
    .getState()
    .bySession['durable-id']!.messages.find(message => message.role === 'user')!

  const upload =
    call.mock.results[call.mock.calls.findIndex(([method]) => method === 'file.attach')]!

  const uploaded = (await upload.value) as { id: string }
  expect(submitted).toEqual({
    session_id: 'durable-id',
    text: 'Read my plan',
    input_id: local.inputId,
    attachments: [uploaded.id]
  })
  expect(local.inputId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  expect(local.attachments.map(item => item.id)).toEqual([uploaded.id])
  expect(submitted.attachments).not.toContain('other-client-upload')
})

it('gives an explicitly rejected retry a fresh correlation key, without promising idempotency', async () => {
  useConnection.setState({ daemon: { one_chat: true, transcript_identity: true } as DaemonInfo })
  render(<ConversationColumn />)
  await send()
  await waitFor(() => expect(accepted).toHaveLength(1))

  const inputs = call.mock.calls
    .filter(([method]) => method === 'prompt.submit')
    .map(([, input]) => input)

  expect(inputs).toHaveLength(2)
  expect(inputs[0]!.input_id).toEqual(expect.any(String))
  expect(inputs[1]!.input_id).toEqual(expect.any(String))
  expect(inputs[1]!.input_id).not.toBe(inputs[0]!.input_id)
  expect(
    useTranscripts
      .getState()
      .bySession['durable-id']!.messages.find(message => message.role === 'user')?.inputId
  ).toBe(inputs[1]!.input_id)
})
