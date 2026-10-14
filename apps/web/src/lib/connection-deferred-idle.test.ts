import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { ConnectionSupervisor } from './connection'
import type { Bot, Section } from './types'

async function fixture(kind: 'approval' | 'clarify', archived = false) {
  const section = {
    id: 'target',
    bot: 'owl',
    archived_at: archived ? 1 : null,
    live_session_id: 'target-live'
  } as Section

  const bot = (status: Bot['status'], session = 'target'): Bot =>
    ({
      name: 'owl',
      status,
      status_detail:
        status === 'idle' ? null : { section_id: session, session_id: `${session}-live` }
    }) as Bot

  const state = {
    epoch: 'epoch-A',
    roster: bot(archived ? 'idle' : 'needs_you'),
    sections: [section],
    holdSections: false,
    failBots: false,
    unauthorized: false
  }

  const sockets: TestSocket[] = []
  const requests: string[] = []

  class TestSocket extends EventTarget {
    readyState = 0
    heldSections: number[] = []

    constructor() {
      super()
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatchEvent(new Event('open'))
        this.event('gateway.ready', { replay_epoch: state.epoch })
      })
    }

    frame(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
    }

    event(type: string, payload: Record<string, unknown> = {}, sessionId = 'target-live') {
      this.frame({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: sessionId, payload }
      })
    }

    reply(id: number, result: unknown) {
      this.frame({ jsonrpc: '2.0', id, result })
    }

    finishSections() {
      for (const id of this.heldSections.splice(0)) {
        this.reply(id, { sections: state.sections })
      }
    }

    send(data: string) {
      const { id, method } = JSON.parse(data)
      requests.push(method)

      if (method === 'hexbot.sections.list' && state.holdSections) {
        this.heldSections.push(id)

        return
      }

      const failed = state.failBots && ['hexbot.bots.list', 'hexbot.bots.get'].includes(method)

      const result =
        method === 'hexbot.bots.list'
          ? { bots: [state.roster] }
          : method === 'hexbot.bots.get'
            ? { bot: state.roster }
            : method === 'hexbot.sections.list'
              ? { sections: state.sections }
              : method === 'hexbot.sections.unarchive'
                ? { section: { ...section, archived_at: null } }
                : method === 'hexbot.sections.delete'
                  ? { deleted: true }
                  : method === 'hexbot.rooms.list'
                    ? { rooms: [] }
                    : method === 'hexbot.info'
                      ? { install_id: 'fixture', daemon_name: 'fixture' }
                      : {}

      queueMicrotask(() =>
        this.frame({
          jsonrpc: '2.0',
          id,
          ...(failed ? { error: { code: -32000, message: 'Read unavailable' } } : { result })
        })
      )
    }

    close(code = 1006) {
      this.readyState = 3
      this.dispatchEvent(new CloseEvent('close', { code }))
    }
  }

  clearDeletedSections()
  useConnection.setState({ epoch: 'epoch-A', daemon: null })
  useBots.setState({ byName: {}, order: [], error: null })
  useSections.setState({
    byId: { target: section },
    idsByBot: { owl: ['target'] },
    liveSessionId: { target: 'target-live' }
  })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  useTranscripts.getState().open('target-live', section.id, [], undefined, 'owl')

  const supervisor = new ConnectionSupervisor({
    bridge: () => null,
    fetch: async () =>
      new Response(JSON.stringify({ ticket: 'fixture' }), {
        status: state.unauthorized ? 401 : 200
      }),
    socketFactory: () => new TestSocket() as unknown as WebSocket
  })

  await supervisor.start({ kind: 'local' })

  const confirm = (requestId = 'pending', sessionId = 'target-live', sectionId = 'target') =>
    sockets
      .at(-1)!
      .event(
        `${kind}.request`,
        { request_id: requestId, question: 'Choose?', bot: 'owl', section_id: sectionId },
        sessionId
      )

  confirm()

  const transcript = (id = 'target-live') => useTranscripts.getState().bySession[id]

  const status = () => {
    const transcripts = useTranscripts.getState().bySession
    const live = liveSectionsOf(transcripts)
    const owl = useBots.getState().byName.owl!

    return {
      section: sectionStatusOf(owl, 'target', live),
      bot: botStatusWithLive(owl, Object.values(useSections.getState().byId), live, transcripts)
    }
  }

  const deferIdle = async () => {
    state.roster = bot('idle')
    state.holdSections = true
    // The production router starts both metadata and aggregate reads for this event.
    sockets.at(-1)!.event('hexbot.sections.changed', { id: 'target', bot: 'owl' })
    await vi.waitFor(() => {
      expect(sockets.at(-1)!.heldSections).toHaveLength(1)
      expect(useBots.getState().byName.owl?.status).toBe('idle')
      expect(transcript()?.liveStatus).toBe('idle')
    })
  }

  const readIdle = async () => {
    state.roster = bot('idle')
    await useBots.getState().refresh()
  }

  return {
    bot,
    confirm,
    deferIdle,
    readIdle,
    requests,
    section,
    sockets,
    state,
    status,
    supervisor,
    transcript
  }
}

afterEach(() => resetTranscriptEffects())

describe.each(['approval', 'clarify'] as const)('%s deferred Idle reconnect', kind => {
  it.each([true, false])(
    'clears accepted active Idle when reconnect bot read fails=%s',
    async fails => {
      const f = await fixture(kind)

      try {
        await f.deferIdle()
        const revision = f.transcript()!.authorityRevision
        expect(f.transcript()?.waitingRequests).toHaveLength(1)
        f.sockets[0]!.close()
        // The real gateway notifies the supervisor before rejecting its pending RPCs.
        expect(f.transcript()!.authorityRevision).toBeGreaterThan(revision)
        expect(f.transcript()?.waitingRequests).toHaveLength(1)
        await vi.waitFor(() => expect(f.transcript()?.waitingRequests).toEqual([]))
        f.state.failBots = fails
        await f.supervisor.retryNow()
        expect(useConnection.getState().status).toBe('connected')
        expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
        expect(f.requests).not.toContain('session.events.since')
      } finally {
        f.supervisor.stop()
      }
    }
  )

  it('applies Idle through the same drop without a concurrent metadata read', async () => {
    const f = await fixture(kind)

    try {
      await f.readIdle()
      f.sockets[0]!.close()
      f.state.failBots = true
      await f.supervisor.retryNow()
      expect(f.transcript()?.waitingRequests).toEqual([])
      expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    } finally {
      f.supervisor.stop()
    }
  })

  it.each(['new-request', 'pending'])(
    'keeps confirmation of %s received after Idle through the real drop and failed reconnect read',
    async requestId => {
      const f = await fixture(kind)

      try {
        await f.deferIdle()
        f.confirm(requestId)
        const newer = f.transcript()!.waitingRequests!.find(item => item.requestId === requestId)!
        f.sockets[0]!.close()
        await vi.waitFor(() => expect(f.transcript()?.waitingRequests).toEqual([newer]))
        f.state.failBots = true
        await f.supervisor.retryNow()
        expect(f.transcript()?.waitingRequests).toEqual([newer])
        expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
      } finally {
        f.supervisor.stop()
      }
    }
  )

  it('keeps a known archived wait through the drop and a failed restore read', async () => {
    const f = await fixture(kind, true)

    try {
      await f.deferIdle()
      f.sockets[0]!.close()
      f.state.failBots = true
      await f.supervisor.retryNow()
      expect(f.transcript()?.waitingRequests).toHaveLength(1)
      f.state.holdSections = false
      await useSections.getState().unarchive('target')
      expect(f.transcript()?.waitingRequests).toHaveLength(1)
      expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
    } finally {
      f.supervisor.stop()
    }
  })

  it.each([
    'working',
    'stream',
    'complete',
    'error',
    'retry',
    'new card',
    'replayed card'
  ] as const)('preserves %s progress after the accepted read', async progress => {
    const f = await fixture(kind)

    try {
      await f.deferIdle()
      const socket = f.sockets[0]!

      if (progress === 'working') {
        socket.event('status.update', { kind: 'working', text: 'Working' })
      } else if (progress === 'stream') {
        socket.event('message.start')
        socket.event('message.delta', { text: 'New reply' })
      } else if (progress === 'complete') {
        socket.event('message.complete', { text: 'Done' })
      } else if (progress === 'error') {
        socket.event('error', { message: 'Failed again' })
      } else if (progress === 'retry') {
        socket.event('message.start', { retry_resolved: true })
        socket.event('status.update', { kind: 'working', text: 'Working' })
      } else {
        f.confirm(progress === 'new card' ? 'new-request' : 'pending')
      }

      const before = f.transcript()!
      socket.finishSections()
      await vi.waitFor(() => {
        if (progress === 'new card' || progress === 'replayed card') {
          expect(f.transcript()?.waitingRequests).toEqual([
            expect.objectContaining({
              requestId: progress === 'new card' ? 'new-request' : 'pending'
            })
          ])
        } else {
          expect(f.transcript()?.waitingRequests).toEqual([])
        }
      })
      expect(f.transcript()).toEqual({
        ...before,
        waitingRequests:
          progress === 'new card' || progress === 'replayed card'
            ? before.waitingRequests?.filter(
                item => item.requestId === (progress === 'new card' ? 'new-request' : 'pending')
              )
            : []
      })
      expect(f.status().section).toBe(
        progress === 'new card' || progress === 'replayed card'
          ? 'needs_you'
          : progress === 'working' || progress === 'stream' || progress === 'retry'
            ? 'working'
            : 'idle'
      )
    } finally {
      f.supervisor.stop()
    }
  })

  it.each(['full', 'scoped'] as const)(
    'keeps newer same-session %s NeedsYou authority',
    async scope => {
      const f = await fixture(kind)

      try {
        await f.deferIdle()
        f.state.roster = f.bot('needs_you')
        await (scope === 'full'
          ? useBots.getState().refresh()
          : useBots.getState().refreshOne('owl'))
        f.sockets[0]!.finishSections()
        f.sockets[0]!.close()
        f.state.failBots = true
        await f.supervisor.retryNow()
        expect(f.transcript()?.waitingRequests).toHaveLength(1)
        expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
      } finally {
        f.supervisor.stop()
      }
    }
  )

  it.each(['private', 'room'] as const)(
    'prunes only the named %s scope while clearing a pending sibling',
    async scope => {
      const f = await fixture(kind)

      try {
        useTranscripts
          .getState()
          .open('sibling-live', scope === 'room' ? 'room:r' : 'sibling', [], undefined, 'owl')
        f.confirm('sibling-pending', 'sibling-live', scope === 'room' ? 'room:r' : 'sibling')
        await f.deferIdle()
        f.state.roster = f.bot('needs_you')
        await useBots.getState().refresh()
        f.sockets[0]!.close()
        await vi.waitFor(() => expect(f.transcript('sibling-live')?.waitingRequests).toEqual([]))
        f.state.failBots = true
        await f.supervisor.retryNow()
        expect(f.transcript()?.waitingRequests).toHaveLength(1)
        expect(f.status().section).toBe('needs_you')
      } finally {
        f.supervisor.stop()
      }
    }
  )

  it.each([
    'revocation',
    'unauthorized handshake',
    'new epoch',
    'other origin',
    'deleted section'
  ] as const)('does not transfer pending cleanup across %s', async boundary => {
    const f = await fixture(kind)

    try {
      await f.deferIdle()
      f.state.failBots = true

      if (boundary === 'deleted section') {
        f.sockets[0]!.event('hexbot.sections.changed', { id: 'target', bot: 'owl', deleted: true })
        expect(f.transcript()).toBeUndefined()
      } else {
        f.sockets[0]!.close(boundary === 'revocation' ? 4403 : 1006)

        if (boundary === 'unauthorized handshake') {
          f.state.unauthorized = true
        }

        if (boundary === 'new epoch') {
          f.state.epoch = 'epoch-B'
        }

        if (boundary === 'other origin') {
          await f.supervisor.start({
            kind: 'remote',
            host: 'other.test',
            port: 80,
            tls: false,
            deviceToken: ''
          })
        } else if (boundary !== 'revocation') {
          await f.supervisor.retryNow()
        }
      }

      if (boundary === 'revocation' || boundary === 'unauthorized handshake') {
        expect(useConnection.getState().status).toBe('unauthorized')
        f.state.unauthorized = false
        await f.supervisor.start({ kind: 'local' })
      }

      if (boundary === 'deleted section') {
        f.sockets[0]!.finishSections()
        await vi.waitFor(() => expect(useSections.getState().loading).toBe(false))
        expect(f.transcript()).toBeUndefined()
      } else {
        useTranscripts.getState().open('target-live', 'target', [], undefined, 'owl')
        f.confirm('fresh')
        f.sockets[0]!.finishSections()
        expect(f.transcript()?.waitingRequests).toEqual([
          expect.objectContaining({ requestId: 'fresh' })
        ])
        expect(f.status().section).toBe('needs_you')
      }
    } finally {
      f.supervisor.stop()
    }
  })
})

it('preserves a partial clarification confirmation newer than the accepted Idle', async () => {
  const f = await fixture('clarify')

  try {
    await f.deferIdle()
    f.sockets[0]!.event('clarify.resolved', {
      request_id: 'pending',
      answers: { one: 'Yes' },
      status: 'waiting',
      bot: 'owl',
      section_id: 'target'
    })
    const before = f.transcript()!
    f.sockets[0]!.finishSections()
    await vi.waitFor(() => expect(useSections.getState().loading).toBe(false))
    expect(f.transcript()?.waitingRequests).toEqual(before.waitingRequests)
    expect(f.transcript()?.clarifies).toEqual(before.clarifies)
  } finally {
    f.supervisor.stop()
  }
})
