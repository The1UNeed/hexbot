import { type GatewayEvent, JsonRpcGatewayError } from '@hermes/shared'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useDrafts } from '../../stores/drafts'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'

import { ConversationColumn } from './index'

const section = (id: string, extra: Partial<Section> = {}) =>
  ({
    id,
    bot: 'owl',
    title: id,
    peer_bot: null,
    archived_at: null,
    message_count: 1,
    live_session_id: id,
    ...extra
  }) as Section

const chat = section('chat')
const peer = section('peer', { peer_bot: 'yak' })
const identity = { one_chat: true, transcript_identity: true, install_id: 'home' } as DaemonInfo

const deferred = () => {
  let resolve!: (value?: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const refused = () => new JsonRpcGatewayError('Prompt rejected', { code: 5201 })

interface Upload {
  id: string
  name: string
  session: string
}

// The daemon side of prompt.submit, as in runtime.rs submit_input: an exact
// list takes only those staged uploads, [] takes none and an omitted list takes
// all. A missing ID answers 4204 and changes nothing. A refusal after the take
// restores the taken uploads and releases the intent.
let staged: Map<string, Upload>
let reserved: Set<string>
let rows: Record<string, unknown>[]
let delivered: { text: unknown; files: string[]; input_id?: unknown }[]
let answers: Error[]
let gate: ReturnType<typeof deferred> | null
let uploads: number

let call: ReturnType<
  typeof vi.fn<(method: string, input: Record<string, unknown>) => Promise<unknown>>
>

async function submit(input: Record<string, unknown>) {
  await gate?.promise
  const session = String(input.session_id)
  const inputId = input.input_id as string | undefined
  const ids = input.attachments as string[] | undefined
  const answer = answers.shift()

  if (answer && !(answer instanceof JsonRpcGatewayError)) {
    // The request never reached the daemon.
    throw answer
  }

  if (answer?.code === 4001) {
    // A missing process can discard its staged uploads.
    staged.forEach(upload => upload.session === session && staged.delete(upload.id))
    throw answer
  }

  if (inputId !== undefined && reserved.has(inputId)) {
    throw new JsonRpcGatewayError('input_id is already reserved', { code: 4202 })
  }

  const missing = ids?.find(id => staged.get(id)?.session !== session)

  if (missing) {
    throw new JsonRpcGatewayError(`attachment not found: ${missing}; attach it again`, {
      code: 4204
    })
  }

  const sent = [...staged.values()].filter(
    upload => upload.session === session && (!ids || ids.includes(upload.id))
  )

  sent.forEach(upload => staged.delete(upload.id))

  if (answer) {
    sent.forEach(upload => staged.set(upload.id, upload))

    throw answer
  }

  if (inputId) {
    reserved.add(inputId)
  }

  delivered.push({ text: input.text, files: sent.map(upload => upload.name), input_id: inputId })
  rows.push(
    { role: 'user', row_id: `user-${rows.length}`, text: input.text, input_id: inputId },
    { role: 'assistant', row_id: `reply-${rows.length}`, text: `Reply ${delivered.length}` }
  )

  return { status: 'submitted', ...(inputId && { input_id: inputId }) }
}

function daemon(method: string, input: Record<string, unknown>) {
  switch (method) {
    case 'hexbot.sections.list':
      return { sections: [chat, peer] }

    case 'hexbot.sections.create':
      return { section: chat }

    case 'hexbot.sections.open':
      return input.id === 'peer'
        ? { section: peer, messages: [{ role: 'assistant', text: 'Peer thread' }] }
        : { section: chat, messages: rows.map(row => ({ ...row })) }
    case 'file.attach': {
      const id = `srv-${++uploads}`
      staged.set(id, { id, name: String(input.name), session: String(input.session_id) })

      return { attached: true, id }
    }

    default:
      return { connectors: [] }
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({ target: { kind: 'local' }, epoch: 'first', daemon: identity })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { chat, peer },
    idsByBot: { owl: ['chat', 'peer'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  useDrafts.setState({ byId: {} })
  staged = new Map()
  reserved = new Set()
  rows = [{ role: 'assistant', row_id: 'earlier', text: 'Earlier reply' }]
  delivered = []
  answers = []
  gate = null
  uploads = 0
  call = vi.fn(async (method: string, input: Record<string, unknown>) =>
    method === 'prompt.submit' ? submit(input) : daemon(method, input)
  )
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))

async function mount(initial = '/b/owl/s/chat') {
  const root = createRootRoute({ component: Outlet })

  const conversation = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: ConversationColumn
  })

  const room = createRoute({
    getParentRoute: () => root,
    path: '/r/$room',
    component: () => <p>Garden room</p>
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initial] }),
    routeTree: root.addChildren([conversation, room])
  })

  await router.load()
  const view = render(<RouterProvider router={router} />)

  return { ...view, router }
}

const submits = () =>
  call.mock.calls
    .filter(([method]) => method === 'prompt.submit')
    .map(([, input]) => input as Record<string, unknown>)

const userRows = () =>
  useTranscripts.getState().bySession.chat?.messages.filter(message => message.role === 'user') ??
  []

const cards = () => screen.queryAllByTestId('stopped-card')
const retryOn = (card: HTMLElement) => within(card).queryByRole('button', { name: 'Retry' })
const retries = () => screen.queryAllByRole('button', { name: 'Retry' })

async function send(view: Awaited<ReturnType<typeof mount>>, names = ['plan.txt']) {
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  const field = screen.getByRole('textbox', { name: 'Message' })
  await waitFor(() => expect(field).toBeEnabled())
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: names.map(name => new File([`${name} bytes`], name, { type: 'text/plain' })) }
  })
  fireEvent.change(field, { target: { value: 'Read my plan' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

async function reload() {
  await act(async () => {
    routeEvent(
      {
        type: 'hexbot.sections.changed',
        payload: { bot: 'owl', id: 'chat', reload: true }
      } as GatewayEvent,
      { refreshBots: () => undefined, refreshSections: () => undefined }
    )
  })
}

it('R150 retains the newer provider stream when an earlier manual retry is refused late', async () => {
  answers = [refused(), new JsonRpcGatewayError('session is already working', { code: 4002 })]
  const view = await mount()
  await send(view)
  const card = await screen.findByTestId('stopped-card')
  gate = deferred()
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'newer', message_id: 'newer-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.delta',
      session_id: 'chat',
      payload: { turn_id: 'newer', message_id: 'newer-fragment', text: 'Newer answer' }
    } as GatewayEvent)
  })
  const current = useTranscripts.getState().bySession.chat!
  const streamingId = current.streamingMessageId
  expect(current.turnActive).toBe(true)
  expect(current.messages.find(row => row.id === streamingId)?.text).toBe('Newer answer')
  await act(async () => gate!.resolve())
  await waitFor(() => expect(answers).toHaveLength(0))
  const after = useTranscripts.getState().bySession.chat!
  expect(after.streamingMessageId).toBe(streamingId)
  expect(after.turnActive).toBe(true)
  expect(after.messages.find(row => row.id === streamingId)?.streaming).toBe(true)
})

it('R150 reuses only own uploads after actual missing-text refusal code 4200', async () => {
  answers = [new JsonRpcGatewayError('missing parameter: text', { code: 4200 })]
  staged.set('foreign', { id: 'foreign', name: 'other.txt', session: 'chat' })
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  fireEvent.click(retries()[0]!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  expect(staged.has('foreign')).toBe(true)
})

it('R150 canonical acceptance before a contradictory refused RPC cannot replay consumed uploads', async () => {
  const original = call.getMockImplementation()!
  const response = deferred()
  let first = true
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    const result = await original(method, input)

    if (method === 'prompt.submit' && first) {
      first = false
      await response.promise
      throw refused()
    }

    return result
  })
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  await act(async () => response.resolve())
  await screen.findByTestId('stopped-card')
  const originalRow = userRows()[0]!
  expect(originalRow.submission?.status).toBe('accepted')
  fireEvent.click(retries()[0]!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[1]!.attachments).toEqual([])
  expect(userRows().find(row => row.id === originalRow.id)?.inputId).toBe(originalRow.inputId)
})

it('R150 retains the accepted input when a later warning belongs to a remote run', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const own = userRows()[0]!
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment', text: 'Done', status: 'complete' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'remote-run', message_id: 'remote-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'error',
      session_id: 'chat',
      payload: {
        turn_id: 'remote-run',
        message_id: 'remote-fragment',
        message: 'Remote provider failed'
      }
    } as GatewayEvent)
  })
  expect(retries()).toHaveLength(0)
  expect(userRows()[0]!.inputId).toBe(own.inputId)
})

it('identity-equipped: R150 does not bind a later remote terminal failure to an earlier accepted failed input', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  await proveAccepted(userRows()[0]!.inputId!, 'own-run')
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-run',
        message_id: 'own-fragment',
        text: 'Partial own reply',
        status: 'error',
        error: 'Own provider failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const ownCard = await screen.findByTestId('stopped-card')
  expect(retryOn(ownCard)).toBeVisible()
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'remote-run', message_id: 'remote-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'remote-run',
        message_id: 'remote-fragment',
        text: 'Partial remote reply',
        status: 'error',
        error: 'Remote provider failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const remoteCard = cards().find(card => card.textContent?.includes('Remote provider failed'))!
  expect(remoteCard).toBeVisible()
  expect(retryOn(remoteCard)).toBeNull()
  expect(retryOn(ownCard)).toBeVisible()
})

it('R150 keeps an actual warning after acceptance nonterminal and out of Retry', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.delta',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment', text: 'Working' }
    } as GatewayEvent)
  })
  const before = useTranscripts.getState().bySession.chat!
  act(() =>
    routeEvent({
      type: 'warning',
      session_id: 'chat',
      payload: { section_id: 'chat', message: 'Title save warning' }
    } as GatewayEvent)
  )
  const after = useTranscripts.getState().bySession.chat!
  expect(after.streamingMessageId).toBe(before.streamingMessageId)
  expect(after.turnActive).toBe(true)
  expect(userRows()[0]!.submission?.status).toBe('accepted')
  expect(retries()).toHaveLength(0)
})

// Supply only identity fields already produced on a proven durable user row.
async function proveAccepted(inputId: string, turnId: string) {
  const row = rows.find(row => row.role === 'user' && row.input_id === inputId)!
  row.turn_id = turnId
  await reload()
}

it.each([4002, 5200])(
  'keeps all newer-run state and Stop after late manual Retry error %s',
  async code => {
    answers = [refused(), new JsonRpcGatewayError('Late request failed', { code })]
    const view = await mount()
    await send(view)
    const card = await screen.findByTestId('stopped-card')
    gate = deferred()
    fireEvent.click(retryOn(card)!)
    await waitFor(() => expect(submits()).toHaveLength(2))
    act(() => {
      routeEvent({
        type: 'message.start',
        session_id: 'chat',
        payload: { turn_id: 'newer', message_id: 'newer-fragment' }
      } as GatewayEvent)
      routeEvent({
        type: 'message.delta',
        session_id: 'chat',
        payload: { turn_id: 'newer', message_id: 'newer-fragment', text: 'Partial newer answer' }
      } as GatewayEvent)
      routeEvent({
        type: 'thinking.delta',
        session_id: 'chat',
        payload: { turn_id: 'newer', message_id: 'newer-fragment', text: 'Newer reasoning' }
      } as GatewayEvent)
      routeEvent({
        type: 'reasoning.delta',
        session_id: 'chat',
        payload: { turn_id: 'newer', message_id: 'newer-fragment', text: 'Newer reasoning' }
      } as GatewayEvent)
      routeEvent({
        type: 'tool.start',
        session_id: 'chat',
        payload: {
          turn_id: 'newer',
          message_id: 'newer-fragment',
          tool_id: 'newer-tool',
          name: 'read_file',
          args: { path: 'own.txt' }
        }
      } as GatewayEvent)
      routeEvent({
        type: 'approval.request',
        session_id: 'chat',
        payload: {
          turn_id: 'newer',
          message_id: 'newer-fragment',
          request_id: 'newer-approval',
          choices: ['once'],
          command: 'read'
        }
      } as GatewayEvent)
      routeEvent({
        type: 'clarify.request',
        session_id: 'chat',
        payload: {
          turn_id: 'newer',
          message_id: 'newer-fragment',
          request_id: 'newer-question',
          question: 'Which file?',
          choices: ['own.txt']
        }
      } as GatewayEvent)
      routeEvent({
        type: 'message.delta',
        session_id: 'chat',
        payload: { turn_id: 'newer', message_id: 'newer-next', text: 'Still working' }
      } as GatewayEvent)
      const state = useTranscripts.getState().bySession.chat!
      useTranscripts.setState({
        bySession: { chat: { ...state, error: 'Unrelated error', checking: 'Checking newer step' } }
      })
    })
    const before = useTranscripts.getState().bySession.chat!
    const current = before.messages.find(row => row.id === before.streamingMessageId)!
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
    expect(before.approvals).toHaveLength(1)
    expect(before.clarifies).toHaveLength(1)
    expect(
      before.messages.some(row => row.toolCalls.some(tool => tool.toolId === 'newer-tool'))
    ).toBe(true)
    expect(before.messages.some(row => row.thinking?.includes('Newer reasoning'))).toBe(true)
    await act(async () => gate!.resolve())
    await waitFor(() => expect(answers).toHaveLength(0))
    const after = useTranscripts.getState().bySession.chat!
    expect(after.streamingMessageId).toBe(before.streamingMessageId)
    expect(after.messages.find(row => row.id === before.streamingMessageId)).toEqual(current)

    for (const field of [
      'error',
      'turnActive',
      'turnPrefix',
      'activeTurnId',
      'status',
      'checking',
      'approvals',
      'clarifies'
    ] as const) {
      expect(after[field]).toEqual(before[field])
    }

    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
    expect(cards().find(card => card.textContent?.includes('Late request failed'))).toBeVisible()
    expect(userRows()[0]!.submission?.status).toBe(code === 4002 ? 'rejected' : 'unknown')
  }
)

it.each([false, true])(
  'never binds an unowned run while a local acknowledgement is pending, durable local proof %s',
  async durable => {
    const original = call.getMockImplementation()!
    const response = deferred()
    call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
      const result = await original(method, input)

      if (method === 'prompt.submit') {
        await response.promise
      }

      return result
    })
    const view = await mount()
    await send(view)
    await waitFor(() => expect(delivered).toHaveLength(1))
    const inputId = userRows()[0]!.inputId!

    if (durable) {
      await proveAccepted(inputId, 'own-run')
    }

    act(() => {
      routeEvent({
        type: 'message.start',
        session_id: 'chat',
        payload: { turn_id: 'remote-run', message_id: 'remote-fragment' }
      } as GatewayEvent)
      routeEvent({
        type: 'message.complete',
        session_id: 'chat',
        payload: {
          turn_id: 'remote-run',
          message_id: 'remote-fragment',
          text: 'Remote partial',
          error: 'Remote failed',
          partial: true
        }
      } as GatewayEvent)
    })
    expect(retries()).toHaveLength(0)
    await act(async () => response.resolve())
    await waitFor(() => expect(userRows()[0]!.submission?.status).toBe('accepted'))
    expect(retries()).toHaveLength(0)
    expect(submits()).toHaveLength(1)
    expect(userRows()[0]!.inputId).toBe(inputId)
  }
)

it('never binds an unowned terminal while the local prompt is still awaiting preflight', async () => {
  gate = deferred()
  answers = [new JsonRpcGatewayError('session is already working', { code: 4002 })]
  const view = await mount()
  await send(view)
  await waitFor(() => expect(submits()).toHaveLength(1))
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'remote-run' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'remote-run',
        text: 'Remote partial',
        error: 'Remote failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const remoteCard = await screen.findByTestId('stopped-card')
  expect(retryOn(remoteCard)).toBeNull()
  await act(async () => gate!.resolve())
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(retryOn(remoteCard)).toBeNull()

  const refusedCard = cards().find(card =>
    card.textContent?.includes('session is already working')
  )!

  expect(retryOn(refusedCard)).toBeVisible()
  expect(delivered).toHaveLength(0)
})

it.each([
  'no-user-turn',
  'wrong-turn',
  'foreign-input',
  'ambiguous-turn',
  'ambiguous-unbound-user',
  'untagged-terminal'
] as const)('withholds accepted Retry without unique operation ownership: %s', async missing => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const inputId = userRows()[0]!.inputId!

  if (missing !== 'no-user-turn') {
    await proveAccepted(inputId, missing === 'wrong-turn' ? 'another-turn' : 'own-run')
  }

  if (
    missing === 'foreign-input' ||
    missing === 'ambiguous-turn' ||
    missing === 'ambiguous-unbound-user'
  ) {
    const user = rows.find(row => row.role === 'user')!

    if (missing === 'foreign-input') {
      user.input_id = '00000000-0000-4000-8000-000000000099'
    } else {
      rows.push({
        role: 'user',
        row_id: 'second-user',
        text: 'Same operation',
        ...(missing !== 'ambiguous-unbound-user' && {
          input_id: '00000000-0000-4000-8000-000000000099'
        }),
        turn_id: 'own-run'
      })
    }

    await reload()
  }

  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        ...(missing === 'untagged-terminal' ? {} : { turn_id: 'own-run' }),
        message_id: 'own-fragment',
        text: 'Partial reply',
        error: 'Failed',
        partial: true
      }
    } as GatewayEvent)
  })
  expect(await screen.findByTestId('stopped-card')).toBeVisible()
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(1)
})

it('keeps the original proven card across a later durable remote user and duplicate terminals', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const ownId = userRows()[0]!.inputId!
  await proveAccepted(ownId, 'own-run')
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-run', message_id: 'own-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-run',
        message_id: 'own-fragment',
        text: 'Own partial',
        error: 'Own failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const ownCard = await screen.findByTestId('stopped-card')
  expect(retryOn(ownCard)).toBeVisible()
  rows.push({
    role: 'user',
    row_id: 'remote-user',
    text: 'Separate question from phone',
    input_id: '00000000-0000-4000-8000-000000000099',
    turn_id: 'remote-run'
  })
  await reload()
  expect(await screen.findByText('Separate question from phone')).toBeVisible()
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'remote-run', message_id: 'remote-fragment' }
    } as GatewayEvent)
    // The older terminal cannot end the identified newer stream or take its card.
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-run',
        text: 'Old duplicate',
        error: 'Old duplicate failed',
        partial: true
      }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'remote-run',
        message_id: 'remote-fragment',
        text: 'Remote partial',
        error: 'Remote failed',
        partial: true
      }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-run',
        text: 'Idle old duplicate',
        error: 'Idle duplicate failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const remoteCard = cards().find(card => card.textContent?.includes('Remote failed'))!
  expect(retryOn(remoteCard)).toBeNull()
  expect(cards().filter(card => retryOn(card))).toHaveLength(1)
  expect(retryOn(ownCard)).toBeVisible()
  fireEvent.click(retryOn(ownCard)!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[1]).toMatchObject({ text: 'Read my plan', attachments: [] })
  expect(submits()[1]!.input_id).not.toBe(ownId)
  expect(userRows().find(row => row.inputId === ownId)).toBeDefined()
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-run',
        text: 'Late duplicate',
        error: 'Late duplicate failed',
        partial: true
      }
    } as GatewayEvent)
  )
  expect(retries()).toHaveLength(0)
})

it('binds reverse ordered identified terminals to their proven inputs rather than the latest local request', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const ownA = submits()[0]!.input_id as string
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(2))
  const ownC = submits()[1]!.input_id as string
  expect(ownC).not.toBe(ownA)
  await proveAccepted(ownA, 'own-A')
  await proveAccepted(ownC, 'own-C')
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'own-C', message_id: 'fragment-C' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-A', error: 'Old A while C active', partial: true }
    } as GatewayEvent)
  })
  expect(cards()).toHaveLength(0)
  expect(useTranscripts.getState().bySession.chat!.turnActive).toBe(true)
  act(() => {
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-C',
        message_id: 'fragment-C',
        text: 'Partial C',
        error: 'C failed',
        partial: true
      }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: {
        turn_id: 'own-A',
        message_id: 'fragment-A',
        text: 'Partial A',
        error: 'A failed',
        partial: true
      }
    } as GatewayEvent)
  })
  const transcript = useTranscripts.getState().bySession.chat!
  const inputA = transcript.messages.find(row => row.inputId === ownA)!
  const inputC = transcript.messages.find(row => row.inputId === ownC)!
  expect(transcript.messages.find(row => row.error === 'A failed')?.retryRow).toBe(
    inputA.submission?.row
  )
  expect(transcript.messages.find(row => row.error === 'C failed')?.retryRow).toBe(
    inputC.submission?.row
  )
  expect(cards().filter(card => retryOn(card))).toHaveLength(2)
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-C', error: 'Duplicate C failed', partial: true }
    } as GatewayEvent)
  )
  expect(cards().filter(card => retryOn(card))).toHaveLength(2)
})

it('keeps a newer stream after an actual accepted retry loses its title-save response', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  const card = await screen.findByTestId('stopped-card')
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    const result = await original(method, input)

    if (method === 'prompt.submit') {
      throw new JsonRpcGatewayError('Title save failed', { code: 5200 })
    }

    return result
  })
  gate = deferred()
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: 'newer', message_id: 'newer-fragment' }
    } as GatewayEvent)
    routeEvent({
      type: 'message.delta',
      session_id: 'chat',
      payload: { turn_id: 'newer', message_id: 'newer-fragment', text: 'Newer answer' }
    } as GatewayEvent)
  })
  const before = useTranscripts.getState().bySession.chat!
  await act(async () => gate!.resolve())
  await waitFor(() => expect(userRows()[0]!.submission?.status).toBe('unknown'))
  const after = useTranscripts.getState().bySession.chat!
  expect(delivered).toHaveLength(1)
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  expect(after.streamingMessageId).toBe(before.streamingMessageId)
  expect(after.turnActive).toBe(true)
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
  expect(retries()).toHaveLength(0)
  expect(
    cards().find(card => card.textContent?.includes('Could not confirm acceptance'))
  ).toBeVisible()
})
