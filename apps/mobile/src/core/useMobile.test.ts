import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import type { Bot, Room, SavedDaemon, Section } from './types'
import { chatActivityLabel } from './tools'

type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  clients: [] as { emit: (event: GatewayEvent) => void }[],
  handler: (async () => ({})) as Handler
}))
// Deterministic hooks keep the real consumer's refs, callbacks and functional state updates.
vi.mock('react', () => ({
  useRef<T>(value: T) {
    const index = hooks.index++
    return (hooks.slots[index] ??= { current: value }) as { current: T }
  },
  useState<T>(value: T | (() => T)) {
    const index = hooks.index++
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof value === 'function' ? (value as () => T)() : value
    return [
      hooks.slots[index],
      (next: T | ((previous: T) => T)) => {
        hooks.slots[index] =
          typeof next === 'function' ? (next as (previous: T) => T)(hooks.slots[index] as T) : next
      }
    ]
  },
  useCallback<T>(callback: T) {
    return callback
  },
  useEffect() {}
}))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }))
vi.mock('./storage', () => ({
  activeDaemonId: async () => null,
  forgetDaemon: async () => {},
  loadDaemons: async () => [],
  loadToken: async () => 'token',
  saveDaemon: async () => {},
  selectDaemon: async () => {}
}))
vi.mock('./transport', () => ({ pair: async () => ({}) }))
vi.mock('./session', () => ({
  MobileSession: class {
    client = {
      connectionState: 'open',
      request: (method: string, params: Record<string, unknown>) => hooks.handler(method, params)
    }
    constructor(
      _daemon: unknown,
      _token: unknown,
      _state: unknown,
      _ready: unknown,
      public emit: (event: GatewayEvent) => void
    ) {
      hooks.clients.push(this)
    }
    async connect() {}
    stop() {
      this.client.connectionState = 'closed'
    }
  }
}))
import { useMobile } from './useMobile'

const render = () => {
  hooks.index = 0
  // This harness invokes the hook directly with deterministic mocked React hooks.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useMobile()
}
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const bot = { name: 'alpha', status: 'needs_you', status_detail: { session_id: 's1' } } as Bot
const section = (id = 'section', live_session_id = 's1') =>
  ({ id, bot: 'alpha', live_session_id }) as Section
const daemon: SavedDaemon = {
  id: 'daemon',
  name: 'Local',
  origin: 'http://localhost',
  kind: 'local',
  deviceId: 'device'
}
const wire = (type: string, payload: Record<string, unknown>, session_id = 's1'): GatewayEvent => ({
  type,
  session_id,
  payload
})
const approval = wire('approval.request', {
  request_id: 'old',
  choices: ['once', 'session', 'deny']
})
const resolved = wire('approval.resolved', { request_id: 'old', choice: 'once' })
const status = () => {
  const route = render().route
  return route?.kind === 'section' ? route.bot.status : undefined
}

beforeEach(() => {
  hooks.slots = []
  hooks.index = 0
  hooks.clients = []
  hooks.handler = async (method, params) => {
    if (method === 'hexbot.sections.open')
      return {
        section: section(String(params.id), params.id === 'section' ? 's1' : 's2'),
        messages: []
      }
    if (method === 'session.status') return { status: 'working' }
    if (method === 'hexbot.bots.list') return { bots: [bot] }
    if (method === 'hexbot.rooms.list') return { rooms: [] }
    if (method === 'hexbot.sections.list') return { sections: [section()] }
    return {}
  }
})
async function start() {
  await render().activate(daemon, 'token')
  await render().openSection(bot, section())
  hooks.clients[0].emit(approval)
  return render()
}

describe('mobile settlement consumer', () => {
  it('keeps a room answer through a failed roster read and automatic retry while its sibling still waits for a human', async () => {
    const room: Room = {
      id: 'room',
      name: 'Planning',
      owner_id: 'owner',
      main_bot: 'alpha',
      approval_mode: null,
      limits: {},
      archived_at: null,
      created_at: 0,
      updated_at: 0,
      last_activity_at: 0,
      members: [],
      turns: [
        { bot: 'alpha', live_session_id: 's1' },
        { bot: 'beta', live_session_id: 's2' }
      ]
    }
    const beta = { ...bot, name: 'beta', status_detail: { session_id: 's2' } } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [bot, beta] }
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'approval.respond') return { resolved: true, choice: 'once' }
      return original(method, params)
    }
    await render().activate(daemon, 'token')
    await render().refresh()
    await render().openRoom(room)
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(wire('clarify.request', { request_id: 'old', question: 'When?' }, 's2'))
    await render().approval('old', 'once', 's1')
    const current = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return current(method, params)
    }
    await expect(render().refresh()).rejects.toThrow('Roster unavailable')
    hooks.clients[0].emit(wire('thinking.delta', { text: 'Retrying the model request' }))
    hooks.clients[0].emit(
      wire('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    hooks.clients[0].emit(wire('thinking.delta', { text: 'Checking the file' }))
    hooks.clients[0].emit(wire('message.delta', { text: 'Checking.' }))
    hooks.clients[0].emit(wire('message.interim', { text: 'Checking.', already_streamed: true }))
    hooks.clients[0].emit(wire('tool.start', { tool_id: 'read', name: 'read_file' }))
    expect(render().bots.find(b => b.name === 'alpha')?.status).toBe('working')
    expect(render().bots.find(b => b.name === 'beta')?.status).toBe('needs_you')
    expect(render().chat.questions.map(q => q.sessionId)).toEqual(['s2'])
    expect(chatActivityLabel(render().chat)).toBe('Waiting')
  })

  it('keeps the latest successful roster cutoff when buffered history is restored later', async () => {
    await render().activate(daemon, 'token')
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'session.status' ? reply.promise : original(method, params)
    const opening = render().openSection(bot, section())
    // The open RPC has returned, and session.status is still held.
    await Promise.resolve()
    await Promise.resolve()
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(resolved)
    await render().refresh()
    reply.resolve({ status: 'working' })
    await opening
    expect(status()).toBe('needs_you')
    expect(render().chat.approvals).toEqual([])
  })

  it('does not apply an old canonical callback to a newly opened section with the same request ID', async () => {
    const response = deferred()
    const app = await start()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'approval.respond' ? response.promise : original(method, params)
    const pending = app.approval('old', 'once', 's1')
    await render().openSection(bot, section('other', 's2'))
    hooks.clients[0].emit(wire('approval.request', { request_id: 'old', choices: ['once'] }, 's2'))
    response.resolve({ resolved: true, choice: 'once' })
    await pending
    expect(render().chat.approvals.map(card => card.sessionId)).toEqual(['s2'])
  })

  it('rejects a canonical callback from a daemon that is no longer selected', async () => {
    const response = deferred()
    const app = await start()
    hooks.handler = () => response.promise
    const pending = app.approval('old', 'once', 's1')
    await render().activate({ ...daemon, id: 'other' }, 'token')
    response.resolve({ resolved: true, choice: 'once' })
    await expect(pending).rejects.toThrow('selected daemon changed')
    expect(render().chat.approvals).toEqual([])
  })

  it('retires old proof on a fresh roster despite duplicate wire settlement during its read', async () => {
    await start()
    hooks.clients[0].emit(resolved)
    expect(status()).toBe('working')
    const roster = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.bots.list' ? roster.promise : original(method, params)
    const reading = render().refresh()
    hooks.clients[0].emit(resolved)
    roster.resolve({ bots: [bot] })
    await reading
    expect(status()).toBe('needs_you')
  })

  it('does not renew old proof with the canonical RPC callback following its broadcast', async () => {
    const app = await start()
    const response = deferred()
    const roster = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'approval.respond'
        ? response.promise
        : method === 'hexbot.bots.list'
          ? roster.promise
          : original(method, params)
    const pending = app.approval('old', 'once', 's1')
    hooks.clients[0].emit(resolved)
    const reading = render().refresh()
    response.resolve({ resolved: true, choice: 'once' })
    await pending
    roster.resolve({ bots: [bot] })
    await reading
    expect(status()).toBe('needs_you')
  })

  it('keeps exact last-card evidence accepted during a stale roster read', async () => {
    await start()
    const roster = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.bots.list' ? roster.promise : original(method, params)
    const reading = render().refresh()
    hooks.clients[0].emit(resolved)
    roster.resolve({ bots: [bot] })
    await reading
    expect(status()).toBe('working')
    expect(render().chat).toMatchObject({ approvals: [], busy: true, waiting: false })
  })

  it('settles locally with canonical choices even when the roster refresh fails', async () => {
    const app = await start()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'approval.respond') return { resolved: true, choice: 'session' }
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    await app.approval('old', 'always', 's1')
    await expect(render().refresh()).rejects.toThrow('Roster unavailable')
    expect(status()).toBe('working')
    expect(render().chat.approvals).toEqual([])
    expect(Object.values(render().chat.settlements)[0].choice).toBe('session')
    hooks.clients[0].emit(wire('thinking.delta', { text: 'Retrying the model request' }))
    hooks.clients[0].emit(
      wire('status.update', { kind: 'waiting', text: 'Retrying the model request' })
    )
    expect(render().chat).toMatchObject({ waiting: true, resumedWaiting: true })
    expect(status()).toBe('working')
    hooks.clients[0].emit(wire('thinking.delta', { text: 'Checking the file' }))
    hooks.clients[0].emit(wire('message.delta', { text: 'Checking.' }))
    hooks.clients[0].emit(wire('message.interim', { text: 'Checking.', already_streamed: true }))
    hooks.clients[0].emit(wire('tool.start', { tool_id: 'read', name: 'read_file' }))
    expect(render().chat).toMatchObject({
      waiting: true,
      streaming: '',
      activity: 'Using read_file'
    })
    expect(status()).toBe('working')
  })

  it('uses canonical local clarification batches while preserving sibling approval cards', async () => {
    await start()
    hooks.clients[0].emit(
      wire('clarify.request', {
        request_id: 'batch',
        questions: [
          { qid: 'first', question: 'When?' },
          { qid: 'first', question: 'When again?' },
          { qid: 'second', question: 'Where?' }
        ]
      })
    )
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'clarify.respond')
        return params.question_id === 'first'
          ? { status: 'waiting', answers: { first: 'Canonical' }, remaining: ['second'] }
          : { status: 'answered', answers: { first: 'Canonical', second: 'Here' } }
      return original(method, params)
    }
    await render().answer('batch', 'first', 'Typed', 's1')
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['second'])
    await render().answer('batch', 'second', 'Guess', 's1')
    expect(render().chat.questions).toEqual([])
    expect(render().chat.approvals).toHaveLength(1)
    expect(render().chat.waiting).toBe(true)
    expect(Object.values(render().chat.settlements)[0].answers).toEqual({
      first: 'Canonical',
      second: 'Here'
    })
  })
})
