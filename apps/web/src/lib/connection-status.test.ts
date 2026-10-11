import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from '../stores/sections'
import { useTranscripts } from '../stores/transcripts'

import { ConnectionSupervisor } from './connection'
import type { Bot, Section } from './types'

it.each(['quiet', 'streaming', 'answered'])(
  'preserves daemon Waiting after a card was missed offline (%s)',
  async state => {
    const section = {
      id: 's1',
      bot: 'owl',
      archived_at: null,
      live_session_id: 'live-1'
    } as Section

    let waiting = false

    const bot = () =>
      ({
        name: 'owl',
        status: waiting ? 'needs_you' : 'idle',
        status_detail: waiting ? { section_id: 's1' } : null,
        sections_recent: [section]
      }) as Bot

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
            params: { type: 'gateway.ready', payload: { replay_epoch: 'epoch-A' } }
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
            ? { bots: [bot()] }
            : method === 'hexbot.rooms.list'
              ? { rooms: [] }
              : method === 'hexbot.info'
                ? { install_id: 'fixture', daemon_name: 'fixture' }
                : method === 'session.events.since'
                  ? {
                      events: [
                        {
                          type: 'clarify.request',
                          session_id: 'live-1',
                          seq: 3,
                          payload: { request_id: 'new-question', question: 'Choose?' }
                        }
                      ]
                    }
                  : {}

        queueMicrotask(() => this.frame({ jsonrpc: '2.0', id, result }))
      }
      close() {
        this.readyState = 3
        this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
      }
    }
    useConnection.setState({ epoch: 'epoch-A' })
    useSections.setState({
      byId: { s1: section },
      idsByBot: { owl: ['s1'] },
      liveSessionId: { s1: 'live-1' }
    })
    useTranscripts.getState().dropAll()
    useTranscripts.getState().open('live-1', 's1', [])

    const supervisor = new ConnectionSupervisor({
      bridge: () => null,
      fetch: async () => new Response(JSON.stringify({ ticket: 'fixture' }), { status: 200 }),
      socketFactory: () => new TestSocket() as unknown as WebSocket
    })

    try {
      await supervisor.start({ kind: 'local' })

      if (state === 'streaming') {
        sockets[0]!.frame({
          jsonrpc: '2.0',
          method: 'event',
          params: { type: 'message.start', session_id: 'live-1', seq: 1, payload: {} }
        })
      }

      if (state === 'answered') {
        useTranscripts
          .getState()
          .approvalRequest('live-1', { request_id: 'old-answer' }, { notify: false })
        useTranscripts.getState().resolveApproval('live-1', 'old-answer', 'once')
        expect(liveSectionsOf(useTranscripts.getState().bySession).s1).toBe('answered')
      }

      sockets[0]!.close()
      expect(useTranscripts.getState().bySession['live-1']?.answeredWaiting).toBeUndefined()
      waiting = true // The daemon asks while this client is disconnected.
      await supervisor.retryNow()
      expect(sockets).toHaveLength(2)
      expect(useConnection.getState().status).toBe('connected')
      expect(useBots.getState().byName.owl?.status).toBe('needs_you')
      expect(useTranscripts.getState().bySession['live-1']!.clarifies).toEqual([])
      expect(requests).not.toContain('session.events.since')
      expect(useSections.getState().liveSessionId.s1).toBe('live-1')
      const live = liveSectionsOf(useTranscripts.getState().bySession)
      const currentBot = useBots.getState().byName.owl!
      expect({
        section: sectionStatusOf(currentBot, 's1', live),
        bot: botStatusWithLive(currentBot, [section], live)
      }).toEqual({ section: 'needs_you', bot: 'needs_you' })
    } finally {
      supervisor.stop()
    }
  }
)
