import { act, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'

import { ClarifyCard } from '../app/conversation/clarify-card'
import { ConnectionSupervisor } from '../lib/connection'
import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Room } from '../lib/types'

import { useBots } from './bots'
import { useConnection } from './connection'
import { useRooms } from './rooms'
import { botStatusWithLive, liveSectionsOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

type CardKind = 'approval' | 'clarify'

const rooms: Room[] = ['named', 'sibling'].map(id => ({
  id,
  approval_mode: null,
  archived_at: null,
  created_at: 1,
  last_activity_at: 1,
  limits: {},
  main_bot: null,
  members: [],
  name: id,
  owner_id: 'owner',
  turns: [{ bot: 'owl', live_session_id: `${id}-live` }],
  updated_at: 1
}))

const bot = {
  name: 'owl',
  status: 'working',
  status_detail: { room_id: 'named', section_id: null, session_id: 'named-live' }
} as Bot

function card(kind: CardKind, sessionId = 'sibling-live', requestId = 'pending') {
  routeEvent(
    {
      type: `${kind}.request`,
      session_id: sessionId,
      payload: {
        bot: 'owl',
        section_id: 'stored-sibling',
        request_id: requestId,
        question: 'Choose?'
      }
    } as never,
    { refreshBots: vi.fn() }
  )
}

function status() {
  const sessions = useTranscripts.getState().bySession

  return botStatusWithLive(bot, [], liveSectionsOf(sessions), sessions)
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(release => {
    resolve = release
  })

  return { promise, resolve }
}

function resolveCard(kind: CardKind, requestId = 'pending') {
  routeEvent(
    {
      type: `${kind}.resolved`,
      session_id: 'sibling-live',
      payload:
        kind === 'approval'
          ? { request_id: requestId, choice: 'once' }
          : { request_id: requestId, status: 'answered', answers: { [requestId]: 'Yes' } }
    } as never,
    { refreshBots: vi.fn() }
  )
}

function batchReplay(answers: Record<string, string> = {}) {
  routeEvent({
    type: 'clarify.request',
    session_id: 'sibling-live',
    payload: {
      bot: 'owl',
      section_id: 'stored-sibling',
      request_id: 'batch',
      questions: [
        { qid: 'a', question: 'First?' },
        { qid: 'b', question: 'Second?' }
      ],
      answers
    }
  } as never)
}

function fixture(kind: CardKind, history: 'empty' | 'live messages') {
  useBots.setState({ byName: { owl: bot }, order: ['owl'] })
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {} })
  useRooms.setState({ byId: {}, eventsByRoom: {}, liveTurnsByRoom: {}, order: [] })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })

  for (const room of rooms) {
    useRooms.getState().handleTurn({
      bot: 'owl',
      room_id: room.id,
      live_session_id: `${room.id}-live`,
      status: 'running'
    })
  }

  if (history === 'live messages') {
    useTranscripts.getState().appendUserMessage('sibling-live', 'Hello')
  }

  card(kind)

  const call = vi.fn((method: string) =>
    Promise.resolve(method === 'hexbot.rooms.list' ? { rooms } : { events: [] })
  )

  setActiveRpc({ call } as never)

  return { call, before: useTranscripts.getState().bySession['sibling-live']! }
}

afterEach(() => resetTranscriptEffects())

describe('retained room batch replay', () => {
  it.each([
    ['open', 'empty'],
    ['open', 'live messages'],
    ['refreshOne', 'empty'],
    ['refreshOne', 'live messages']
  ] as const)('locks another client\'s answer on %s with %s history', async (method, history) => {
    fixture('clarify', history)
    useTranscripts.getState().clarifyExpire('sibling-live', 'pending')
    batchReplay()
    const before = useTranscripts.getState().bySession['sibling-live']!
    setActiveRpc({
      call: vi.fn(async (rpc: string) => {
        if (rpc === 'hexbot.rooms.get') {
          // Native rooms.get replays current pending cards before its RPC reply.
          batchReplay({ a: 'Peer answer' })

          return { room: rooms[1] }
        }

        return { events: [] }
      })
    } as never)
    await useRooms.getState()[method]('sibling')
    const after = useTranscripts.getState().bySession['sibling-live']!
    const batch = after.clarifies.find(item => item.requestId === 'batch')!
    expect(batch.answers).toEqual({ a: 'Peer answer' })
    expect(Object.hasOwn(batch.answers, 'b')).toBe(false)
    expect(after.clarifies.filter(item => item.requestId === 'batch')).toHaveLength(1)
    expect(after.epoch).toBe(before.epoch)
    expect(after.sectionId).toBe('room:sibling')
    expect(after.bot).toBe('owl')
    expect(after.waitingRequests).toEqual([
      expect.objectContaining({ kind: 'clarify', requestId: 'batch' })
    ])
    expect(status()).toBe('needs_you')
  })

  it.each(['empty', 'live messages'] as const)(
    'locks the peer answer after same-daemon reconnect and submits only the remaining question (%s)',
    async history => {
      fixture('clarify', history)
      useTranscripts.getState().clarifyExpire('sibling-live', 'pending')
      batchReplay()
      const state = { answers: {} as Record<string, string> }
      const sockets: TestSocket[] = []
      const requests: { method: string; params: Record<string, unknown> }[] = []

      class TestSocket extends EventTarget {
        readyState = 0

        constructor() {
          super()
          sockets.push(this)
          queueMicrotask(() => {
            this.readyState = 1
            this.dispatchEvent(new Event('open'))
            this.frame({
              jsonrpc: '2.0',
              method: 'event',
              params: { type: 'gateway.ready', payload: { replay_epoch: 'epoch-A' } }
            })
          })
        }

        frame(value: unknown) {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
        }

        event(type: string, payload: Record<string, unknown>) {
          this.frame({
            jsonrpc: '2.0',
            method: 'event',
            params: { type, session_id: 'sibling-live', payload }
          })
        }

        send(data: string) {
          const { id, method, params } = JSON.parse(data)
          requests.push({ method, params })
          let result: unknown = {}

          if (method === 'hexbot.bots.list') {
            result = { bots: [bot] }
          } else if (method === 'hexbot.rooms.list') {
            result = { rooms }
          } else if (method === 'hexbot.rooms.log') {
            result = { events: [] }
          } else if (method === 'hexbot.info') {
            result = { install_id: 'fixture', daemon_name: 'fixture' }
          } else if (method === 'hexbot.rooms.get') {
            this.event('clarify.request', {
              bot: 'owl',
              section_id: 'stored-sibling',
              request_id: 'batch',
              questions: [
                { qid: 'a', question: 'First?' },
                { qid: 'b', question: 'Second?' }
              ],
              answers: state.answers
            })
            result = { room: rooms[1] }
          } else if (method === 'clarify.respond') {
            state.answers = { ...state.answers, [params.question_id]: params.answer }
            this.event('clarify.resolved', {
              request_id: 'batch',
              status: 'answered',
              answers: state.answers
            })
            this.event('status.update', { kind: 'working', text: 'Working' })
            result = { status: 'answered', answers: state.answers }
          }

          queueMicrotask(() => this.frame({ jsonrpc: '2.0', id, result }))
        }

        close() {
          this.readyState = 3
          this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
        }
      }

      useConnection.setState({ epoch: 'epoch-A', daemon: null })

      const supervisor = new ConnectionSupervisor({
        bridge: () => null,
        fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
        socketFactory: () => new TestSocket() as unknown as WebSocket
      })

      try {
        await supervisor.start({ kind: 'local' })
        const epoch = useTranscripts.getState().bySession['sibling-live']!.epoch
        sockets[0]!.close()
        state.answers = { a: 'Peer answer' }
        await supervisor.retryNow()
        await useRooms.getState().open('sibling')

        const batch = () =>
          useTranscripts
            .getState()
            .bySession['sibling-live']!.clarifies.find(item => item.requestId === 'batch')!

        expect(useTranscripts.getState().bySession['sibling-live']?.epoch).toBe(epoch)
        expect(batch().answers).toEqual({ a: 'Peer answer' })
        const view = render(createElement(ClarifyCard, { clarify: batch() }))

        expect(view.getByText('Peer answer')).toBeVisible()
        expect(view.getAllByRole('textbox', { name: 'Your own answer' })).toHaveLength(1)
        fireEvent.change(view.getByRole('textbox', { name: 'Your own answer' }), {
          target: { value: 'Local answer' }
        })
        await act(async () => {
          fireEvent.click(view.getByRole('button', { name: 'Done' }))
        })
        expect(batch().answers).toEqual({ a: 'Peer answer', b: 'Local answer' })
        expect(requests.filter(request => request.method === 'clarify.respond')).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ request_id: 'batch', question_id: 'b' })
          })
        ])
        expect(requests.map(request => request.method)).not.toContain('session.events.since')
        view.rerender(createElement(ClarifyCard, { clarify: batch() }))
        expect(view.queryByRole('textbox', { name: 'Your own answer' })).toBeNull()
        expect(status()).toBe('working')
        view.unmount()
      } finally {
        supervisor.stop()
      }
    }
  )
})

describe.each(['approval', 'clarify'] as const)('%s confirmation on room refresh', kind => {
  it.each(['empty', 'live messages'] as const)(
    'retains a pending sibling card with %s history',
    async history => {
      const { before } = fixture(kind, history)
      expect(status()).toBe('needs_you')

      await useRooms.getState().refresh()

      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.waitingRequests).toEqual(before.waitingRequests)
      expect(after.epoch).toBe(before.epoch)
      expect(after.sectionId).toBe('room:sibling')
      expect(after.bot).toBe('owl')
      expect(status()).toBe('needs_you')
    }
  )

  it.each(['list', 'log'] as const)(
    'keeps a newer card received while awaiting the %s',
    async stage => {
      fixture(kind, 'empty')
      const pending = deferred<unknown>()

      const call = vi.fn((method: string) => {
        if (method === `hexbot.rooms.${stage}`) {
          return pending.promise
        }

        return Promise.resolve(method === 'hexbot.rooms.list' ? { rooms } : { events: [] })
      })

      setActiveRpc({ call } as never)
      const refreshing = useRooms.getState().refresh()
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith(`hexbot.rooms.${stage}`, expect.anything())
      )
      card(kind, 'sibling-live', 'newer')
      const before = useTranscripts.getState().bySession['sibling-live']!
      pending.resolve(stage === 'list' ? { rooms } : { events: [] })
      await refreshing
      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.authorityRevision).toBe(before.authorityRevision)
      expect(after.waitingRequests).toEqual(before.waitingRequests)
      expect(status()).toBe('needs_you')
    }
  )

  it.each(['before fetch', 'during fetch'] as const)(
    'does not revive a settled card answered %s',
    async timing => {
      fixture(kind, 'live messages')
      const pending = deferred<{ rooms: Room[] }>()

      setActiveRpc({
        call: vi.fn((method: string) =>
          method === 'hexbot.rooms.list' ? pending.promise : Promise.resolve({ events: [] })
        )
      } as never)

      if (timing === 'before fetch') {
        resolveCard(kind)
      }

      const refreshing = useRooms.getState().refresh()

      if (timing === 'during fetch') {
        resolveCard(kind)
      }

      const answered = useTranscripts.getState().bySession['sibling-live']!
      pending.resolve({ rooms })
      await refreshing
      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.waitingRequests).toEqual([])
      expect(after.answeredWaiting).toEqual(
        timing === 'during fetch' ? answered.answeredWaiting : undefined
      )
      expect(after.approvalDecisions).toEqual(answered.approvalDecisions)
      expect(after.settledClarifyIds).toEqual(answered.settledClarifyIds)
      expect(status()).toBe('working')
    }
  )

  it.each(['idle', 'complete', 'error'] as const)(
    'does not revive a retained card after %s authority',
    async boundary => {
      fixture(kind, 'empty')
      const actions = useTranscripts.getState()

      if (boundary === 'idle') {
        actions.statusUpdate('sibling-live', { kind: 'idle', text: '' })
      } else if (boundary === 'complete') {
        actions.messageComplete('sibling-live', { text: 'Done' })
      } else {
        actions.errorEvent('sibling-live', 'Failed')
      }

      await useRooms.getState().refresh()
      expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual([])
      expect(status()).toBe('working')
    }
  )

  it.each(['matched working', 'aggregate idle'] as const)(
    'respects %s bot authority before a subsequent room rebind',
    async boundary => {
      fixture(kind, 'empty')

      const roster = {
        ...bot,
        status: boundary === 'aggregate idle' ? 'idle' : 'working',
        status_detail:
          boundary === 'aggregate idle'
            ? null
            : { room_id: 'sibling', section_id: null, session_id: 'sibling-live' }
      }

      setActiveRpc({
        call: vi.fn((method: string) =>
          Promise.resolve(
            method === 'hexbot.bots.list'
              ? { bots: [roster] }
              : method === 'hexbot.rooms.list'
                ? { rooms }
                : { events: [] }
          )
        )
      } as never)

      await useBots.getState().refresh()
      await useRooms.getState().refresh()
      expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual([])
    }
  )

  it.each(['empty', 'live messages'] as const)(
    'retires old answer, working, and retry evidence while retaining %s pending cards',
    async history => {
      fixture(kind, history)
      const actions = useTranscripts.getState()
      card('approval', 'sibling-live', 'answered')
      actions.resolveApproval('sibling-live', 'answered', 'once')
      actions.messageStart('sibling-live', true)
      actions.statusUpdate('sibling-live', { kind: 'working', text: '' })
      card(kind)
      const confirmation = useTranscripts.getState().bySession['sibling-live']!.waitingRequests

      await useRooms.getState().refresh()

      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.waitingRequests).toEqual(confirmation)
      expect(after.liveStatus).toBeUndefined()
      expect(after.retryResolved).toBeUndefined()
      expect(after.answeredWaiting).toBeUndefined()
      expect(status()).toBe('needs_you')
    }
  )

  it('retains confirmations on a repeated running-turn notification', () => {
    const { before } = fixture(kind, 'live messages')
    useRooms.getState().handleTurn({
      bot: 'owl',
      room_id: 'sibling',
      live_session_id: 'sibling-live',
      status: 'running'
    })
    expect(useTranscripts.getState().bySession['sibling-live']!.waitingRequests).toEqual(
      before.waitingRequests
    )
    expect(status()).toBe('needs_you')
  })

  it.each(['working', 'idle'] as const)(
    'retains fresh %s authority received while the room log loads',
    async transition => {
      fixture(kind, 'live messages')
      const log = deferred<{ events: [] }>()

      const call = vi.fn((method: string) =>
        method === 'hexbot.rooms.log' ? log.promise : Promise.resolve({ rooms })
      )

      setActiveRpc({ call } as never)
      const refreshing = useRooms.getState().refresh()
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith('hexbot.rooms.log', expect.anything())
      )
      useTranscripts.getState().statusUpdate('sibling-live', { kind: transition, text: '' })
      const before = useTranscripts.getState().bySession['sibling-live']!
      log.resolve({ events: [] })
      await refreshing
      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.authorityRevision).toBe(before.authorityRevision)
      expect(after.liveStatus).toBe(transition)
      expect(after.waitingRequests).toEqual(before.waitingRequests)
      expect(status()).toBe(transition === 'working' ? 'needs_you' : 'working')
    }
  )

  it('uses the newer live turn and card when a turn ends while the log loads', async () => {
    fixture(kind, 'live messages')
    const log = deferred<{ events: [] }>()

    const call = vi.fn((method: string) =>
      method === 'hexbot.rooms.log' ? log.promise : Promise.resolve({ rooms })
    )

    setActiveRpc({ call } as never)
    const refreshing = useRooms.getState().refresh()
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('hexbot.rooms.log', expect.anything()))
    useRooms.getState().handleTurn({
      bot: 'owl',
      room_id: 'sibling',
      live_session_id: 'sibling-live',
      status: 'complete'
    })
    useRooms.getState().handleTurn({
      bot: 'owl',
      room_id: 'sibling',
      live_session_id: 'next-live',
      status: 'running'
    })
    card(kind, 'next-live', 'next-pending')
    const before = useTranscripts.getState().bySession['next-live']!
    log.resolve({ events: [] })
    await refreshing
    expect(useTranscripts.getState().bySession['sibling-live']).toBeUndefined()
    expect(useRooms.getState().liveTurnsByRoom.sibling?.owl?.live_session_id).toBe('next-live')
    expect(useTranscripts.getState().bySession['next-live']?.waitingRequests).toEqual(
      before.waitingRequests
    )
    expect(status()).toBe('needs_you')
  })

  it('keeps confirmations when an older daemon omits the turn snapshot', async () => {
    const { before } = fixture(kind, 'empty')
    const legacyRooms = rooms.map(({ turns: _, ...room }) => room)

    setActiveRpc({
      call: vi.fn((method: string) =>
        Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: legacyRooms } : { events: [] })
      )
    } as never)
    await useRooms.getState().refresh()
    expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual(
      before.waitingRequests
    )
    expect(status()).toBe('needs_you')
  })

  it.each(['absent', 'archived', 'replaced'] as const)(
    'drops old pending authority when the snapshot turn is %s',
    async boundary => {
      fixture(kind, 'live messages')

      const changed = rooms.map(room =>
        room.id !== 'sibling'
          ? room
          : {
              ...room,
              archived_at: boundary === 'archived' ? 1 : null,
              turns:
                boundary === 'replaced' ? [{ bot: 'owl', live_session_id: 'replacement-live' }] : []
            }
      )

      setActiveRpc({
        call: vi.fn((method: string) =>
          Promise.resolve(method === 'hexbot.rooms.list' ? { rooms: changed } : { events: [] })
        )
      } as never)

      await useRooms.getState().refresh()
      expect(useTranscripts.getState().bySession['sibling-live']).toBeUndefined()
      expect(status()).toBe('working')

      if (boundary === 'replaced') {
        expect(useTranscripts.getState().bySession['replacement-live']?.waitingRequests).toEqual([])
      }
    }
  )

  it('leaves unrelated private and room owners untouched', async () => {
    fixture(kind, 'live messages')
    const actions = useTranscripts.getState()
    actions.open('private-live', 'private-thread', [], undefined, 'cat')
    actions.approvalRequest('private-live', { request_id: 'private' }, { notify: false })
    actions.open('cat-live', 'room:sibling', [], undefined, 'cat')
    actions.clarifyRequest('cat-live', { request_id: 'cat', question: 'Pick?' }, { notify: false })
    const privateBefore = useTranscripts.getState().bySession['private-live']
    const catBefore = useTranscripts.getState().bySession['cat-live']

    await useRooms.getState().refresh()
    expect(useTranscripts.getState().bySession['private-live']).toBe(privateBefore)
    expect(useTranscripts.getState().bySession['cat-live']).toBe(catBefore)
    resolveCard(kind)
    expect(status()).toBe('working')
  })

  it.each(['before refresh', 'after refresh'] as const)(
    'settles an answer begun %s without reviving old optimism',
    async timing => {
      fixture(kind, 'live messages')
      const actions = useTranscripts.getState()
      const response = deferred<unknown>()

      setActiveRpc({
        call: vi.fn((method: string) =>
          method === `${kind}.respond`
            ? response.promise
            : Promise.resolve(method === 'hexbot.rooms.list' ? { rooms } : { events: [] })
        )
      } as never)

      const answer = () =>
        kind === 'approval'
          ? actions.respondApproval('sibling-live', 'pending', 'once')
          : actions.respondClarify('sibling-live', 'pending', 'Yes')

      const answering = timing === 'before refresh' ? answer() : undefined
      const before = useTranscripts.getState().bySession['sibling-live']!
      await useRooms.getState().refresh()
      const rebound = useTranscripts.getState().bySession['sibling-live']!
      expect(rebound.waitingRequests).toEqual(before.waitingRequests)
      expect(rebound.authorityRevision).toBeGreaterThan(before.authorityRevision)
      const currentAnswer = answering ?? answer()
      response.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
      await currentAnswer
      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.waitingRequests).toEqual([])
      expect(after.answeredWaiting).toEqual(
        timing === 'after refresh' ? { kind, requestId: 'pending' } : undefined
      )
    }
  )
})

it('retains exact clarification expiry across a room refresh and duplicate replay', async () => {
  fixture('clarify', 'empty')
  routeEvent({
    type: 'clarify.expire',
    session_id: 'sibling-live',
    payload: { request_id: 'pending' }
  } as never)
  await useRooms.getState().refresh()
  card('clarify')
  expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual([])
  expect(status()).toBe('working')
})

describe.each(['approval', 'clarify'] as const)('%s pending room on supervisor reconnect', kind => {
  it.each([
    ['empty', 'same daemon'],
    ['live messages', 'same daemon'],
    ['empty', 'new epoch'],
    ['live messages', 'new epoch'],
    ['empty', 'other origin'],
    ['live messages', 'other origin']
  ] as const)('preserves only current cards with %s history on %s', async (history, boundary) => {
    fixture(kind, history)
    card('approval', 'named-live', 'named-pending')
    const roster = { ...bot, status: 'needs_you' } as Bot
    const state = { epoch: 'epoch-A' }
    const sockets: TestSocket[] = []
    const requests: string[] = []

    class TestSocket extends EventTarget {
      readyState = 0
      constructor() {
        super()
        sockets.push(this)
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
          this.frame({
            jsonrpc: '2.0',
            method: 'event',
            params: { type: 'gateway.ready', payload: { replay_epoch: state.epoch } }
          })
        })
      }
      frame(value: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
      }
      send(data: string) {
        const { id, method } = JSON.parse(data)
        requests.push(method)

        const result =
          method === 'hexbot.bots.list'
            ? { bots: [roster] }
            : method === 'hexbot.rooms.list'
              ? { rooms }
              : method === 'hexbot.rooms.log'
                ? { events: [] }
                : method === 'hexbot.info'
                  ? { install_id: 'fixture', daemon_name: 'fixture' }
                  : {}

        queueMicrotask(() => this.frame({ jsonrpc: '2.0', id, result }))
      }
      close() {
        this.readyState = 3
        this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
      }
    }

    useConnection.setState({ epoch: 'epoch-A', daemon: null })

    const supervisor = new ConnectionSupervisor({
      bridge: () => null,
      fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
      socketFactory: () => new TestSocket() as unknown as WebSocket
    })

    try {
      await supervisor.start({ kind: 'local' })
      const before = useTranscripts.getState().bySession['sibling-live']!
      expect(before.waitingRequests).toEqual([
        expect.objectContaining({ kind, requestId: 'pending' })
      ])
      sockets[0]!.close()
      expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual(
        before.waitingRequests
      )

      if (boundary === 'new epoch') {
        state.epoch = 'epoch-B'
      }

      if (boundary === 'other origin') {
        await supervisor.start({
          kind: 'remote',
          host: 'other.test',
          port: 80,
          tls: false,
          deviceToken: ''
        })
      } else {
        await supervisor.retryNow()
      }

      expect(useConnection.getState().status).toBe('connected')
      const after = useTranscripts.getState().bySession['sibling-live']!
      expect(after.waitingRequests).toEqual(
        boundary === 'same daemon' ? before.waitingRequests : []
      )
      expect(after.answeredWaiting).toBeUndefined()
      expect(after.liveStatus).toBeUndefined()
      expect(after.retryResolved).toBeUndefined()
      expect(after.epoch === before.epoch).toBe(boundary !== 'new epoch')
      expect(requests.filter(method => method === 'hexbot.rooms.list')).toHaveLength(2)
      expect(requests).not.toContain('session.events.since')

      if (boundary === 'same daemon') {
        const sessions = useTranscripts.getState().bySession
        // The cached bot names the first room; the second pending room remains independently visible.
        expect(botStatusWithLive(bot, [], liveSectionsOf(sessions), sessions)).toBe('needs_you')
      }
    } finally {
      supervisor.stop()
    }
  })
})
