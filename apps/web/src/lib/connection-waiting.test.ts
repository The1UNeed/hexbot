import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useRooms } from '../stores/rooms'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from '../stores/sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from '../stores/transcripts'

import { ConnectionSupervisor } from './connection'
import type { Bot, Section } from './types'

async function fixture(kind: 'approval' | 'clarify') {
  const sections = ['first', 'second'].map(id => ({
    id,
    bot: 'owl',
    archived_at: null,
    live_session_id: `${id}-live`
  })) as Section[]

  const bot = (status: Bot['status'], session = 'first'): Bot =>
    ({
      name: 'owl',
      status,
      status_detail:
        status === 'idle' ? null : { section_id: session, session_id: `${session}-live` },
      sections_recent: sections
    }) as Bot

  const state = { epoch: 'epoch-A', roster: bot('working') }
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
          ? { bots: [state.roster] }
          : method === 'hexbot.rooms.list'
            ? { rooms: [] }
            : method === 'hexbot.info'
              ? { install_id: 'fixture', daemon_name: 'fixture' }
              : method === 'clarify.respond'
                ? { status: 'answered' }
                : method === 'approval.respond'
                  ? { resolved: true }
                  : method === 'hexbot.sections.delete'
                    ? { deleted: true }
                    : {}

      queueMicrotask(() => this.frame({ jsonrpc: '2.0', id, result }))
    }
    close() {
      this.readyState = 3
      this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
    }
  }

  useConnection.setState({ epoch: 'epoch-A', daemon: null })
  useSections.setState({
    byId: Object.fromEntries(sections.map(section => [section.id, section])),
    idsByBot: { owl: ['first', 'second'] },
    liveSessionId: { first: 'first-live', second: 'second-live' }
  })
  useRooms.setState({ liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  const actions = useTranscripts.getState()
  actions.open('first-live', 'first', [], undefined, 'owl')
  actions.open('second-live', 'second', [], undefined, 'owl')

  const supervisor = new ConnectionSupervisor({
    bridge: () => null,
    fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
    socketFactory: () => new TestSocket() as unknown as WebSocket
  })

  await supervisor.start({ kind: 'local' })
  actions.messageStart('first-live', true)
  actions.statusUpdate('first-live', { kind: 'working', text: '' })
  actions.approvalRequest('first-live', { request_id: 'old-answer' }, { notify: false })
  actions.resolveApproval('first-live', 'old-answer', 'once')

  if (kind === 'approval') {
    actions.approvalRequest('second-live', { request_id: 'pending' }, { notify: false })
  } else {
    actions.clarifyRequest(
      'second-live',
      { request_id: 'pending', question: 'Choose?' },
      { notify: false }
    )
  }

  const status = () => {
    const transcripts = useTranscripts.getState().bySession
    const live = liveSectionsOf(transcripts)

    return {
      section: sectionStatusOf(useBots.getState().byName.owl, 'second', live),
      bot: botStatusWithLive(useBots.getState().byName.owl!, sections, live, transcripts)
    }
  }

  return { actions, bot, requests, sections, sockets, state, status, supervisor }
}

afterEach(() => resetTranscriptEffects())

describe.each(['approval', 'clarify'] as const)('%s confirmation across reconnect', kind => {
  it.each([
    'same daemon',
    'new epoch',
    'aggregate idle',
    'matched working',
    'other origin'
  ] as const)('retains only current confirmed requests (%s)', async boundary => {
    const f = await fixture(kind)

    try {
      if (boundary === 'same daemon') {
        // The daemon projects one pending session even when both conversations need input.
        f.actions.approvalRequest('first-live', { request_id: 'first-pending' }, { notify: false })
        f.state.roster = f.bot('needs_you')
      }

      const confirmation = useTranscripts.getState().bySession['second-live']!.waitingRequests
      expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
      f.sockets[0]!.close()
      const disconnected = useTranscripts.getState().bySession
      expect(disconnected['first-live']?.answeredWaiting).toBeUndefined()
      expect(disconnected['first-live']?.liveStatus).toBeUndefined()
      expect(disconnected['first-live']?.retryResolved).toBeUndefined()
      expect(disconnected['second-live']?.waitingRequests).toEqual(confirmation)

      if (boundary === 'new epoch') {
        f.state.epoch = 'epoch-B'
      }

      if (boundary === 'aggregate idle') {
        f.state.roster = f.bot('idle')
      }

      if (boundary === 'matched working') {
        f.state.roster = f.bot('working', 'second')
      }

      if (boundary === 'other origin') {
        await f.supervisor.start({
          kind: 'remote',
          host: 'other.test',
          port: 80,
          tls: false,
          deviceToken: ''
        })
      } else {
        await f.supervisor.retryNow()
      }

      expect(f.requests).not.toContain('session.events.since')
      expect(useConnection.getState().status).toBe('connected')
      const pending = useTranscripts.getState().bySession['second-live']?.waitingRequests
      expect(pending?.length ?? 0).toBe(boundary === 'same daemon' ? 1 : 0)

      if (boundary === 'same daemon') {
        expect(useTranscripts.getState().bySession['first-live']?.waitingRequests).toEqual([
          expect.objectContaining({ requestId: 'first-pending' })
        ])
      }

      expect(f.status().section).toBe(
        boundary === 'same daemon'
          ? 'needs_you'
          : boundary === 'matched working'
            ? 'working'
            : 'idle'
      )
    } finally {
      f.supervisor.stop()
    }
  })

  it.each(['answered', 'completed'] as const)(
    'does not revive a %s retained card',
    async settlement => {
      const f = await fixture(kind)

      try {
        if (settlement === 'completed') {
          f.actions.statusUpdate('second-live', { kind: 'idle', text: '' })
        } else if (kind === 'approval') {
          f.actions.resolveApproval('second-live', 'pending', 'once')
        } else {
          f.actions.answerClarify('second-live', 'pending', 'pending', 'Yes')
        }

        f.sockets[0]!.close()
        await f.supervisor.retryNow()
        expect(useTranscripts.getState().bySession['second-live']?.waitingRequests).toEqual([])
        expect(useTranscripts.getState().bySession['second-live']?.answeredWaiting).toBeUndefined()
        expect(f.status().section).toBe('idle')
      } finally {
        f.supervisor.stop()
      }
    }
  )

  it('allows a new successful answer after reconnect without refreshing old confirmation revisions', async () => {
    const f = await fixture(kind)

    try {
      const before = useTranscripts.getState().bySession['second-live']!
      f.sockets[0]!.close()
      await f.supervisor.retryNow()
      const reconnected = useTranscripts.getState().bySession['second-live']!
      expect(reconnected.waitingRequests).toEqual(before.waitingRequests)
      expect(reconnected.authorityRevision).toBeGreaterThan(before.authorityRevision)

      if (kind === 'approval') {
        await f.actions.respondApproval('second-live', 'pending', 'once')
      } else {
        await f.actions.respondClarify('second-live', 'pending', 'Yes')
      }

      expect(useTranscripts.getState().bySession['second-live']?.waitingRequests).toEqual([])
      expect(f.status().section).toBe('working')
    } finally {
      f.supervisor.stop()
    }
  })
})

it('does not revive an expired clarification on same-daemon reconnect', async () => {
  const f = await fixture('clarify')

  try {
    f.actions.clarifyExpire('second-live', 'pending')
    f.sockets[0]!.close()
    await f.supervisor.retryNow()
    expect(useTranscripts.getState().bySession['second-live']?.waitingRequests).toEqual([])
    expect(f.status().section).toBe('idle')
  } finally {
    f.supervisor.stop()
  }
})

it('does not transfer private deletion status proof to another daemon origin', async () => {
  const f = await fixture('clarify')

  try {
    const stopped = {
      ...f.bot('stopped'),
      status_detail: {
        ...f.bot('stopped').status_detail,
        action: { kind: 'retry' }
      }
    } as Bot

    useBots.setState({ byName: { owl: stopped } })
    await useSections.getState().remove('first')
    expect(sectionStatusOf(stopped, 'first')).toBe('idle')
    f.state.roster = stopped
    await f.supervisor.start({
      kind: 'remote',
      host: 'other.test',
      port: 80,
      tls: false,
      deviceToken: ''
    })
    expect(useConnection.getState().epoch).toBe('epoch-A')
    expect(sectionStatusOf(useBots.getState().byName.owl, 'first')).toBe('stopped')
  } finally {
    f.supervisor.stop()
  }
})
