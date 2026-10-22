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
    cards().find(card => card.textContent?.includes('It may not have been sent'))
  ).toBeVisible()
})

const opens = () =>
  call.mock.calls.filter(
    ([method, input]) => method === 'hexbot.sections.open' && input.id === 'chat'
  ).length

// The daemon saves an input's row with its operation's turn_id when Pi takes
// it. An open chat reads no history between that and the end of the turn.
function persistTurn(inputId: string, turnId: string) {
  rows.find(row => row.role === 'user' && row.input_id === inputId)!.turn_id = turnId
}

function startTurn(turnId: string, text: string) {
  act(() => {
    routeEvent({
      type: 'message.start',
      session_id: 'chat',
      payload: { turn_id: turnId, message_id: `${turnId}-fragment` }
    } as GatewayEvent)
    routeEvent({
      type: 'message.delta',
      session_id: 'chat',
      payload: { turn_id: turnId, message_id: `${turnId}-fragment`, text }
    } as GatewayEvent)
  })
}

// A provider failure after Pi took the input, as runtime.rs sends it: the
// incident, then the terminal with the operation's turn_id and no fragment.
function failTurn(turnId: string, error = 'Provider overloaded') {
  act(() => {
    routeEvent({
      type: 'hexbot.bots.incident',
      payload: {
        bot: 'owl',
        section_id: 'chat',
        session_id: 'chat',
        incident: { id: `incident-${turnId}`, text: error }
      }
    } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: turnId, text: '', status: 'error', error }
    } as GatewayEvent)
  })
}

// Joins the history read a terminal asked for. It never starts one itself:
// the RPC goes out synchronously, so a new read would show in the count.
const historyRead = () =>
  act(async () => {
    const asked = opens()
    const read = useSections.getState().open('chat')
    expect(opens()).toBe(asked)
    await read.catch(() => undefined)
  })

// Enter sends while a turn runs, when the button shows Stop.
async function sendNow(view: Awaited<ReturnType<typeof mount>>, text: string, names: string[]) {
  const field = screen.getByRole('textbox', { name: 'Message' })
  await waitFor(() => expect(field).toBeEnabled())

  if (names.length) {
    fireEvent.change(view.container.querySelector('input[type=file]')!, {
      target: {
        files: names.map(name => new File([`${name} bytes`], name, { type: 'text/plain' }))
      }
    })
  }

  fireEvent.change(field, { target: { value: text } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

// Everything a running turn shows besides its words: work, cards and status.
function runTurn(identified: boolean) {
  const ids = (extra: Record<string, unknown>, fragment = 'running-fragment') =>
    identified ? { turn_id: 'running', message_id: fragment, ...extra } : extra

  act(() => {
    for (const [type, payload] of [
      ['message.start', ids({})],
      ['message.delta', ids({ text: 'Partial answer' })],
      ['thinking.delta', ids({ text: 'Reading the files' })],
      ['reasoning.delta', ids({ text: 'Running reasoning' })],
      ['tool.start', ids({ tool_id: 'running-tool', name: 'read_file', args: { path: 'a.txt' } })],
      [
        'approval.request',
        ids({ request_id: 'running-approval', choices: ['once'], command: 'read' })
      ],
      [
        'clarify.request',
        ids({ request_id: 'running-question', question: 'Which file?', choices: ['a.txt'] })
      ],
      ['message.delta', ids({ text: 'Still working' }, 'running-next')],
      ['status.update', { kind: 'checking', text: 'Checking this step' }]
    ] as const) {
      routeEvent({ type, session_id: 'chat', payload } as GatewayEvent)
    }
  })

  const before = useTranscripts.getState().bySession.chat!
  const stream = before.messages.find(row => row.id === before.streamingMessageId)!
  expect(stream).toMatchObject({ streaming: true, text: 'Still working' })
  expect(before.messages.flatMap(row => row.toolCalls.map(tool => tool.toolId))).toEqual([
    'running-tool'
  ])
  expect(before.messages.some(row => row.thinking === 'Running reasoning')).toBe(true)
  expect(before.approvals).toHaveLength(1)
  expect(before.clarifies).toHaveLength(1)
  expect(before.checking).toBe('Checking this step')
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()

  return () => {
    const after = useTranscripts.getState().bySession.chat!
    expect(after.streamingMessageId).toBe(before.streamingMessageId)
    expect(before.messages.map(row => after.messages.find(item => item.id === row.id))).toEqual(
      before.messages
    )

    for (const field of [
      'error',
      'turnActive',
      'turnPrefix',
      'activeTurnId',
      'status',
      'checking',
      'approvals',
      'clarifies',
      'unproven'
    ] as const) {
      expect(after[field]).toEqual(before[field])
    }

    expect(after.turnActive).toBe(true)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
  }
}

it.each([true, false])(
  'keeps the running turn, its cards and Stop when an upload fails, transcript identity %s',
  async identified => {
    if (!identified) {
      useConnection.setState({ daemon: { one_chat: true, install_id: 'home' } as DaemonInfo })
    }

    rows.push({ role: 'user', row_id: 'before', text: 'Earlier question' })
    const original = call.getMockImplementation()!
    call.mockImplementation((method: string, input: Record<string, unknown>) =>
      method === 'file.attach'
        ? Promise.reject(
            new JsonRpcGatewayError('payload is not a supported PNG, JPEG, GIF, or WebP image', {
              code: 4017
            })
          )
        : original(method, input)
    )
    const view = await mount()
    expect(await screen.findByText('Earlier reply')).toBeVisible()
    const unchanged = runTurn(identified)
    await sendNow(view, 'Also look at this', ['photo.bmp'])
    const card = await screen.findByText('payload is not a supported PNG, JPEG, GIF, or WebP image')
    unchanged()
    // Nothing was sent, so nothing can be sent again from the card.
    expect(retryOn(card.closest<HTMLElement>('[data-testid=stopped-card]')!)).toBeNull()
    expect(submits()).toHaveLength(0)
    expect(userRows().map(row => row.text)).toEqual(['Earlier question'])
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Also look at this')
    expect(screen.getByRole('button', { name: 'Remove photo.bmp' })).toBeVisible()
  }
)

it('sends only the uploads of the files still selected after an upload fails', async () => {
  const original = call.getMockImplementation()!
  call.mockImplementation((method: string, input: Record<string, unknown>) =>
    method === 'file.attach' && input.name === 'photo.bmp'
      ? Promise.reject(new JsonRpcGatewayError('payload is not a supported image', { code: 4017 }))
      : original(method, input)
  )
  const view = await mount()
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  await sendNow(view, 'Read my plan', ['plan.txt', 'photo.bmp'])
  expect(await screen.findByText('payload is not a supported image')).toBeVisible()
  // plan.txt reached the daemon before photo.bmp failed; that upload stays unnamed.
  expect([...staged.keys()]).toEqual(['srv-1'])
  expect(submits()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Remove photo.bmp' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(submits()[0]).toEqual({
    session_id: 'chat',
    text: 'Read my plan',
    input_id: expect.any(String),
    attachments: ['srv-2']
  })
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  expect(staged.has('srv-1')).toBe(true)
  expect(userRows().map(row => row.attachments.map(item => item.id))).toEqual([['srv-2']])
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove plan.txt' })).toBeNull())
})

it('keeps a newer stream and Stop when an older daemon refuses a Retry late', async () => {
  useConnection.setState({ daemon: { one_chat: true, install_id: 'home' } as DaemonInfo })
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  act(() => {
    routeEvent({ type: 'message.start', session_id: 'chat', payload: {} } as GatewayEvent)
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { error: 'Provider overloaded', status: 'error', text: '' }
    } as GatewayEvent)
  })
  const card = await screen.findByTestId('stopped-card')
  answers = [new JsonRpcGatewayError('session is already working', { code: 4002 })]
  gate = deferred()
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  const unchanged = runTurn(false)
  await act(async () => gate!.resolve())
  const refusal = await screen.findByText('session is already working')
  unchanged()
  expect(submits()[1]).toEqual({ session_id: 'chat', text: 'Read my plan' })
  // The turn's own card keeps its Retry; the refusal adds no second one.
  expect(retryOn(refusal.closest<HTMLElement>('[data-testid=stopped-card]')!)).toBeNull()
  expect(retryOn(card)).toBeVisible()
})

it.each(['message.complete', 'error'] as const)(
  'offers Retry for an accepted failure in an open chat after one history read: %s',
  async terminal => {
    const view = await mount()
    await send(view)
    await waitFor(() => expect(delivered).toHaveLength(1))
    const original = userRows()[0]!
    persistTurn(original.inputId!, 'own-run')
    startTurn('own-run', 'Working on it')
    const before = opens()

    if (terminal === 'error') {
      // A bot process that exits mid-turn sends both terminals for it.
      act(() => {
        routeEvent({
          type: 'error',
          session_id: 'chat',
          payload: { turn_id: 'own-run', message: 'Bot process exited' }
        } as GatewayEvent)
        routeEvent({
          type: 'message.complete',
          session_id: 'chat',
          payload: { turn_id: 'own-run', text: '', status: 'error', error: 'Bot process exited' }
        } as GatewayEvent)
      })
    } else {
      failTurn('own-run')
    }

    expect(retries()).toHaveLength(0)
    await historyRead()
    // The read the first terminal started crossed the second and read again.
    expect(opens()).toBe(before + (terminal === 'error' ? 2 : 1))
    const transcript = useTranscripts.getState().bySession.chat!
    const input = transcript.messages.find(row => row.inputId === original.inputId)!
    expect(input).toMatchObject({ createdAt: 0, turnId: 'own-run' })
    // Exactly the terminal's own card: the first one when both arrive.
    const bound = transcript.messages.filter(row => row.retryRow)
    expect(bound).toHaveLength(1)
    expect(bound[0]).toMatchObject({ retryRow: input.submission?.row, turnId: 'own-run' })
    expect(input.submission?.card).toBe(bound[0]!.id)
    expect(bound[0]!.error).toBe(
      terminal === 'error' ? 'Bot process exited' : 'Provider overloaded'
    )
    expect(transcript.messages.find(row => row.errorDetail?.incidentId)?.retryRow).toBeUndefined()
    expect(cards().filter(card => retryOn(card))).toHaveLength(1)

    fireEvent.click(retries()[0]!)
    await waitFor(() => expect(delivered).toHaveLength(2))
    expect(submits()[1]).toEqual({
      session_id: 'chat',
      text: 'Read my plan',
      input_id: expect.any(String),
      attachments: []
    })
    expect(submits()[1]!.input_id).not.toBe(original.inputId)
    expect(delivered[1]!.files).toEqual([])
    expect(userRows()).toHaveLength(2)
    expect(userRows().find(row => row.id === input.id)?.inputId).toBe(original.inputId)
    expect(retries()).toHaveLength(0)
    await reload()
    expect(await screen.findByText('Reply 2')).toBeVisible()
    expect(userRows()).toHaveLength(2)
    expect(new Set(userRows().map(row => row.inputId)).size).toBe(2)
    expect(retries()).toHaveLength(0)
  }
)

it.each(['Retry', 'a later submission'] as const)(
  'binds the card that history adopts across reads and reopening before %s',
  async next => {
    const view = await mount()
    await send(view)
    await waitFor(() => expect(delivered).toHaveLength(1))
    const inputId = userRows()[0]!.inputId!
    persistTurn(inputId, 'own-run')
    // Pi stored the message before the tool; the request after it failed.
    rows.splice(
      rows.length - 1,
      1,
      {
        role: 'assistant',
        row_id: 'stored-fragment',
        text: 'Let me check',
        turn_id: 'own-run',
        tool_calls: [
          { id: 'own-tool', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'own-tool',
        name: 'read_file',
        text: 'plan',
        turn_id: 'own-run'
      }
    )
    act(() => {
      for (const [type, payload] of [
        ['message.start', { turn_id: 'own-run', message_id: 'stored-fragment' }],
        [
          'message.delta',
          { turn_id: 'own-run', message_id: 'stored-fragment', text: 'Let me check' }
        ],
        [
          'tool.start',
          {
            turn_id: 'own-run',
            message_id: 'stored-fragment',
            tool_id: 'own-tool',
            name: 'read_file'
          }
        ],
        [
          'tool.complete',
          {
            turn_id: 'own-run',
            message_id: 'stored-fragment',
            tool_id: 'own-tool',
            name: 'read_file',
            result: 'plan'
          }
        ]
      ] as const) {
        routeEvent({ type, session_id: 'chat', payload } as GatewayEvent)
      }
    })
    failTurn('own-run', 'Rate limited')
    await historyRead()
    const transcript = useTranscripts.getState().bySession.chat!
    const card = transcript.messages.find(row => row.error === 'Rate limited' && !row.errorDetail)!
    expect(card.id).toBe('stored-fragment')
    expect(card.retryRow).toBe(
      transcript.messages.find(row => row.inputId === inputId)!.submission?.row
    )
    expect(cards().filter(item => retryOn(item))).toHaveLength(1)
    await reload()
    expect(cards().filter(item => retryOn(item))).toHaveLength(1)
    await act(async () => view.router.navigate({ to: '/r/$room', params: { room: 'garden' } }))
    expect(screen.queryByTestId('stopped-card')).toBeNull()
    const before = opens()
    await act(async () =>
      view.router.navigate({ to: '/b/$bot/s/$section', params: { bot: 'owl', section: 'chat' } })
    )
    await waitFor(() => expect(opens()).toBe(before + 1))
    expect(cards().filter(item => retryOn(item))).toHaveLength(1)
    await reload()
    expect(cards().filter(item => retryOn(item))).toHaveLength(1)

    if (next === 'Retry') {
      fireEvent.click(retries()[0]!)
    } else {
      await sendNow(view, 'A new question', [])
    }

    await waitFor(() => expect(delivered).toHaveLength(2))
    expect(submits()[1]).toMatchObject({
      text: next === 'Retry' ? 'Read my plan' : 'A new question',
      attachments: []
    })
    expect(submits()[1]!.input_id).not.toBe(inputId)
    expect(retries()).toHaveLength(0)
    await reload()
    const after = useTranscripts.getState().bySession.chat!
    // The failed card survives, but a later submission revokes its Retry.
    expect(after.messages.find(row => row.id === card.id)?.retryRow).toBe(card.retryRow)
    expect(after.messages.find(row => row.inputId === inputId)?.submission?.card).toBeUndefined()
    expect(retries()).toHaveLength(0)
  }
)

it('keeps a newer run that starts before the read, and binds the failed card', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const inputId = userRows()[0]!.inputId!
  persistTurn(inputId, 'own-run')
  const original = call.getMockImplementation()!
  const read = deferred()
  let held = false
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    if (method !== 'hexbot.sections.open' || !held) {
      return original(method, input)
    }

    // The snapshot is taken when the read reaches the daemon, after the turn ended.
    const snapshot = await original(method, input)
    await read.promise

    return { ...(snapshot as object), busy: false }
  })
  startTurn('own-run', 'Working on it')
  held = true
  const before = opens()
  failTurn('own-run')
  const reading = useSections.getState().open('chat')
  startTurn('remote-run', 'Answer for the phone')
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-run', text: '', status: 'error', error: 'Delayed old terminal' }
    } as GatewayEvent)
  )
  const running = useTranscripts.getState().bySession.chat!
  const stream = running.messages.find(row => row.id === running.streamingMessageId)!
  expect(stream.text).toBe('Answer for the phone')
  await act(async () => {
    read.resolve()
    await reading
  })
  expect(opens()).toBe(before + 1)
  const after = useTranscripts.getState().bySession.chat!
  expect(after.streamingMessageId).toBe(running.streamingMessageId)
  expect(after.activeTurnId).toBe('remote-run')
  expect(after.turnActive).toBe(true)
  expect(after.messages.find(row => row.id === stream.id)).toMatchObject({
    streaming: true,
    text: 'Answer for the phone'
  })
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()
  const bound = after.messages.filter(row => row.retryRow)
  expect(bound).toEqual([
    expect.objectContaining({ error: 'Provider overloaded', turnId: 'own-run' })
  ])
  expect(cards().filter(card => retryOn(card))).toHaveLength(1)
  // The newer run's own failure and an idle duplicate of the old one take nothing.
  held = false
  failTurn('remote-run', 'Remote failed')
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-run', text: '', status: 'error', error: 'Idle old duplicate' }
    } as GatewayEvent)
  )
  await historyRead()
  // Card identity, not text: an incident within 15 s still merges its words
  // into the newest card it finds (incidentEvent, unchanged here).
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.filter(row => row.retryRow)
      .map(row => [row.id, row.turnId])
  ).toEqual([[bound[0]!.id, 'own-run']])
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.find(row => row.turnId === 'remote-run' && row.error)?.retryRow
  ).toBeUndefined()
  expect(cards().filter(card => retryOn(card))).toHaveLength(1)
})

it('reads nothing after a successful turn, then once for an unrelated identical message that fails', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const own = userRows()[0]!
  persistTurn(own.inputId!, 'own-run')
  const before = opens()
  startTurn('own-run', 'Done')
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'own-run', text: 'Done', status: 'complete' }
    } as GatewayEvent)
  )
  expect(opens()).toBe(before)
  rows.push({
    role: 'user',
    row_id: 'phone-identical',
    text: own.text,
    input_id: '00000000-0000-4000-8000-000000000002',
    turn_id: 'remote-run'
  })
  startTurn('remote-run', 'Remote partial')
  failTurn('remote-run', 'Remote failed')
  await historyRead()
  expect(opens()).toBe(before + 1)
  expect(userRows().map(row => row.text)).toEqual([own.text, own.text])
  expect(retries()).toHaveLength(0)
  // This client's input now names its own turn, so another failure reads nothing.
  startTurn('remote-two', 'Second remote partial')
  failTurn('remote-two', 'Second remote failed')
  expect(opens()).toBe(before + 1)
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(1)
})

it.each([
  'no-user-turn',
  'wrong-turn',
  'foreign-input',
  'ambiguous-turn',
  'ambiguous-unbound-user'
] as const)(
  'withholds Retry after the terminal read without unique operation ownership: %s',
  async missing => {
    const view = await mount()
    await send(view)
    await waitFor(() => expect(delivered).toHaveLength(1))
    const user = rows.find(row => row.role === 'user')!

    if (missing !== 'no-user-turn') {
      user.turn_id = missing === 'wrong-turn' ? 'another-turn' : 'own-run'
    }

    if (missing === 'foreign-input') {
      user.input_id = '00000000-0000-4000-8000-000000000099'
    }

    if (missing === 'ambiguous-turn' || missing === 'ambiguous-unbound-user') {
      rows.push({
        role: 'user',
        row_id: 'second-user',
        text: 'Same operation',
        ...(missing === 'ambiguous-turn' && { input_id: '00000000-0000-4000-8000-000000000099' }),
        turn_id: 'own-run'
      })
    }

    const before = opens()
    startTurn('own-run', 'Partial reply')
    failTurn('own-run', 'Failed')
    await historyRead()
    expect(opens()).toBe(before + 1)
    expect(cards().length).toBeGreaterThan(0)
    expect(retries()).toHaveLength(0)
    expect(submits()).toHaveLength(1)
  }
)

it('leaves the card as it is when the read fails, and binds it on the next read', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  persistTurn(userRows()[0]!.inputId!, 'own-run')
  const original = call.getMockImplementation()!
  let failing = true
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    if (method === 'hexbot.sections.open' && failing) {
      failing = false
      throw new Error('connection closed')
    }

    return original(method, input)
  })
  const before = opens()
  startTurn('own-run', 'Working on it')
  failTurn('own-run')
  await historyRead()
  expect(opens()).toBe(before + 1)
  expect(retries()).toHaveLength(0)
  expect(screen.queryByText('connection closed')).toBeNull()
  // A later turn does not ask again for the same card.
  startTurn('later-run', 'Later answer')
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { turn_id: 'later-run', text: 'Later answer', status: 'complete' }
    } as GatewayEvent)
  )
  expect(opens()).toBe(before + 1)
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  await waitFor(() => expect(cards().filter(card => retryOn(card))).toHaveLength(1))
  expect(
    useTranscripts
      .getState()
      .bySession.chat!.messages.filter(row => row.retryRow)
      .map(row => [row.error, row.turnId])
  ).toEqual([['Provider overloaded', 'own-run']])
})

it.each(['accepted', 'unknown'] as const)(
  'binds a terminal that arrives before its prompt reply only once acceptance is %s',
  async outcome => {
    const original = call.getMockImplementation()!
    const response = deferred()
    call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
      const result = await original(method, input)

      if (method === 'prompt.submit') {
        await response.promise

        if (outcome === 'unknown') {
          throw new JsonRpcGatewayError('Title save failed', { code: 5200 })
        }
      }

      return result
    })
    const view = await mount()
    await send(view)
    await waitFor(() => expect(delivered).toHaveLength(1))
    const inputId = userRows()[0]!.inputId!
    persistTurn(inputId, 'own-run')
    startTurn('own-run', 'Working on it')
    failTurn('own-run')
    await historyRead()
    expect(userRows()[0]).toMatchObject({ createdAt: 0, inputId })
    expect(userRows()[0]!.submission?.status).toBe('sending')
    expect(retries()).toHaveLength(0)
    await act(async () => response.resolve())
    await waitFor(() => expect(userRows()[0]!.submission?.status).toBe(outcome))

    if (outcome === 'accepted') {
      expect(cards().filter(card => retryOn(card))).toHaveLength(1)
      fireEvent.click(retries()[0]!)
      await waitFor(() => expect(delivered).toHaveLength(2))
      expect(submits()[1]).toMatchObject({ text: 'Read my plan', attachments: [] })
    } else {
      expect(screen.getByText(/It may not have been sent/)).toBeVisible()
      expect(retries()).toHaveLength(0)
      expect(submits()).toHaveLength(1)
    }
  }
)

it('keeps a refused request on its own row and uploads across the read for an earlier failure', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const first = userRows()[0]!
  persistTurn(first.inputId!, 'first-run')
  startTurn('first-run', 'Working on the plan')
  answers = [new JsonRpcGatewayError('session is already working', { code: 4002 })]
  await sendNow(view, 'Also read my notes', ['notes.txt'])
  const refusal = await screen.findByText('session is already working')
  const refused = userRows().find(row => row.text === 'Also read my notes')!
  const [upload] = submits()[1]!.attachments as string[]
  expect(staged.has(upload!)).toBe(true)
  failTurn('first-run')
  await historyRead()
  expect(cards().filter(card => retryOn(card))).toHaveLength(2)
  fireEvent.click(retryOn(refusal.closest<HTMLElement>('[data-testid=stopped-card]')!)!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[2]).toEqual({
    session_id: 'chat',
    text: 'Also read my notes',
    input_id: expect.any(String),
    attachments: [upload]
  })
  expect(submits()[2]!.input_id).not.toBe(submits()[1]!.input_id)
  expect(delivered[1]!.files).toEqual(['notes.txt'])
  expect(userRows().filter(row => row.text === 'Also read my notes')).toEqual([
    expect.objectContaining({ id: refused.id, inputId: submits()[2]!.input_id })
  ])
  await reload()
  expect(await screen.findByText('Reply 2')).toBeVisible()
  expect(userRows().filter(row => row.text === 'Also read my notes')).toHaveLength(1)
})

it('offers no Retry for an empty-text refusal, which the same send cannot pass', async () => {
  answers = [new JsonRpcGatewayError('missing parameter: text', { code: 4200 })]
  const view = await mount()
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['plan'], 'plan.txt', { type: 'text/plain' })] }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent('missing parameter: text')
  expect(retries()).toHaveLength(0)
  expect(submits()[0]).toMatchObject({ text: '', attachments: ['srv-1'] })
  expect(staged.has('srv-1')).toBe(true)
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
})

it('asks for no files when a text-only send cannot reach its chat', async () => {
  answers = [
    new JsonRpcGatewayError('session not found', { code: 4001 }),
    new JsonRpcGatewayError('session not found', { code: 4001 })
  ]
  const view = await mount()
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  await sendNow(view, 'Plain question', [])
  const card = await screen.findByTestId('stopped-card')
  expect(card).toHaveTextContent('session not found')
  expect(card).not.toHaveTextContent('Attach the files again')
  expect(retries()).toHaveLength(0)
})
