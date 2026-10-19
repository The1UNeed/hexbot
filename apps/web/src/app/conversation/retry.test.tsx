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

it('resends a refused message with only its own restored upload, on the same row', async () => {
  staged.set('phone-upload', { id: 'phone-upload', name: 'phone-draft.txt', session: 'chat' })
  answers = [refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  expect(card).toHaveTextContent('Prompt rejected')
  const first = submits()[0]!
  const [uploaded] = first.attachments as string[]
  expect(uploaded).toMatch(/^srv-/)
  expect(staged.has(uploaded!)).toBe(true)
  const row = userRows()[0]!
  expect(row.attachments.map(item => item.id)).toEqual([uploaded])

  gate = deferred()
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  const second = submits()[1]!
  expect(second).toEqual({
    session_id: 'chat',
    text: 'Read my plan',
    input_id: expect.any(String),
    attachments: [uploaded]
  })
  expect(second.input_id).not.toBe(first.input_id)
  // The retried row carries the new key before the daemon answers; no second row.
  expect(userRows()).toHaveLength(1)
  expect(userRows()[0]).toMatchObject({ id: row.id, inputId: second.input_id })
  expect(retries().filter(button => card!.contains(button))).toHaveLength(0)

  await act(async () => gate!.resolve())
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(delivered[0]).toEqual({
    text: 'Read my plan',
    files: ['plan.txt'],
    input_id: second.input_id
  })
  expect(staged.has('phone-upload')).toBe(true)

  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(screen.getAllByTestId('user-message')).toHaveLength(1)
  expect(within(screen.getByTestId('user-message')).getByText('plan.txt')).toBeVisible()
  expect(userRows()).toHaveLength(1)
  expect(cards().some(item => retryOn(item))).toBe(false)
})

it('binds the retry key to the refused row, so history shows the message once', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  const row = userRows()[0]!
  gate = deferred()
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  const key = submits()[1]!.input_id
  expect(key).not.toBe(row.inputId)
  expect(userRows().map(message => [message.id, message.inputId])).toEqual([[row.id, key]])
  await act(async () => gate!.resolve())
  await waitFor(() => expect(delivered).toHaveLength(1))
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(screen.getAllByTestId('user-message')).toHaveLength(1)
  expect(screen.getAllByText('Read my plan', { selector: '.hex-prose *' })).toHaveLength(1)
})

it('gives every refused retry a fresh key and keeps Retry on the newest card only', async () => {
  answers = [refused(), refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  fireEvent.click(retryOn(cards()[0]!)!)
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(retryOn(cards()[0]!)).toBeNull()
  fireEvent.click(retryOn(cards()[1]!)!)
  await waitFor(() => expect(delivered).toHaveLength(1))

  const keys = submits().map(input => input.input_id)
  expect(new Set(keys).size).toBe(3)
  expect(submits().map(input => input.attachments)).toEqual([
    submits()[0]!.attachments,
    submits()[0]!.attachments,
    submits()[0]!.attachments
  ])
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  expect(userRows()).toHaveLength(1)
  expect(userRows()[0]!.inputId).toBe(keys[2])
  expect(cards().some(card => retryOn(card))).toBe(false)

  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(screen.getAllByTestId('user-message')).toHaveLength(1)
})

it('asks for the files again when the refused upload is gone, without a text-only send', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  const [uploaded] = submits()[0]!.attachments as string[]
  // An older client's submit without a list takes every staged upload.
  staged.clear()
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(cards()[1]).toHaveTextContent(`attachment not found: ${uploaded}; attach it again`)
  expect(submits()[1]!.attachments).toEqual([uploaded])
  expect(delivered).toHaveLength(0)
  // No card or bubble can resend it; the composer still holds the file.
  expect(retries()).toHaveLength(0)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Read my plan')
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
})

it('never lets a remote message that arrived after the refusal become the retry', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  rows.push(
    {
      role: 'user',
      row_id: 'phone-user',
      text: 'Question from my phone',
      input_id: '00000000-0000-4000-8000-000000000001'
    },
    { role: 'assistant', row_id: 'phone-reply', text: 'Phone answer' }
  )
  await reload()
  expect(await screen.findByText('Phone answer')).toBeVisible()
  const card = cards().find(item => item.textContent?.includes('Prompt rejected'))!
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(submits()[1]).toMatchObject({
    text: 'Read my plan',
    attachments: submits()[0]!.attachments
  })
  expect(delivered[0]).toMatchObject({ text: 'Read my plan', files: ['plan.txt'] })
})

it('offers no Retry when acceptance is unknown, leaving the draft to send again', async () => {
  answers = [new Error('connection closed')]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  expect(card).toHaveTextContent('connection closed')
  expect(retries()).toHaveLength(0)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Read my plan')
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
  expect(submits()).toHaveLength(1)
})

it('retries an accepted turn without its consumed uploads or its row key', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const row = userRows()[0]!
  await act(async () => {
    routeEvent({
      type: 'error',
      session_id: 'chat',
      payload: { message: 'Provider overloaded' }
    } as GatewayEvent)
  })
  const card = cards().find(item => item.textContent?.includes('Provider overloaded'))!
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[1]).toEqual({
    session_id: 'chat',
    text: 'Read my plan',
    input_id: expect.any(String),
    attachments: []
  })
  expect(submits()[1]!.input_id).not.toBe(row.inputId)
  expect(delivered[1]!.files).toEqual([])
  expect(userRows().find(message => message.id === row.id)?.inputId).toBe(row.inputId)
})

it('retries a refused reopen resend with the uploads made for the reopened chat', async () => {
  answers = [new JsonRpcGatewayError('session not found', { code: 4001 }), refused()]
  const view = await mount()
  await send(view)
  await waitFor(() => expect(cards()).toHaveLength(1))
  const [initial, reopened] = submits().map(input => input.attachments as string[])
  expect(reopened).not.toEqual(initial)
  expect(staged.has(reopened![0]!)).toBe(true)
  const row = userRows().at(-1)!
  fireEvent.click(retryOn(cards()[0]!)!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(submits()[2]).toMatchObject({ attachments: reopened })
  expect(submits()[2]!.input_id).not.toBe(submits()[1]!.input_id)
  expect(userRows().filter(message => message.text === 'Read my plan')).toHaveLength(1)
  expect(userRows().at(-1)).toMatchObject({ id: row.id, inputId: submits()[2]!.input_id })
  expect(delivered[0]!.files).toEqual(['plan.txt'])
})

it('offers no Retry when only some files reached the reopened chat', async () => {
  answers = [new JsonRpcGatewayError('session not found', { code: 4001 })]
  const view = await mount()
  const original = call.getMockImplementation()!
  let attaches = 0
  call.mockImplementation((method: string, input: Record<string, unknown>) =>
    method === 'file.attach' && ++attaches === 4
      ? Promise.reject(new JsonRpcGatewayError('attachment exceeds 45 MiB', { code: 4202 }))
      : original(method, input)
  )
  await send(view, ['plan.txt', 'notes.txt'])
  const [card] = await screen.findAllByTestId('stopped-card')
  expect(card).toHaveTextContent('attachment exceeds 45 MiB')
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(1)
  expect(delivered).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible()
})

it('applies a refusal that lands after leaving the chat without drawing a card there', async () => {
  answers = [refused(), refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  gate = deferred()
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  expect(retries().filter(button => card!.contains(button))).toHaveLength(0)
  await act(async () => {
    await view.router.navigate({ to: '/r/$room', params: { room: 'garden' } })
  })
  expect(await screen.findByText('Garden room')).toBeVisible()
  await act(async () => gate!.resolve())
  await waitFor(() => expect(answers).toHaveLength(0))
  gate = null
  await act(async () => view.router.history.back())
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  expect(cards()).toHaveLength(1)
  fireEvent.click(retryOn(cards()[0]!)!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(submits()[2]).toMatchObject({ attachments: submits()[0]!.attachments })
  expect(delivered[0]!.files).toEqual(['plan.txt'])
})

it('keeps a retry whose answer arrives after a reconnect behind the draft', async () => {
  answers = [refused(), refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  gate = deferred()
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(submits()).toHaveLength(2))
  act(() => useConnection.setState({ epoch: 'second' }))
  await act(async () => gate!.resolve())
  await waitFor(() => expect(answers).toHaveLength(0))
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  expect(cards()).toHaveLength(1)
  expect(retries()).toHaveLength(0)
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Read my plan')
  expect(submits()).toHaveLength(2)
})

it('offers no Retry in a teammate thread', async () => {
  const row = useTranscripts.getState().appendUserMessage('peer', 'Read my plan')
  useTranscripts.getState().errorEvent('peer', 'Prompt rejected')
  await mount('/b/owl/s/peer')
  expect(await screen.findByText('Peer thread')).toBeVisible()
  expect(useTranscripts.getState().bySession.peer?.messages.some(item => item.id === row.id)).toBe(
    true
  )
  expect(screen.getByTestId('stopped-card')).toHaveTextContent('Prompt rejected')
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(0)
})

it('keeps the older request shape for a daemon without transcript identity', async () => {
  useConnection.setState({ daemon: { one_chat: true } as DaemonInfo })
  answers = [refused()]
  const view = await mount()
  await send(view)
  const [card] = await screen.findAllByTestId('stopped-card')
  expect(submits()[0]).toEqual({ session_id: 'chat', text: 'Read my plan' })
  fireEvent.click(retryOn(card!)!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(submits()[1]).toEqual({ session_id: 'chat', text: 'Read my plan' })
  expect(delivered[0]!.files).toEqual(['plan.txt'])
})

it('keeps identical remote text separate from the explicitly refused local input', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  const local = userRows()[0]!
  rows.push({
    role: 'user',
    row_id: 'phone-identical',
    text: local.text,
    input_id: '00000000-0000-4000-8000-000000000002'
  })
  await reload()
  await waitFor(() => expect(userRows()).toHaveLength(2))
  fireEvent.click(retries()[0]!)
  await waitFor(() => expect(delivered).toHaveLength(1))
  expect(userRows().find(row => row.id === local.id)?.inputId).toBe(submits()[1]!.input_id)
  expect(userRows().find(row => row.id === 'phone-identical')?.inputId).toBe(
    '00000000-0000-4000-8000-000000000002'
  )
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(screen.getAllByTestId('user-message')).toHaveLength(2)
})

it('leaves a partial restored upload set untouched when one file disappears', async () => {
  answers = [refused()]
  staged.set('phone-upload', { id: 'phone-upload', name: 'phone.txt', session: 'chat' })
  const view = await mount()
  await send(view, ['plan.txt', 'notes.txt'])
  await screen.findByTestId('stopped-card')
  const ids = submits()[0]!.attachments as string[]
  staged.delete(ids[1]!)
  fireEvent.click(retries()[0]!)
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(submits()[1]!.attachments).toEqual(ids)
  expect(delivered).toHaveLength(0)
  expect(staged.has(ids[0]!)).toBe(true)
  expect(staged.has('phone-upload')).toBe(true)
  expect(retries()).toHaveLength(0)
  expect(cards()[1]).toHaveTextContent('Attach the files again')
})

it.each([4002, 4202, 5201])(
  'reuses the exact owned upload set after RPC refusal %s',
  async code => {
    answers = [new JsonRpcGatewayError('Explicit refusal', { code })]
    const view = await mount()
    await send(view)
    await screen.findByTestId('stopped-card')
    fireEvent.click(retries()[0]!)
    await waitFor(() => expect(delivered).toHaveLength(1))
    expect(submits()[1]!.attachments).toEqual(submits()[0]!.attachments)
    expect(delivered[0]!.files).toEqual(['plan.txt'])
  }
)

it.each([
  new JsonRpcGatewayError('Title could not be saved', { code: 5200 }),
  new Error('Reply lost after acceptance')
])('does not call an accepted but failed response a refusal: %s', async failure => {
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    const result = await original(method, input)

    if (method === 'prompt.submit') {
      throw failure
    }

    return result
  })
  const view = await mount()
  await send(view)
  const card = await screen.findByTestId('stopped-card')
  expect(card).toHaveTextContent('Could not confirm acceptance')
  expect(retries()).toHaveLength(0)
  expect(delivered[0]!.files).toEqual(['plan.txt'])
  expect(staged.size).toBe(0)
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
  expect(userRows()[0]!.submission?.status).toBe('unknown')
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(userRows()).toHaveLength(1)
  expect(retries()).toHaveLength(0)
})

it('does not trust a code property on an arbitrary transport error', async () => {
  answers = [Object.assign(new Error('Transport failed'), { code: 5201 })]
  const view = await mount()
  await send(view)
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent(
    'Could not confirm acceptance'
  )
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(1)
})

it('requires reattachment when an initial upload has no server ID', async () => {
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    const result = await original(method, input)

    return method === 'file.attach' ? { attached: true } : result
  })
  const view = await mount()
  await send(view)
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent(
    'did not return an attachment ID'
  )
  expect(submits()).toHaveLength(0)
  expect(userRows()).toHaveLength(0)
  expect(retries()).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Remove plan.txt' })).toBeVisible()
})

it('does not submit text or retry a previous row when an initial upload fails partway', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  const original = call.getMockImplementation()!
  let attaches = 0
  call.mockImplementation((method: string, input: Record<string, unknown>) =>
    method === 'file.attach' && ++attaches === 2
      ? Promise.reject(new JsonRpcGatewayError('Too large', { code: 4202 }))
      : original(method, input)
  )
  // The refused draft already has plan.txt, adding notes.txt makes two uploads.
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(cards()[1]).toHaveTextContent('Too large')
  expect(retryOn(cards()[1]!)).toBeNull()
  expect(submits()).toHaveLength(1)
  expect(delivered).toHaveLength(0)
})

it('does not transfer a refused input to an unrelated error card', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  act(() => useTranscripts.getState().errorEvent('chat', 'Unrelated remote failure'))
  expect(cards()).toHaveLength(2)
  expect(retryOn(cards()[0]!)).toBeVisible()
  expect(retryOn(cards()[1]!)).toBeNull()
})

it('offers no retry for remote history and errors without local submission provenance', async () => {
  rows.push({ role: 'user', row_id: 'remote-user', text: 'Read my plan' })
  await mount()
  expect(await screen.findByText('Read my plan')).toBeVisible()
  act(() => useTranscripts.getState().errorEvent('chat', 'Prompt rejected'))
  expect(await screen.findByTestId('stopped-card')).toBeVisible()
  expect(retries()).toHaveLength(0)
  expect(submits()).toHaveLength(0)
})

it('checks the route again when an obsolete Retry callback fires', async () => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  const button = retries()[0]!
  await act(async () => view.router.navigate({ to: '/r/$room', params: { room: 'garden' } }))
  fireEvent.click(button)
  expect(submits()).toHaveLength(1)
  expect(await screen.findByText('Garden room')).toBeVisible()
})

it.each(['epoch', 'target'] as const)('invalidates retry provenance on a new %s', async change => {
  answers = [refused()]
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  act(() =>
    useConnection.setState(
      change === 'epoch'
        ? { epoch: 'new-daemon-epoch' }
        : { target: { kind: 'local', origin: 'http://localhost:9333' } }
    )
  )
  await waitFor(() => expect(retries()).toHaveLength(0))
  expect(submits()).toHaveLength(1)
})

it('retries an accepted terminal failure as a new text-only input and adopts each row once', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  const original = userRows()[0]!
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { error: 'Provider stopped', status: 'error', text: '' }
    } as GatewayEvent)
  )
  const card = await screen.findByTestId('stopped-card')
  fireEvent.click(retryOn(card)!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[1]!.attachments).toEqual([])
  expect(userRows()).toHaveLength(2)
  expect(userRows().find(row => row.id === original.id)?.inputId).toBe(original.inputId)
  expect(new Set(userRows().map(row => row.inputId)).size).toBe(2)
  await reload()
  expect(await screen.findByText('Reply 2')).toBeVisible()
  expect(userRows()).toHaveLength(2)
  expect(retries()).toHaveLength(0)
})

it('does not assign later unowned errors to a successfully completed local turn', async () => {
  const view = await mount()
  await send(view)
  await waitFor(() => expect(delivered).toHaveLength(1))
  act(() =>
    routeEvent({
      type: 'message.complete',
      session_id: 'chat',
      payload: { text: 'Done', status: 'complete' }
    } as GatewayEvent)
  )
  act(() => useTranscripts.getState().errorEvent('chat', 'Another client failed'))
  expect(await screen.findByTestId('stopped-card')).toHaveTextContent('Another client failed')
  expect(retries()).toHaveLength(0)
})

it.each(['install', 'identity'] as const)(
  'does not carry identified Retry across a changed %s',
  async change => {
    answers = [refused()]
    const view = await mount()
    await send(view)
    await screen.findByTestId('stopped-card')
    act(() =>
      useConnection.setState({
        daemon:
          change === 'install'
            ? { ...identity, install_id: 'another-home' }
            : { ...identity, transcript_identity: false }
      })
    )
    await waitFor(() => expect(retries()).toHaveLength(0))
    expect(submits()).toHaveLength(1)
  }
)

it('uses exact durable acceptance over a failed RPC when choosing whether to reuse files', async () => {
  const original = call.getMockImplementation()!
  let first = true
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    const result = await original(method, input)

    if (method === 'prompt.submit' && first) {
      first = false
      throw refused()
    }

    return result
  })
  const view = await mount()
  await send(view)
  await screen.findByTestId('stopped-card')
  await reload()
  expect(await screen.findByText('Reply 1')).toBeVisible()
  expect(userRows()).toHaveLength(1)
  const accepted = userRows()[0]!
  fireEvent.click(retries()[0]!)
  await waitFor(() => expect(delivered).toHaveLength(2))
  expect(submits()[1]!.attachments).toEqual([])
  expect(userRows().find(row => row.id === accepted.id)?.inputId).toBe(accepted.inputId)
  expect(userRows()).toHaveLength(2)
})
