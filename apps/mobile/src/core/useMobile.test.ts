import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayEvent } from '@hermes/shared'
import type { Bot, Room, SavedDaemon, Section } from './types'
import { chatActivityLabel } from './tools'

type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  clients: [] as { emit: (event: GatewayEvent) => void; ready: () => Promise<void> }[],
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
      public ready: () => Promise<void>,
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
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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

/** Each refresh holds its roster and gives every other snapshot a distinct value. */
function holdRefreshes() {
  const reads: ReturnType<typeof deferred>[] = []
  const original = hooks.handler
  hooks.handler = async (method, params) => {
    if (method === 'hexbot.bots.list') {
      const response = deferred()
      reads.push(response)
      return response.promise
    }
    const index = reads.length - 1
    if (method === 'hexbot.rooms.list') return { rooms: [{ id: `room-${index}` }] }
    if (method === 'hexbot.sections.list')
      return { sections: [{ ...section(), title: `Snapshot ${index}` }] }
    if (method === 'hexbot.info') return { version: `snapshot-${index}` }
    if (method === 'hexbot.settings.get') return { approval_mode: index === 0 ? 'smart' : 'off' }
    if (method === 'hexbot.users.me') return { id: `user-${index}` }
    return original(method, params)
  }
  return reads
}

const namedWait = {
  ...bot,
  owner_id: 'owner',
  status_detail: { ...bot.status_detail!, section_id: 'section', room_id: null }
} as Bot
const namedResolved = wire('approval.resolved', {
  request_id: 'old',
  choice: 'once',
  bot: 'alpha',
  section_id: 'section'
})
const flush = async () => {
  for (let count = 0; count < 8; count++) await Promise.resolve()
}
async function unopened(cached = namedWait) {
  const original = hooks.handler
  hooks.handler = async (method, params) => {
    if (method === 'hexbot.bots.list') return { bots: [cached] }
    if (method === 'hexbot.bots.get') return { bot: { ...cached, status: 'working' } }
    return original(method, params)
  }
  await render().activate(daemon, 'token')
  await render().refresh()
}
function holdBotGets() {
  const reads: ReturnType<typeof deferred>[] = []
  const original = hooks.handler
  hooks.handler = (method, params) => {
    if (method !== 'hexbot.bots.get') return original(method, params)
    const read = deferred()
    reads.push(read)
    return read.promise
  }
  return reads
}

describe('mobile unopened settlement consumer', () => {
  it('verifies a canonical private answer without opening a route when the roster read fails', async () => {
    await unopened()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    hooks.clients[0].emit(namedResolved)
    await flush()
    await expect(render().refresh()).rejects.toThrow('Roster unavailable')
    expect(render().route).toBeNull()
    expect(render().bots[0].status).toBe('working')
  })

  it('updates the same bot while another private conversation remains open', async () => {
    await unopened()
    await render().openSection(namedWait, section('other', 's2'))
    hooks.clients[0].emit(namedResolved)
    await flush()
    expect(render().bots[0].status).toBe('working')
    expect(status()).toBe('working')
    expect(render().chat.approvals).toEqual([])
  })

  it('verifies a room answer while no room is open', async () => {
    const cached = {
      ...namedWait,
      status_detail: { ...namedWait.status_detail!, room_id: 'room', section_id: null }
    } as Bot
    await unopened(cached)
    hooks.clients[0].emit({
      ...namedResolved,
      payload: {
        ...(namedResolved.payload as Record<string, unknown>),
        section_id: 'room-stored-session'
      }
    })
    await flush()
    expect(render().bots[0].status).toBe('working')
  })

  it('keeps unknown answers conservative when verification fails despite the routine Working event', async () => {
    await unopened()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get') throw new Error('Bot unavailable')
      return original(method, params)
    }
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }))
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['private', 'room'])(
    'preserves the verified %s sibling wait that was never observed as a card',
    async kind => {
      await unopened()
      const sibling = {
        ...namedWait,
        status_detail: {
          ...namedWait.status_detail!,
          session_id: 'unseen',
          section_id: kind === 'private' ? 'another' : null,
          room_id: kind === 'room' ? 'another-room' : null
        }
      } as Bot
      const reads = holdBotGets()
      hooks.clients[0].emit(namedResolved)
      hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }))
      reads[0].resolve({ bot: sibling })
      await flush()
      expect(render().bots[0]).toMatchObject({
        status: 'needs_you',
        status_detail: sibling.status_detail
      })
    }
  )

  it('keeps partial clarification waiting according to the authoritative bot read', async () => {
    await unopened()
    const reads = holdBotGets()
    hooks.clients[0].emit(
      wire('clarify.resolved', {
        bot: 'alpha',
        section_id: 'section',
        request_id: 'batch',
        status: 'waiting',
        answers: { first: 'Yes' },
        remaining: ['second']
      })
    )
    reads[0].resolve({ bot: namedWait })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['idle', 'stopped'])('preserves verified %s priority after an answer', async status => {
    await unopened()
    const reads = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    reads[0].resolve({ bot: { ...namedWait, status } })
    await flush()
    expect(render().bots[0].status).toBe(status)
  })

  it.each([
    wire('approval.request', {
      bot: 'alpha',
      section_id: 'section',
      request_id: 'new',
      choices: ['once']
    }),
    wire('clarify.request', {
      bot: 'alpha',
      section_id: 'section',
      request_id: 'new',
      question: 'When?'
    }),
    wire('message.start', {}),
    wire('message.complete', { text: 'Done' }),
    wire('error', { message: 'Failed' }),
    { type: 'hexbot.sections.changed', payload: { id: 'section' } } as GatewayEvent
  ])('rejects a Working read superseded by $type', async event => {
    await unopened()
    const reads = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(event)
    reads[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('rejects a room status read after the actual rooms.changed id payload', async () => {
    await unopened({
      ...namedWait,
      status_detail: { ...namedWait.status_detail!, room_id: 'room', section_id: null }
    } as Bot)
    const reads = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit({ type: 'hexbot.rooms.changed', payload: { id: 'room' } })
    reads[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('lets a later successful list defeat an older get while preserving the old get on list failure', async () => {
    await unopened()
    const gets = holdBotGets()
    const lists = holdRefreshes()
    hooks.clients[0].emit(namedResolved)
    const newer = render().refresh()
    lists[0].resolve({ bots: [{ ...namedWait, display_name: 'Fresh' }] })
    await newer
    gets[0].resolve({ bot: { ...namedWait, status: 'working', display_name: 'Stale' } })
    await flush()
    expect(render().bots[0]).toMatchObject({ status: 'needs_you', display_name: 'Fresh' })
    hooks.clients[0].emit(namedResolved)
    const failed = render().refresh()
    const rejected = expect(failed).rejects.toThrow('Unavailable')
    lists[1].reject(new Error('Unavailable'))
    await rejected
    gets[1].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0]).toMatchObject({ status: 'working', display_name: 'Fresh' })
  })

  it('keeps later verified status when an older list refreshes profiles and rebinds the open route', async () => {
    await unopened()
    await render().openSection(namedWait, section())
    const lists = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(namedResolved)
    await flush()
    lists[0].resolve({ bots: [{ ...namedWait, display_name: 'Updated profile' }] })
    await older
    expect(render().bots[0]).toMatchObject({ status: 'working', display_name: 'Updated profile' })
    expect(status()).toBe('working')
    const route = render().route
    expect(route?.kind === 'section' && route.section.title).toBe('Snapshot 0')
  })

  it('coalesces duplicate settlements and retains useful authority if the queued newer read fails', async () => {
    await unopened()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(namedResolved)
    expect(gets).toHaveLength(1)
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(gets).toHaveLength(2)
    gets[1].resolve({ bot: namedWait })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(namedResolved)
    expect(gets).toHaveLength(3)
    gets[2].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    gets[3].reject(new Error('Unavailable'))
    await flush()
    expect(render().bots[0].status).toBe('working')
  })

  it.each(['same', 'changed'])('accepts a held get only across a %s daemon epoch', async kind => {
    await unopened()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'one' } })
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit({
      type: 'gateway.ready',
      payload: { replay_epoch: kind === 'same' ? 'one' : 'two' }
    })
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe(kind === 'same' ? 'working' : 'needs_you')
  })

  it('does not let an old daemon read remove a new daemon read with a reused request counter', async () => {
    await unopened()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    await render().activate({ ...daemon, id: 'other' }, 'token')
    await render().refresh()
    hooks.clients[1].emit(namedResolved)
    gets[0].resolve({ bot: { ...namedWait, status: 'idle' } })
    await flush()
    gets[1].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('working')
    expect(render().active?.id).toBe('other')
  })

  it('never adds a deleted bot or accepts a replaced profile identity', async () => {
    await unopened()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    gets[0].resolve({ bot: { ...namedWait, status: 'working', created_at: 99 } })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
    hooks.clients[0].emit(namedResolved)
    const lists = holdRefreshes()
    const deleting = render().refresh()
    lists[0].resolve({ bots: [] })
    await deleting
    gets[1].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots).toEqual([])
  })

  it('accepts independent bot reads in either completion order', async () => {
    await unopened()
    const beta = {
      ...namedWait,
      name: 'beta',
      status_detail: { ...namedWait.status_detail!, session_id: 's2' }
    } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? { bots: [namedWait, beta] } : original(method, params)
    await render().refresh()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(
      wire(
        'approval.resolved',
        { request_id: 'old', choice: 'once', bot: 'beta', section_id: 'beta-section' },
        's2'
      )
    )
    gets[1].resolve({ bot: { ...beta, status: 'working' } })
    await flush()
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots.map(row => row.status)).toEqual(['working', 'working'])
  })

  it('retires the matching answer projection so it cannot hide a verified sibling wait', async () => {
    await unopened()
    await render().openSection(namedWait, section())
    const gets = holdBotGets()
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(namedResolved)
    expect(status()).toBe('working')
    gets[0].resolve({ bot: namedWait })
    await flush()
    expect(status()).toBe('needs_you')
    expect(render().bots[0].status).toBe('needs_you')
    // A repeated settlement has no card left to create new optimistic proof.
    hooks.clients[0].emit(resolved)
    expect(status()).toBe('needs_you')
  })

  it.each(['answer', 'retry'])('does not retire another bot’s active %s proof', async kind => {
    const alpha = kind === 'retry' ? ({ ...stoppedBot, owner_id: 'owner' } as Bot) : namedWait
    const beta = {
      ...namedWait,
      name: 'beta',
      status_detail: { ...namedWait.status_detail!, session_id: 's2' }
    } as Bot
    await unopened(alpha)
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? { bots: [alpha, beta] } : original(method, params)
    await render().refresh()
    await render().openSection(alpha, section())
    if (kind === 'answer') {
      hooks.clients[0].emit(approval)
      hooks.clients[0].emit(resolved)
    } else hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    expect(status()).toBe('working')
    const gets = holdBotGets()
    hooks.clients[0].emit(
      wire(
        'approval.resolved',
        { request_id: 'old', choice: 'once', bot: 'beta', section_id: 'beta-section' },
        's2'
      )
    )
    gets[0].resolve({ bot: beta })
    await flush()
    expect(status()).toBe('working')
    expect(render().bots.find(row => row.name === 'beta')?.status).toBe('needs_you')
  })

  it('retains the accepted bot cutoff through buffered restoration without repeating the lookup', async () => {
    await unopened()
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'session.status' ? reply.promise : original(method, params)
    const gets = holdBotGets()
    const opening = render().openSection(namedWait, section())
    await Promise.resolve()
    await Promise.resolve()
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(namedResolved)
    gets[0].resolve({ bot: namedWait })
    await flush()
    reply.resolve({ status: 'working' })
    await opening
    expect(status()).toBe('needs_you')
    expect(render().chat.approvals).toEqual([])
    expect(gets).toHaveLength(1)
  })

  it('ignores malformed, unbound and unknown-bot settlements', async () => {
    await unopened()
    const gets = holdBotGets()
    for (const payload of [
      { request_id: 'old', choice: 'always', bot: 'alpha', section_id: 'section' },
      { request_id: 'old', choice: 'once', section_id: 'section' },
      { request_id: 'old', choice: 'once', bot: 'alpha' },
      { request_id: 'old', choice: 'once', bot: 'missing', section_id: 'section' }
    ])
      hooks.clients[0].emit(wire('approval.resolved', payload))
    hooks.clients[0].emit(
      wire('clarify.resolved', {
        request_id: 'old',
        bot: 'alpha',
        section_id: 'section',
        status: 'answered',
        answers: { answer: 123 }
      })
    )
    await flush()
    expect(gets).toEqual([])
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('preserves independent room turn proof while a sibling bot is verified', async () => {
    await unopened()
    const beta = {
      ...namedWait,
      name: 'beta',
      status_detail: {
        ...namedWait.status_detail!,
        session_id: 's2',
        room_id: 'room',
        section_id: null
      }
    } as Bot
    const room = {
      id: 'room',
      members: [],
      turns: [
        { bot: 'alpha', live_session_id: 's1' },
        { bot: 'beta', live_session_id: 's2' }
      ]
    } as unknown as Room
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [namedWait, beta] }
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get') return { room }
      return original(method, params)
    }
    await render().refresh()
    await render().openRoom(room)
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(resolved)
    hooks.clients[0].emit(wire('clarify.request', { request_id: 'old', question: 'When?' }, 's2'))
    const gets = holdBotGets()
    hooks.clients[0].emit(
      wire(
        'clarify.resolved',
        {
          bot: 'beta',
          section_id: 'room-stored',
          request_id: 'batch',
          status: 'waiting',
          answers: { first: 'Yes' },
          remaining: ['second']
        },
        's2'
      )
    )
    gets[0].resolve({ bot: beta })
    await flush()
    expect(render().bots.map(row => row.status)).toEqual(['working', 'needs_you'])
    expect(render().chat.turns.s1.resumedWaiting).toBe(true)
    expect(render().chat.questions.map(card => card.sessionId)).toEqual(['s2'])
  })

  it('verifies current authority for a late old settlement after completion and a new pending turn', async () => {
    await unopened()
    hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
    hooks.clients[0].emit(wire('message.start', {}))
    hooks.clients[0].emit(
      wire('clarify.request', {
        bot: 'alpha',
        section_id: 'section',
        request_id: 'new',
        question: 'Where?'
      })
    )
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    gets[0].resolve({ bot: namedWait })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('bounds duplicate verification per bot so another bot’s answer is never starved', async () => {
    await unopened()
    const beta = {
      ...namedWait,
      name: 'beta',
      status_detail: { ...namedWait.status_detail!, session_id: 's2' }
    } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? { bots: [namedWait, beta] } : original(method, params)
    await render().refresh()
    const gets = holdBotGets()
    for (let count = 0; count < 129; count++) hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(
      wire(
        'approval.resolved',
        { request_id: 'old', choice: 'once', bot: 'beta', section_id: 'beta-section' },
        's2'
      )
    )
    expect(gets).toHaveLength(2)
    gets[1].resolve({ bot: { ...beta, status: 'working' } })
    await flush()
    expect(render().bots.find(row => row.name === 'beta')?.status).toBe('working')
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(gets).toHaveLength(3)
    gets[2].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots.map(row => row.status)).toEqual(['working', 'working'])
  })

  it('uses the latest coalesced session and section for context replacement fencing', async () => {
    await unopened()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(
      wire(
        'approval.resolved',
        { request_id: 'second', choice: 'once', bot: 'alpha', section_id: 'other' },
        's2'
      )
    )
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(gets).toHaveLength(2)
    hooks.clients[0].emit({ type: 'hexbot.sections.changed', payload: { id: 'other' } })
    gets[1].resolve({ bot: { ...namedWait, status: 'idle' } })
    await flush()
    expect(render().bots[0].status).toBe('working')
  })

  it('rejects a read computed before exact bot deletion while a roster refresh fails', async () => {
    await unopened()
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit({
      type: 'hexbot.bots.changed',
      payload: { name: 'alpha', bot: 'alpha', deleted: true }
    })
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    await expect(render().refresh()).rejects.toThrow('Roster unavailable')
    gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['alpha', 'unrelated'])(
    'fences a held bot read only for its named %s incident',
    async name => {
      await unopened()
      const gets = holdBotGets()
      hooks.clients[0].emit(namedResolved)
      hooks.clients[0].emit({
        type: 'hexbot.bots.incident',
        payload: { bot: name, section_id: 'unopened', session_id: 'unobserved' }
      })
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
        return original(method, params)
      }
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      gets[0].resolve({ bot: { ...namedWait, status: 'working' } })
      await flush()
      expect(render().bots[0].status).toBe(name === 'alpha' ? 'needs_you' : 'working')
    }
  )
})

const stoppedBot = {
  ...bot,
  status: 'stopped',
  status_detail: { section_id: 'section', text: 'Model request failed', action: { kind: 'retry' } }
} as Bot
async function openStopped(cached = stoppedBot) {
  const original = hooks.handler
  hooks.handler = async (method, params) => {
    if (method === 'hexbot.bots.list') return { bots: [cached] }
    if (method === 'session.status') return { status: 'idle' }
    return original(method, params)
  }
  await render().activate(daemon, 'token')
  await render().refresh()
  await render().openSection(cached, section())
  expect(status()).toBe('stopped')
}

describe('mobile deleted Retry section consumer', () => {
  const deleted = (id = 'section') => ({
    type: 'hexbot.sections.changed',
    payload: { id, deleted: true }
  })
  function failReads() {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.list' || method === 'hexbot.bots.get')
        throw new Error('Read unavailable')
      if (method === 'hexbot.bots.list') return { bots: [{ ...stoppedBot, status: 'idle' }] }
      return original(method, params)
    }
  }

  it('retires only the deleted private Retry even when the combined refresh fails', async () => {
    await unopened(stoppedBot)
    failReads()
    hooks.clients[0].emit(deleted())
    await expect(render().refresh()).rejects.toThrow('Read unavailable')
    expect(render().bots[0]).toMatchObject({ status: 'idle', status_detail: null })
    expect(render().sections).toEqual([])
  })

  it('preserves a confirmed private sibling card after retiring the deleted Retry', async () => {
    await unopened(stoppedBot)
    await render().openSection(stoppedBot, section('other', 's2'))
    hooks.clients[0].emit(
      wire('approval.request', { request_id: 'sibling', choices: ['once'] }, 's2')
    )
    failReads()
    hooks.clients[0].emit(deleted())
    await expect(render().refresh()).rejects.toThrow('Read unavailable')
    expect(status()).toBe('needs_you')
    expect(render().bots[0].status).toBe('needs_you')
    expect(render().chat.approvals.map(card => card.requestId)).toEqual(['sibling'])
  })

  it.each(['hexbot.sections.open', 'session.status'])(
    'closes the deleted route and rejects the held %s restoration',
    async method => {
      await unopened(stoppedBot)
      failReads()
      const held = deferred()
      const original = hooks.handler
      hooks.handler = (name, params) => (name === method ? held.promise : original(name, params))
      const opening = render().openSection(stoppedBot, section())
      await flush()
      hooks.clients[0].emit(deleted())
      held.resolve(
        method === 'session.status' ? { status: 'working' } : { section: section(), messages: [] }
      )
      await opening
      expect(render().route).toBeNull()
      expect(render().liveSessionId()).toBeNull()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('applies a successful local deletion reply without waiting for its event or any refresh', async () => {
    await openStopped()
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.delete' ? { deleted: true } : original(method, params)
    await render().rpc('hexbot.sections.delete', { id: 'section' })
    expect(render().route).toBeNull()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['other section', 'room', 'global', 'connector'])(
    'preserves an independent %s incident and ignores an untrusted bot hint',
    async kind => {
      const cached = {
        ...stoppedBot,
        status_detail: {
          ...stoppedBot.status_detail!,
          section_id: kind === 'other section' ? 'other' : kind === 'global' ? null : 'section',
          room_id: kind === 'room' ? 'room' : null,
          action:
            kind === 'connector' ? { kind: 'fix_connector', connector: 'mail' } : { kind: 'retry' }
        }
      } as Bot
      await unopened(cached)
      failReads()
      hooks.clients[0].emit({ ...deleted(), payload: { ...deleted().payload, bot: 'alpha' } })
      await expect(render().refresh()).rejects.toThrow('Read unavailable')
      expect(render().bots[0]).toEqual(cached)
    }
  )

  it('uses the exact section ID despite a conflicting bot hint and keeps another bot intact', async () => {
    await unopened(stoppedBot)
    const beta = {
      ...stoppedBot,
      name: 'beta',
      status_detail: { ...stoppedBot.status_detail!, section_id: 'beta' }
    } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? { bots: [stoppedBot, beta] } : original(method, params)
    await render().refresh()
    failReads()
    hooks.clients[0].emit({ ...deleted(), payload: { ...deleted().payload, bot: 'beta' } })
    expect(render().bots.map(bot => bot.status)).toEqual(['idle', 'stopped'])
  })

  it.each(['approval', 'working', 'error'])(
    'keeps a current private sibling %s after the failed section is deleted',
    async activity => {
      await unopened(stoppedBot)
      await render().openSection(stoppedBot, section('other', 's2'))
      if (activity === 'approval')
        hooks.clients[0].emit(
          wire('clarify.request', { request_id: 'sibling', question: 'Where?' }, 's2')
        )
      if (activity === 'error')
        hooks.clients[0].emit(
          wire('message.complete', { error: 'Other conversation failed' }, 's2')
        )
      failReads()
      hooks.clients[0].emit(deleted())
      const expected =
        activity === 'approval' ? 'needs_you' : activity === 'working' ? 'working' : 'stopped'
      expect(status()).toBe(expected)
      expect(render().bots[0].status).toBe(expected)
      expect(render().bots[0].status_detail?.action).toBeFalsy()
      if (activity === 'error')
        expect(render().bots[0].status_detail?.text).toBe('Other conversation failed')
    }
  )

  it.each(['question', 'working', 'error'])(
    'keeps the same bot’s known room sibling %s after its private failure is deleted',
    async activity => {
      const room = {
        id: 'room',
        members: [],
        turns: [{ bot: 'alpha', live_session_id: 'room-session' }]
      } as unknown as Room
      await unopened(stoppedBot)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.get') return { room }
        if (method === 'hexbot.rooms.log') return { events: [] }
        return original(method, params)
      }
      await render().openRoom(room)
      if (activity === 'question')
        hooks.clients[0].emit(
          wire('clarify.request', { request_id: 'sibling', question: 'When?' }, 'room-session')
        )
      if (activity === 'error')
        hooks.clients[0].emit(
          wire('message.complete', { error: 'Room conversation failed' }, 'room-session')
        )
      failReads()
      hooks.clients[0].emit(deleted())
      expect(render().bots[0].status).toBe(
        activity === 'question' ? 'needs_you' : activity === 'working' ? 'working' : 'stopped'
      )
      expect(render().bots[0].status_detail?.action).toBeFalsy()
      expect(render().route?.kind).toBe('room')
      if (activity === 'question')
        expect(render().chat.questions.map(card => card.sessionId)).toEqual(['room-session'])
    }
  )

  it('does not infer deletion from a missing section row or an ordinary changed event', async () => {
    await unopened(stoppedBot)
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.list' ? { sections: [] } : original(method, params)
    await render().refresh()
    hooks.clients[0].emit({ type: 'hexbot.sections.changed', payload: { id: 'section' } })
    expect(render().bots[0].status).toBe('stopped')
  })

  it('filters deleted rows from older and later same-epoch lists and refuses a cached deleted open', async () => {
    await unopened(stoppedBot)
    const reads = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(deleted())
    reads[0].resolve({ bots: [stoppedBot] })
    await older
    expect(render().sections).toEqual([])
    const later = render().refresh()
    reads[1].resolve({ bots: [stoppedBot] })
    await later
    expect(render().sections).toEqual([])
    await render().openSection(stoppedBot, section())
    expect(render().route).toBeNull()
    expect(render().bots[0].status).toBe('idle')
  })

  it('allows verified aggregate sibling authority after deletion while an older get cannot restore the failure', async () => {
    await unopened(stoppedBot)
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(deleted())
    gets[0].resolve({ bot: { ...stoppedBot, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('idle')
    expect(gets).toHaveLength(2)
    const sibling = {
      ...stoppedBot,
      status: 'needs_you',
      status_detail: { ...namedWait.status_detail!, section_id: 'unseen', session_id: 'unseen' }
    } as Bot
    gets[1].resolve({ bot: sibling })
    await flush()
    expect(render().bots[0]).toEqual(sibling)
  })

  it('retains deletion on a same epoch and retires it on a new epoch without replaying an old buffered delete', async () => {
    await openStopped()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    const room = { id: 'room', members: [], turns: [] } as unknown as Room
    const held = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get') return held.promise
      return original(method, params)
    }
    const opening = render().openRoom(room)
    await flush()
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    expect(render().bots[0].status).toBe('stopped')
    held.resolve({ room })
    await opening
    expect(render().bots[0].status).toBe('stopped')
    await render().refresh()
    expect(render().sections.map(section => section.id)).toEqual(['section'])
  })

  it('rejects an old-epoch full snapshot and an old local delete reply', async () => {
    await unopened(stoppedBot)
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    const reads = holdRefreshes()
    const older = render().refresh()
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.sections.delete' ? reply.promise : original(method, params)
    const deleting = render().rpc('hexbot.sections.delete', { id: 'section' })
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    reads[0].resolve({ bots: [{ ...stoppedBot, status: 'idle' }] })
    await older
    reply.resolve({ deleted: true })
    await expect(deleting).rejects.toThrow('daemon restarted')
    expect(render().bots[0].status).toBe('stopped')
  })

  it('rejects an old daemon’s live deletion callback and local delete reply', async () => {
    await unopened(stoppedBot)
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.sections.delete' ? reply.promise : original(method, params)
    const deleting = render().rpc('hexbot.sections.delete', { id: 'section' })
    await render().activate({ ...daemon, id: 'other' }, 'token')
    await render().refresh()
    hooks.clients[0].emit(deleted())
    reply.resolve({ deleted: true })
    await expect(deleting).rejects.toThrow('selected daemon changed')
    expect(render().bots[0].status).toBe('stopped')
    expect(render().sections.map(section => section.id)).toEqual(['section'])
  })

  it('fences a section selection awaiting creation before deletion even after a new epoch', async () => {
    await unopened(stoppedBot)
    const held = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.list') return { sections: [] }
      if (method === 'hexbot.sections.create') return held.promise
      return original(method, params)
    }
    await render().refresh()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    const opening = render().openSection(stoppedBot)
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    held.resolve({ section: section() })
    await opening
    expect(render().route).toBeNull()
    expect(render().error).toBe('This conversation was deleted.')
  })

  it('does not repeat verification or renew deletion when the canonical event precedes its local reply', async () => {
    await unopened(stoppedBot)
    const held = deferred()
    let reads = 0
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.delete') return held.promise
      if (method === 'hexbot.bots.get') {
        reads++
        throw new Error('Bot unavailable')
      }
      return original(method, params)
    }
    const deleting = render().rpc('hexbot.sections.delete', { id: 'section' })
    hooks.clients[0].emit(deleted())
    await flush()
    held.resolve({ deleted: true })
    await deleting
    await flush()
    expect(reads).toBe(1)
    expect(render().bots[0].status).toBe('idle')
  })

  it('keeps a deletion-triggered verification useful when its local reply confirms the same deletion', async () => {
    await unopened(stoppedBot)
    const gets = holdBotGets()
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.sections.delete' ? reply.promise : original(method, params)
    const deleting = render().rpc('hexbot.sections.delete', { id: 'section' })
    hooks.clients[0].emit(deleted())
    reply.resolve({ deleted: true })
    await deleting
    const sibling = {
      ...stoppedBot,
      status: 'needs_you',
      status_detail: {
        ...stoppedBot.status_detail!,
        action: null,
        section_id: 'sibling',
        session_id: 'sibling'
      }
    } as Bot
    gets[0].resolve({ bot: sibling })
    await flush()
    expect(gets).toHaveLength(1)
    expect(render().bots[0]).toEqual(sibling)
  })
})

describe('mobile retry status consumer', () => {
  it('projects an exact resolved retry in both roster and route when refresh fails', async () => {
    await openStopped()
    hooks.clients[0].emit(wire('message.start', {}))
    expect(status()).toBe('stopped')
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    await expect(render().refresh()).rejects.toThrow('Roster unavailable')
    expect(status()).toBe('working')
    expect(render().bots[0].status).toBe('working')
  })

  it('keeps a stopped incident owned by another section or live session', async () => {
    await openStopped({
      ...stoppedBot,
      status_detail: { ...stoppedBot.status_detail!, section_id: 'other', session_id: 's1' }
    })
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 's2'))
    expect(status()).toBe('stopped')
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    expect(status()).toBe('stopped')
    expect(render().bots[0].status).toBe('stopped')
  })

  it('preserves a retry received during an older roster read but honors a newer successful incident snapshot', async () => {
    await openStopped()
    const reads = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    reads[0].resolve({ bots: [stoppedBot] })
    await older
    expect(status()).toBe('working')
    expect(render().bots[0].status).toBe('working')
    const newer = render().refresh()
    reads[1].resolve({ bots: [stoppedBot] })
    await newer
    expect(status()).toBe('stopped')
    expect(render().bots[0].status).toBe('stopped')
  })

  it('shows a fresh failure after retry rather than retaining the resolved incident proof', async () => {
    await openStopped()
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    expect(status()).toBe('working')
    hooks.clients[0].emit(wire('message.complete', { error: 'New model failure' }))
    expect(status()).toBe('stopped')
    expect(render().chat.error).toBe('New model failure')
  })

  it('preserves retry proof on same-epoch reconnect but clears it on a changed epoch even when refresh fails', async () => {
    await openStopped()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
    expect(status()).toBe('working')
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
    expect(status()).toBe('stopped')
    expect(render().chat.retryResolution).toBeUndefined()
  })

  it.each(['first', 'second'])(
    'replays buffered retry proof only within its %s epoch',
    async epoch => {
      await openStopped()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      const reply = deferred()
      const original = hooks.handler
      hooks.handler = (method, params) =>
        method === 'session.status' ? reply.promise : original(method, params)
      const restoring = render().syncChat()
      await Promise.resolve()
      await Promise.resolve()
      hooks.clients[0].emit({
        ...wire('message.start', { retry_resolved: true }),
        seq: 200
      } as GatewayEvent)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: epoch } })
      reply.resolve({ status: 'working' })
      await restoring
      expect(status()).toBe(epoch === 'first' ? 'working' : 'stopped')
      expect(render().chat.busy).toBe(true)
      if (epoch === 'second') {
        hooks.clients[0].emit({
          ...wire('message.start', { retry_resolved: true }),
          seq: 1
        } as GatewayEvent)
        expect(status()).toBe('working')
        expect(render().chat.retryResolution?.sequence).toBe(1)
      }
    }
  )
})

describe('mobile status proof across daemon epochs', () => {
  const room = {
    id: 'room',
    members: [],
    turns: [{ bot: 'alpha', live_session_id: 's1' }]
  } as unknown as Room
  const cases = [
    ['private', 'approval'],
    ['private', 'question'],
    ['room', 'approval'],
    ['room', 'question']
  ] as const
  const frames = (kind: string, place = 'private') => {
    const context = {
      bot: 'alpha',
      section_id: place === 'private' ? 'section' : 'room-conversation'
    }
    return kind === 'approval'
      ? [
          wire('approval.request', {
            ...context,
            request_id: 'old',
            choices: ['once', 'session', 'deny']
          }),
          wire('approval.resolved', { ...context, request_id: 'old', choice: 'once' })
        ]
      : [
          wire('clarify.request', {
            ...context,
            request_id: 'batch',
            questions: [{ qid: 'first', question: 'When?' }]
          }),
          wire('clarify.resolved', {
            ...context,
            request_id: 'batch',
            answers: { first: 'Now' },
            status: 'answered'
          })
        ]
  }
  async function open(place: string) {
    await unopened(bot)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.bots.get') throw new Error('Bot verification unavailable')
      return original(method, params)
    }
    if (place === 'private') await render().openSection(bot, section())
    else await render().openRoom(room)
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
  }
  function failRoster() {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
  }

  it.each(cases)(
    'retires accepted %s %s status on a changed epoch even when refresh fails',
    async (place, kind) => {
      await open(place)
      for (const frame of frames(kind, place)) hooks.clients[0].emit(frame)
      expect(render().bots[0].status).toBe('working')
      failRoster()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0].status).toBe('needs_you')
      const state = place === 'private' ? render().chat : render().chat.turns.s1
      expect(state.resumedWaiting).toBe(false)
      expect(state.waitingRevision).toBe(0)
      if (place === 'private') expect(status()).toBe('needs_you')
    }
  )

  it.each(cases)(
    'keeps accepted %s %s status on the same epoch when refresh fails',
    async (place, kind) => {
      await open(place)
      for (const frame of frames(kind, place)) hooks.clients[0].emit(frame)
      failRoster()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0].status).toBe('working')
      const state = place === 'private' ? render().chat : render().chat.turns.s1
      expect(state.resumedWaiting).toBe(true)
    }
  )

  for (const epoch of ['first', 'second']) {
    it.each(cases)(
      `replays buffered %s %s status only within its ${epoch} epoch`,
      async (place, kind) => {
        await open(place)
        const held = deferred()
        const original = hooks.handler
        hooks.handler = (method, params) =>
          method === (place === 'private' ? 'session.status' : 'hexbot.rooms.get')
            ? held.promise
            : original(method, params)
        const restoring = render().syncChat()
        await flush()
        for (const frame of frames(kind, place)) hooks.clients[0].emit(frame)
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: epoch } })
        failRoster()
        await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
        held.resolve(place === 'private' ? { status: 'working' } : { room })
        await restoring
        expect(render().bots[0].status).toBe(epoch === 'first' ? 'working' : 'needs_you')
        const state = place === 'private' ? render().chat : render().chat.turns.s1
        expect(state.resumedWaiting).toBe(epoch === 'first')
        expect(state.approvals).toEqual([])
        expect(state.questions).toEqual([])
      }
    )
  }

  for (const epoch of ['first', 'second']) {
    it.each(['approval', 'question'])(
      `accepts a held local %s response only within its ${epoch} epoch`,
      async kind => {
        await open('private')
        hooks.clients[0].emit(frames(kind)[0])
        const held = deferred()
        const original = hooks.handler
        hooks.handler = (method, params) =>
          method === (kind === 'approval' ? 'approval.respond' : 'clarify.respond')
            ? held.promise
            : original(method, params)
        const answering =
          kind === 'approval'
            ? render().approval('old', 'once', 's1')
            : render().answer('batch', 'first', 'Now', 's1')
        failRoster()
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: epoch } })
        await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
        held.resolve(
          kind === 'approval'
            ? { resolved: true, choice: 'once' }
            : { status: 'answered', answers: { first: 'Now' } }
        )
        if (epoch === 'second') await expect(answering).rejects.toThrow('daemon restarted')
        else await answering
        expect(render().chat.resumedWaiting).toBe(epoch === 'first')
        expect(render().bots[0].status).toBe(epoch === 'first' ? 'working' : 'needs_you')
      }
    )
  }

  it.each(cases)(
    'accepts fresh buffered %s %s proof received after the new epoch',
    async (place, kind) => {
      await open(place)
      const held = deferred()
      const original = hooks.handler
      hooks.handler = (method, params) =>
        method === (place === 'private' ? 'session.status' : 'hexbot.rooms.get')
          ? held.promise
          : original(method, params)
      const restoring = render().syncChat()
      await flush()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      for (const frame of frames(kind, place)) hooks.clients[0].emit(frame)
      failRoster()
      await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
      held.resolve(place === 'private' ? { status: 'working' } : { room })
      await restoring
      expect(render().bots[0].status).toBe('working')
      const state = place === 'private' ? render().chat : render().chat.turns.s1
      expect(state.resumedWaiting).toBe(true)
    }
  )

  it('retires every answered room turn while keeping a third bot’s pending approval', async () => {
    await open('room')
    const beta = { ...bot, name: 'beta', status_detail: { session_id: 's2' } } as Bot
    const gamma = { ...bot, name: 'gamma', status_detail: { session_id: 's3' } } as Bot
    const currentRoom = {
      ...room,
      turns: [
        ...room.turns!,
        { bot: 'beta', live_session_id: 's2' },
        { bot: 'gamma', live_session_id: 's3' }
      ]
    }
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [bot, beta, gamma] }
      if (method === 'hexbot.rooms.get') return { room: currentRoom }
      return original(method, params)
    }
    await render().refresh()
    await render().openRoom(currentRoom)
    for (const frame of frames('approval', 'room')) hooks.clients[0].emit(frame)
    hooks.clients[0].emit(
      wire('clarify.request', { request_id: 'batch', question: 'Where?' }, 's2')
    )
    hooks.clients[0].emit(
      wire(
        'clarify.resolved',
        { request_id: 'batch', answers: { batch: 'Here' }, status: 'answered' },
        's2'
      )
    )
    hooks.clients[0].emit(
      wire('approval.request', { request_id: 'pending', choices: ['once'] }, 's3')
    )
    expect(render().bots.map(bot => bot.status)).toEqual(['working', 'working', 'needs_you'])
    failRoster()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    await expect(hooks.clients[0].ready()).rejects.toThrow('Roster unavailable')
    expect(render().bots.map(bot => bot.status)).toEqual(['needs_you', 'needs_you', 'needs_you'])
    expect(
      Object.values(render().chat.turns).every(
        turn => !turn.resumedWaiting && turn.waitingRevision === 0
      )
    ).toBe(true)
    expect(render().chat.approvals.map(card => card.sessionId)).toEqual(['s3'])
  })
})

describe('mobile confirmed card status', () => {
  const request = (kind: string, sessionId = 's1') =>
    kind === 'approval'
      ? wire('approval.request', { request_id: 'card', choices: ['once'] }, sessionId)
      : wire('clarify.request', { request_id: 'card', question: 'Where?' }, sessionId)

  it.each([
    ['idle', 'approval'],
    ['idle', 'question'],
    ['working', 'approval'],
    ['working', 'question']
  ])(
    'projects a current card over cached %s for %s without a roster read',
    async (cached, kind) => {
      const current = { ...bot, status: cached, status_detail: null } as Bot
      await unopened(current)
      await render().openSection(current, section())
      hooks.clients[0].emit(request(kind))
      expect(render().bots[0].status).toBe('needs_you')
      expect(status()).toBe('needs_you')
      expect(render().bots[0].status_detail).toMatchObject({
        session_id: 's1',
        section_id: 'section',
        room_id: null,
        action: null
      })
    }
  )

  it('keeps an authoritative failure above a current human card', async () => {
    await openStopped()
    hooks.clients[0].emit(request('approval'))
    expect(render().chat.approvals).toHaveLength(1)
    expect(render().bots[0].status).toBe('stopped')
    expect(status()).toBe('stopped')
  })

  it.each(['approval', 'question'])(
    'folds another current same-bot room %s independently of the named session',
    async kind => {
      const room = {
        id: 'room',
        members: [],
        turns: [
          { bot: 'alpha', live_session_id: 's1' },
          { bot: 'alpha', live_session_id: 's2' }
        ]
      } as unknown as Room
      await unopened(bot)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.get') return { room }
        if (method === 'hexbot.rooms.log') return { events: [] }
        if (method === 'hexbot.bots.get') throw new Error('Verification unavailable')
        return original(method, params)
      }
      await render().openRoom(room)
      hooks.clients[0].emit(request('approval'))
      hooks.clients[0].emit(request(kind, 's2'))
      hooks.clients[0].emit(wire('approval.resolved', { request_id: 'card', choice: 'once' }))
      expect(render().chat.turns.s1.approvals).toEqual([])
      expect(
        render().chat.turns.s2.approvals.length + render().chat.turns.s2.questions.length
      ).toBe(1)
      expect(render().bots[0].status).toBe('needs_you')
      expect(render().bots[0].status_detail).toMatchObject({
        session_id: 's2',
        section_id: null,
        room_id: 'room',
        action: null
      })
    }
  )

  it('keeps room cards bound to their bot and retains stopped priority', async () => {
    const current = { ...bot, status: 'idle', status_detail: null } as Bot
    const room = {
      id: 'room',
      members: [],
      turns: [{ bot: 'beta', live_session_id: 's2' }]
    } as unknown as Room
    await unopened(current)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [current, { ...stoppedBot, name: 'beta' }] }
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      return original(method, params)
    }
    await render().refresh()
    await render().openRoom(room)
    hooks.clients[0].emit(request('question', 's2'))
    expect(render().bots.map(row => row.status)).toEqual(['idle', 'stopped'])
  })
})

describe('mobile archive status reconciliation', () => {
  const changed = {
    type: 'hexbot.sections.changed',
    payload: { id: 'section', bot: 'alpha', name: 'alpha' }
  }
  async function prepare(restore: boolean) {
    const current = restore
      ? ({ ...stoppedBot, status: 'idle', status_detail: null } as Bot)
      : stoppedBot
    await unopened(current)
    const original = hooks.handler
    const accepted = restore
      ? stoppedBot
      : ({ ...stoppedBot, status: 'idle', status_detail: null } as Bot)
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.list') throw new Error('Rooms unavailable')
      if (method === 'hexbot.bots.get') return { bot: accepted }
      if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
        return { section: { ...section(), archived_at: restore ? null : 1 } }
      return original(method, params)
    }
    return restore ? 'stopped' : 'idle'
  }

  for (const restore of [false, true]) {
    it.each(['native', 'known'])(
      'reconciles ' +
        (restore ? 'restore' : 'archive') +
        ' from a %s changed event when another list fails',
      async shape => {
        const expected = await prepare(restore)
        hooks.clients[0].emit({
          type: 'hexbot.sections.changed',
          payload:
            shape === 'native' ? { id: 'section', bot: 'alpha', name: 'alpha' } : { id: 'section' }
        })
        await flush()
        await expect(render().refresh()).rejects.toThrow('Rooms unavailable')
        expect(render().bots[0].status).toBe(expected)
      }
    )

    it(
      'reconciles an accepted local ' +
        (restore ? 'restore' : 'archive') +
        ' without a broadcast or bulk refresh',
      async () => {
        const expected = await prepare(restore)
        await render().rpc(restore ? 'hexbot.sections.unarchive' : 'hexbot.sections.archive', {
          id: 'section'
        })
        await flush()
        expect(render().bots[0].status).toBe(expected)
      }
    )
  }

  it.each(['bot', 'section'])(
    'applies the accepted %s read without waiting on its companion read',
    async first => {
      await openStopped()
      const held = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get')
          return first === 'bot'
            ? { bot: { ...stoppedBot, status: 'idle', status_detail: null } }
            : held.promise
        if (method === 'hexbot.sections.list' && params.bot)
          return first === 'section'
            ? { sections: [{ ...section(), archived_at: 1 }] }
            : held.promise
        return original(method, params)
      }
      hooks.clients[0].emit(changed)
      await flush()
      expect(render().bots[0].status).toBe('idle')
      const current = render().route
      if (first === 'section')
        expect(current?.kind === 'section' && current.section.archived_at).toBe(1)
      held.resolve(
        first === 'bot'
          ? { sections: [{ ...section(), archived_at: 1 }] }
          : { bot: { ...stoppedBot, status: 'idle', status_detail: null } }
      )
      await flush()
    }
  )

  it.each(['remote', 'local'])(
    'excludes an archived private card after %s confirmation and restores its failure in reverse',
    async path => {
      await openStopped()
      hooks.clients[0].emit(approval)
      let archived = true
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.list') throw new Error('Rooms unavailable')
        if (method === 'hexbot.bots.get')
          return {
            bot: archived ? { ...stoppedBot, status: 'idle', status_detail: null } : stoppedBot
          }
        if (method === 'hexbot.sections.list' && params.bot)
          return { sections: [{ ...section(), archived_at: archived ? 1 : null }] }
        if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
          return { section: { ...section(), archived_at: archived ? 1 : null } }
        return original(method, params)
      }
      if (path === 'remote') hooks.clients[0].emit(changed)
      else await render().rpc('hexbot.sections.archive', { id: 'section' })
      await flush()
      expect(render().bots[0].status).toBe('idle')
      expect(status()).toBe('idle')
      expect(render().chat.approvals).toHaveLength(1)
      archived = false
      if (path === 'remote') hooks.clients[0].emit(changed)
      else await render().rpc('hexbot.sections.unarchive', { id: 'section' })
      await flush()
      expect(render().bots[0].status).toBe('stopped')
      expect(status()).toBe('stopped')
    }
  )

  it('retains a newer restore field and profile edit through a delayed archive reply and older full snapshot', async () => {
    await openStopped()
    const held = deferred()
    const snapshots = holdRefreshes()
    const older = render().refresh()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.archive') return held.promise
      if (method === 'hexbot.sections.unarchive')
        return { section: { ...section(), archived_at: null, title: 'Old reply title' } }
      if (method === 'hexbot.sections.list' && params.bot) throw new Error('Field unavailable')
      if (method === 'hexbot.bots.get') throw new Error('Bot unavailable')
      return original(method, params)
    }
    const archiving = render().rpc('hexbot.sections.archive', { id: 'section' })
    await render().rpc('hexbot.sections.unarchive', { id: 'section' })
    held.resolve({ section: { ...section(), archived_at: 1 } })
    await archiving
    snapshots[0].resolve({ bots: [stoppedBot] })
    await older
    const current = render().route
    expect(current?.kind === 'section' && current.section.archived_at).toBeNull()
    expect(render().sections[0]).toMatchObject({ archived_at: null, title: 'Snapshot 0' })
  })

  it('keeps an unchanged archive reply from blocking the full roster’s route rebind', async () => {
    await openStopped()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.unarchive')
        return { section: { ...section(), archived_at: null } }
      if (method === 'hexbot.sections.list' && params.bot)
        return { sections: [{ ...section(), archived_at: null }] }
      if (method === 'hexbot.bots.get') return { bot: stoppedBot }
      return original(method, params)
    }
    await render().rpc('hexbot.sections.unarchive', { id: 'section' })
    await flush()
    const snapshots = holdRefreshes()
    const full = render().refresh()
    hooks.clients[0].emit(changed)
    await flush()
    snapshots[0].resolve({ bots: [{ ...stoppedBot, display_name: 'Updated name' }] })
    await full
    const current = render().route
    expect(current?.kind === 'section' && current.bot.display_name).toBe('Updated name')
    expect(current?.kind === 'section' && current.section.title).toBe('Snapshot 0')
  })

  it.each(['epoch', 'daemon'])(
    'rejects old archive callbacks and held reads after a changed %s',
    async boundary => {
      await openStopped()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      const held = deferred()
      const fields = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.archive') return held.promise
        if (method === 'hexbot.sections.list' && params.bot) return fields.promise
        return original(method, params)
      }
      const archiving = render().rpc('hexbot.sections.archive', { id: 'section' })
      const outcome = archiving.catch(error => error)
      hooks.clients[0].emit(changed)
      if (boundary === 'epoch')
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      else await render().activate({ ...daemon, id: 'other' }, 'token')
      held.resolve({ section: { ...section(), archived_at: 1 } })
      fields.resolve({ sections: [{ ...section(), archived_at: 1 }] })
      expect(await outcome).toBeInstanceOf(Error)
      await flush()
      expect(render().sections.some(row => row.archived_at)).toBe(false)
    }
  )

  it('invalidates an outside-context held get from the exact bare-id section owner', async () => {
    const cached = {
      ...stoppedBot,
      status_detail: { ...stoppedBot.status_detail!, section_id: 'outside' }
    } as Bot
    await unopened(cached)
    const gets = holdBotGets()
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit({ type: 'hexbot.sections.changed', payload: { id: 'section' } })
    gets[0].resolve({ bot: { ...cached, status: 'working' } })
    await flush()
    expect(render().bots[0].status).toBe('stopped')
    gets[1].reject(new Error('New read unavailable'))
    await flush()
    expect(render().bots[0].status).toBe('stopped')
  })

  it('retains archive verification intent when a later canonical settlement coalesces the next read', async () => {
    await unopened(stoppedBot)
    const gets = holdBotGets()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.list' && params.bot)
        return { sections: [{ ...section(), archived_at: 1 }] }
      return original(method, params)
    }
    hooks.clients[0].emit(namedResolved)
    hooks.clients[0].emit(changed)
    hooks.clients[0].emit(namedResolved)
    gets[0].reject(new Error('Old read unavailable'))
    await flush()
    expect(render().sections[0].archived_at).toBe(1)
    gets[1].resolve({ bot: { ...stoppedBot, status: 'idle', status_detail: null } })
    await flush()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['needs_you', 'stopped'])(
    'preserves an authoritative unseen sibling %s after archiving the named failure',
    async status => {
      await openStopped()
      hooks.clients[0].emit(approval)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get')
          return {
            bot: {
              ...stoppedBot,
              status,
              status_detail: {
                ...stoppedBot.status_detail!,
                section_id: 'unseen',
                session_id: 'unseen-live'
              }
            }
          }
        if (method === 'hexbot.sections.list' && params.bot)
          return { sections: [{ ...section(), archived_at: 1 }] }
        if (method === 'hexbot.rooms.list') throw new Error('Rooms unavailable')
        return original(method, params)
      }
      hooks.clients[0].emit(changed)
      await flush()
      expect(render().bots[0].status).toBe(status)
      expect(render().bots[0].status_detail?.section_id).toBe('unseen')
    }
  )

  it('never infers archive state from a missing targeted row or an unavailable bot read', async () => {
    await openStopped()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get') throw new Error('Unavailable')
      if (method === 'hexbot.sections.list' && params.bot) return { sections: [] }
      return original(method, params)
    }
    hooks.clients[0].emit(changed)
    await flush()
    expect(status()).toBe('stopped')
    expect(render().bots[0].status).toBe('stopped')
  })
})

describe('mobile settlement consumer', () => {
  it('keeps every newer successful snapshot when an older read arrives after an accepted answer', async () => {
    await start()
    const reads = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(resolved)
    const newer = render().refresh()
    reads[1].resolve({ bots: [{ ...bot, status: 'working', display_name: 'New' }] })
    await newer
    expect(render().chat.resumedWaiting).toBe(false)
    reads[0].resolve({ bots: [{ ...bot, display_name: 'Old' }] })
    await older
    const current = render()
    expect(current.bots[0]).toMatchObject({ status: 'working', display_name: 'New' })
    expect(current.rooms[0].id).toBe('room-1')
    expect(current.sections[0].title).toBe('Snapshot 1')
    expect(current.info?.version).toBe('snapshot-1')
    expect(current.settings?.approval_mode).toBe('off')
    expect(current.user?.id).toBe('user-1')
    expect(current.route?.kind === 'section' && current.route.section.title).toBe('Snapshot 1')
  })

  it('uses an older successful fallback when a newer refresh fails after the answer', async () => {
    await start()
    const reads = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(resolved)
    const newer = render().refresh()
    const failed = expect(newer).rejects.toThrow('Roster unavailable')
    reads[1].reject(new Error('Roster unavailable'))
    await failed
    reads[0].resolve({ bots: [{ ...bot, display_name: 'Fallback' }] })
    await older
    expect(render().bots[0]).toMatchObject({ status: 'working', display_name: 'Fallback' })
    expect(render().chat.resumedWaiting).toBe(true)
    expect(render().info?.version).toBe('snapshot-0')
  })

  it('accepts older useful data while a newer refresh is still pending and later fails', async () => {
    await start()
    const reads = holdRefreshes()
    const older = render().refresh()
    const newer = render().refresh()
    const failed = expect(newer).rejects.toThrow('Roster unavailable')
    reads[0].resolve({ bots: [{ ...bot, display_name: 'Useful' }] })
    await older
    expect(render().bots[0].display_name).toBe('Useful')
    reads[1].reject(new Error('Roster unavailable'))
    await failed
    expect(render().bots[0].display_name).toBe('Useful')
  })

  it('orders successful refreshes distinctly even when they start at the same event revision', async () => {
    await start()
    hooks.clients[0].emit(resolved)
    const reads = holdRefreshes()
    const older = render().refresh()
    const newer = render().refresh()
    reads[1].resolve({ bots: [{ ...bot, status: 'working', display_name: 'New' }] })
    await newer
    reads[0].resolve({ bots: [{ ...bot, display_name: 'Old' }] })
    await older
    expect(render().bots[0]).toMatchObject({ status: 'working', display_name: 'New' })
  })

  it('keeps old daemon refresh responses outside the newly selected client', async () => {
    await start()
    const reads = holdRefreshes()
    const older = render().refresh()
    const rejected = expect(older).rejects.toThrow('selected daemon changed')
    await render().activate({ ...daemon, id: 'other' }, 'token')
    const current = render().refresh()
    reads[1].resolve({ bots: [{ ...bot, status: 'working', display_name: 'Other daemon' }] })
    await current
    reads[0].resolve({ bots: [{ ...bot, display_name: 'Old daemon' }] })
    await rejected
    expect(render().active?.id).toBe('other')
    expect(render().bots[0].display_name).toBe('Other daemon')
  })

  it('keeps the accepted newer roster and its cutoff when buffered answers restore after both refreshes', async () => {
    await render().activate(daemon, 'token')
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'session.status' ? reply.promise : original(method, params)
    const opening = render().openSection(bot, section())
    await Promise.resolve()
    await Promise.resolve()
    const reads = holdRefreshes()
    const older = render().refresh()
    hooks.clients[0].emit(approval)
    hooks.clients[0].emit(resolved)
    const newer = render().refresh()
    reads[1].resolve({ bots: [bot] })
    await newer
    reads[0].resolve({ bots: [{ ...bot, status: 'working' }] })
    await older
    reply.resolve({ status: 'working' })
    await opening
    expect(render().chat.resumedWaiting).toBe(false)
    expect(render().chat.approvals).toEqual([])
    expect(render().bots[0].status).toBe('needs_you')
  })

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

describe('mobile archive live projection and completed edits', () => {
  const changed = {
    type: 'hexbot.sections.changed',
    payload: { id: 'section', bot: 'alpha', name: 'alpha' }
  }
  async function openLive(current: Bot, archived = false) {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [current] }
      if (method === 'hexbot.sections.list')
        return { sections: [{ ...section(), archived_at: archived ? 1 : null, title: 'Original' }] }
      if (method === 'hexbot.sections.open')
        return {
          section: { ...section(), archived_at: archived ? 1 : null, title: 'Original' },
          messages: []
        }
      return original(method, params)
    }
    await render().activate(daemon, 'token')
    await render().refresh()
    await render().openSection(current, { ...section(), archived_at: archived ? 1 : null })
  }
  function failScoped(archived: boolean) {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get' || method === 'hexbot.rooms.list')
        throw new Error('Unavailable')
      if (method === 'hexbot.sections.list' && params.bot)
        return { sections: [{ ...section(), archived_at: archived ? 1 : null }] }
      if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
        return { section: { ...section(), archived_at: archived ? 1 : null } }
      return original(method, params)
    }
  }

  for (const path of ['local', 'remote']) {
    it.each(['working', 'needs_you'])(
      'excludes exact named %s after ' + path + ' archive even if the bot read fails',
      async active => {
        const current = { ...namedWait, status: active } as Bot
        await openLive(current)
        if (active === 'needs_you') hooks.clients[0].emit(approval)
        failScoped(true)
        if (path === 'local') await render().rpc('hexbot.sections.archive', { id: 'section' })
        else hooks.clients[0].emit(changed)
        await flush()
        expect(render().bots[0]).toMatchObject({ status: 'idle', status_detail: null })
        expect(status()).toBe('idle')
        expect(render().chat.busy).toBe(true)
        await expect(render().refresh()).rejects.toThrow('Unavailable')
      }
    )
    it(
      'projects a known running restored section after ' +
        path +
        ' restore with failed bot verification',
      async () => {
        await openLive({ ...bot, status: 'idle', status_detail: null } as Bot, true)
        failScoped(false)
        if (path === 'local') await render().rpc('hexbot.sections.unarchive', { id: 'section' })
        else hooks.clients[0].emit(changed)
        await flush()
        expect(render().bots[0].status).toBe('working')
        expect(status()).toBe('working')
      }
    )
  }

  it.each([
    {
      status: 'working',
      detail: { ...namedWait.status_detail!, section_id: 'outside', session_id: 'outside-live' }
    },
    {
      status: 'needs_you',
      detail: { ...namedWait.status_detail!, section_id: 'outside', session_id: 'outside-live' }
    },
    { status: 'stopped', detail: { ...stoppedBot.status_detail!, section_id: 'outside' } },
    { status: 'stopped', detail: { ...stoppedBot.status_detail!, room_id: 'room' } },
    {
      status: 'stopped',
      detail: { ...stoppedBot.status_detail!, action: { kind: 'fix_connector', connector: 'mail' } }
    }
  ])(
    'keeps independent aggregate cause $status/$detail after the other live section is archived',
    async ({ status: active, detail }) => {
      const current = { ...bot, status: active, status_detail: detail } as Bot
      await openLive(current)
      failScoped(true)
      await render().rpc('hexbot.sections.archive', { id: 'section' })
      await flush()
      expect(render().bots[0]).toMatchObject({ status: active, status_detail: detail })
    }
  )

  for (const archived of [false, true]) {
    it.each(['mutation-first', 'snapshot-first'])(
      'keeps completed ' +
        (archived ? 'archive' : 'restore') +
        ' when a precommit snapshot completes %s',
      async order => {
        await openLive({ ...bot, status: 'idle', status_detail: null } as Bot, !archived)
        const mutation = deferred()
        const info = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
            return mutation.promise
          if (method === 'hexbot.info') return info.promise
          if (method === 'hexbot.sections.list') {
            if (params.bot) throw new Error('Scoped field unavailable')
            return {
              sections: [{ ...section(), archived_at: archived ? null : 1, title: 'Fresh title' }]
            }
          }
          if (method === 'hexbot.bots.list')
            return {
              bots: [{ ...bot, status: 'idle', status_detail: null, display_name: 'Fresh name' }]
            }
          if (method === 'hexbot.bots.get') throw new Error('Bot unavailable')
          return original(method, params)
        }
        const editing = render().rpc(
          archived ? 'hexbot.sections.archive' : 'hexbot.sections.unarchive',
          { id: 'section' }
        )
        const snapshot = render().refresh()
        if (order === 'snapshot-first') {
          info.resolve({})
          await snapshot
        }
        mutation.resolve({ section: { ...section(), archived_at: archived ? 2 : null } })
        await editing
        if (order === 'mutation-first') {
          info.resolve({})
          await snapshot
        }
        const current = render().route
        expect(render().sections[0]).toMatchObject({
          archived_at: archived ? 2 : null,
          title: 'Fresh title'
        })
        expect(current?.kind === 'section' && current.section.archived_at).toBe(archived ? 2 : null)
        expect(current?.kind === 'section' && current.bot.display_name).toBe('Fresh name')
      }
    )
  }

  it.each(['bot-first', 'field-first'])(
    'honors a same-batch authoritative Idle after remote restore in %s order',
    async order => {
      const idle = { ...bot, status: 'idle', status_detail: null } as Bot
      await openLive(idle, true)
      const botRead = deferred(),
        fieldRead = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get') return botRead.promise
        if (method === 'hexbot.sections.list' && params.bot) return fieldRead.promise
        return original(method, params)
      }
      hooks.clients[0].emit(changed)
      if (order === 'bot-first') {
        botRead.resolve({ bot: idle })
        await flush()
      }
      fieldRead.resolve({ sections: [{ ...section(), archived_at: null }] })
      await flush()
      if (order === 'field-first') {
        expect(render().bots[0].status).toBe('working')
        botRead.resolve({ bot: idle })
        await flush()
      }
      expect(render().chat.busy).toBe(true)
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['get', 'full'])(
    'retires restored activity with a genuinely later %s status snapshot',
    async kind => {
      const idle = { ...bot, status: 'idle', status_detail: null } as Bot
      await openLive(idle, true)
      failScoped(false)
      await render().rpc('hexbot.sections.unarchive', { id: 'section' })
      await flush()
      expect(render().bots[0].status).toBe('working')
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get') return { bot: idle }
        if (method === 'hexbot.rooms.list') return { rooms: [] }
        if (method === 'hexbot.sections.list')
          return { sections: [{ ...section(), archived_at: null }] }
        return original(method, params)
      }
      if (kind === 'get') {
        hooks.clients[0].emit(namedResolved)
        await flush()
      } else await render().refresh()
      expect(render().chat.busy).toBe(true)
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('preserves a newer exact Retry authority and accepts the fresh open after an earlier archive', async () => {
    await openLive({ ...namedWait, status: 'working' } as Bot)
    failScoped(true)
    await render().rpc('hexbot.sections.archive', { id: 'section' })
    await flush()
    expect(render().bots[0].status).toBe('idle')
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get') return { bot: { ...stoppedBot, owner_id: 'owner' } }
      if (method === 'hexbot.sections.open')
        return { section: { ...section(), archived_at: null }, messages: [] }
      return original(method, params)
    }
    hooks.clients[0].emit(namedResolved)
    await flush()
    expect(render().bots[0].status).toBe('stopped')
    await render().syncChat()
    const current = render().route
    expect(current?.kind === 'section' && current.section.archived_at).toBeNull()
    expect(status()).toBe('stopped')
  })

  it.each([false, true])(
    'accepts a fresh open’s archive=%s field after prior proof without requiring lists',
    async archived => {
      await openLive({ ...bot, status: 'idle', status_detail: null } as Bot, !archived)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open')
          return { section: { ...section(), archived_at: archived ? 10 : null }, messages: [] }
        return original(method, params)
      }
      await render().syncChat()
      const current = render().route
      expect(current?.kind === 'section' && current.section.archived_at).toBe(archived ? 10 : null)
      expect(render().sections[0].archived_at).toBe(archived ? 10 : null)
    }
  )

  it('fences an older open after a completed edit and a genuinely later full field snapshot', async () => {
    await openLive({ ...bot, status: 'idle', status_detail: null } as Bot)
    const oldOpen = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.open') return oldOpen.promise
      return original(method, params)
    }
    const restoring = render().syncChat()
    await flush()
    failScoped(true)
    await render().rpc('hexbot.sections.archive', { id: 'section' })
    await flush()
    const scoped = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.list') return { rooms: [] }
      if (method === 'hexbot.sections.list')
        return { sections: [{ ...section(), archived_at: 10 }] }
      return scoped(method, params)
    }
    await render().refresh()
    oldOpen.resolve({ section: { ...section(), archived_at: null }, messages: [] })
    await restoring
    const current = render().route
    expect(current?.kind === 'section' && current.section.archived_at).toBe(10)
    expect(render().sections[0].archived_at).toBe(10)
  })

  it.each([false, true])(
    'fences a scoped field reply captured before completed archive=%s while its companion get is held',
    async archived => {
      await openLive({ ...bot, status: 'idle', status_detail: null } as Bot, !archived)
      const fieldRead = deferred(),
        botRead = deferred()
      const original = hooks.handler
      let fieldCalls = 0
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get') return botRead.promise
        if (method === 'hexbot.sections.list' && params.bot) {
          if (++fieldCalls === 1) return fieldRead.promise
          throw new Error('Field unavailable')
        }
        if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
          return { section: { ...section(), archived_at: archived ? 2 : null } }
        return original(method, params)
      }
      hooks.clients[0].emit(changed)
      await render().rpc(archived ? 'hexbot.sections.archive' : 'hexbot.sections.unarchive', {
        id: 'section'
      })
      fieldRead.resolve({ sections: [{ ...section(), archived_at: archived ? null : 1 }] })
      await flush()
      expect(render().sections[0].archived_at).toBe(archived ? 2 : null)
      botRead.reject(new Error('Bot unavailable'))
      await flush()
    }
  )

  it.each(['older-first', 'newer-first', 'newer-fails'])(
    'orders ordinary overlapping field reads without a mutation in %s order',
    async order => {
      await openLive({ ...bot, status: 'idle', status_detail: null } as Bot)
      const reads: ReturnType<typeof deferred>[] = []
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') {
          reads.push(deferred())
          return { bots: [{ ...bot, status: 'idle', status_detail: null }] }
        }
        if (method === 'hexbot.info') return reads.at(-1)!.promise
        if (method === 'hexbot.sections.list')
          return { sections: [{ ...section(), archived_at: reads.length === 1 ? 10 : null }] }
        return original(method, params)
      }
      const first = render().refresh(),
        second = render().refresh()
      if (order === 'newer-fails') {
        reads[1].reject(new Error('Newer unavailable'))
        await expect(second).rejects.toThrow('Newer unavailable')
        reads[0].resolve({})
        await first
      } else if (order === 'older-first') {
        reads[0].resolve({})
        await first
        reads[1].resolve({})
        await second
      } else {
        reads[1].resolve({})
        await second
        reads[0].resolve({})
        await first
      }
      expect(render().sections[0].archived_at).toBe(order === 'newer-fails' ? 10 : null)
    }
  )

  it.each([false, true])(
    'keeps a verified remote change after an older local archive=%s acknowledgment',
    async archived => {
      await openLive({ ...bot, status: 'idle', status_detail: null } as Bot, !archived)
      const mutation = deferred()
      let field = archived ? 10 : null,
        unavailable = false
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
          return mutation.promise
        if (method === 'hexbot.bots.get' || method === 'hexbot.rooms.list')
          throw new Error('Unavailable')
        if (method === 'hexbot.sections.list' && params.bot) {
          if (unavailable) throw new Error('Field unavailable')
          return { sections: [{ ...section(), archived_at: field }] }
        }
        return original(method, params)
      }
      const editing = render().rpc(
        archived ? 'hexbot.sections.archive' : 'hexbot.sections.unarchive',
        { id: 'section' }
      )
      hooks.clients[0].emit(changed)
      await flush()
      expect(render().sections[0].archived_at).toBe(field)
      field = archived ? null : 20
      hooks.clients[0].emit(changed)
      await flush()
      expect(render().sections[0].archived_at).toBe(field)
      unavailable = true
      mutation.resolve({ section: { ...section(), archived_at: archived ? 10 : null } })
      await editing
      await flush()
      expect(render().sections[0].archived_at).toBe(field)
      const current = render().route
      expect(current?.kind === 'section' && current.section.archived_at).toBe(field)
    }
  )

  it('does not renew an already-reflected archive acknowledgment over newer Retry authority', async () => {
    await openLive({ ...namedWait, status: 'idle', status_detail: null } as Bot, true)
    const mutation = deferred()
    let restoring = false,
      unavailable = true
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.archive') return mutation.promise
      if (method === 'hexbot.bots.get') {
        if (unavailable) throw new Error('Bot unavailable')
        return { bot: { ...stoppedBot, owner_id: 'owner' } }
      }
      if (method === 'hexbot.sections.list' && params.bot) {
        if (restoring) throw new Error('Field unavailable')
        return { sections: [{ ...section(), archived_at: 1 }] }
      }
      if (method === 'hexbot.rooms.list') throw new Error('Rooms unavailable')
      return original(method, params)
    }
    const editing = render().rpc('hexbot.sections.archive', { id: 'section' })
    hooks.clients[0].emit(changed)
    await flush()
    restoring = true
    unavailable = false
    hooks.clients[0].emit(changed)
    await flush()
    expect(render().bots[0].status).toBe('stopped')
    unavailable = true
    mutation.resolve({ section: { ...section(), archived_at: 1 } })
    await editing
    await flush()
    expect(render().bots[0].status).toBe('stopped')
    expect(status()).toBe('stopped')
  })
})

describe('mobile working room projection', () => {
  const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
  const outside = {
    ...namedWait.status_detail!,
    section_id: 'outside',
    session_id: 'outside-live'
  }
  const running = (sessionId = 'room-live', name = 'alpha', roomId = 'room') => ({
    type: 'hexbot.rooms.turn',
    payload: { room_id: roomId, bot: name, live_session_id: sessionId, status: 'running' }
  })
  async function open(current: Bot) {
    const room = { id: 'room', members: [], turns: [] } as unknown as Room
    await unopened(current)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.bots.list' || method === 'hexbot.bots.get')
        throw new Error('Roster unavailable')
      return original(method, params)
    }
    await render().openRoom(room)
  }

  it.each([
    { ...idle, status_detail: null },
    { ...idle, status_detail: outside },
    { ...idle, status_detail: { ...outside, session_id: 'room-live', room_id: 'room' } },
    { ...idle, status: 'working', status_detail: outside }
  ] as Bot[])(
    'projects the current running room session over cached $status/$status_detail',
    async cached => {
      await open(cached)
      hooks.clients[0].emit(running())
      hooks.clients[0].emit(wire('message.start', {}, 'room-live'))
      hooks.clients[0].emit(wire('tool.start', { tool_id: 'read', name: 'read_file' }, 'room-live'))
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().chat.turns['room-live']).toMatchObject({ bot: 'alpha', busy: true })
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: {
          session_id: 'room-live',
          section_id: null,
          room_id: 'room',
          text: 'Using read_file',
          action: null
        }
      })
      hooks.clients[0].emit({
        ...running(),
        payload: { ...running().payload, status: 'complete' }
      })
      expect(render().chat.turns).toEqual({})
      expect(render().bots[0]).toMatchObject({
        status: cached.status,
        status_detail: cached.status_detail
      })
    }
  )

  it.each([
    { ...namedWait, status_detail: outside },
    { ...stoppedBot, status_detail: { ...stoppedBot.status_detail!, section_id: 'outside' } },
    { ...stoppedBot, status_detail: { ...stoppedBot.status_detail!, room_id: 'another-room' } },
    {
      ...stoppedBot,
      status_detail: { ...stoppedBot.status_detail!, action: { kind: 'fix_connector' } }
    }
  ] as Bot[])(
    'preserves the independent cached $status cause during a working room turn',
    async cached => {
      await open(cached)
      hooks.clients[0].emit(running())
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0]).toMatchObject({
        status: cached.status,
        status_detail: cached.status_detail
      })
    }
  )

  it('keeps a same-bot sibling human card above another working turn', async () => {
    await open(idle)
    hooks.clients[0].emit(running('waiting-live'))
    hooks.clients[0].emit(
      wire('clarify.request', { request_id: 'question', question: 'When?' }, 'waiting-live')
    )
    hooks.clients[0].emit(running())
    expect(render().bots[0]).toMatchObject({
      status: 'needs_you',
      status_detail: { session_id: 'waiting-live', room_id: 'room' }
    })
    expect(render().chat.questions.map(card => card.sessionId)).toEqual(['waiting-live'])
  })

  it('ignores a different bot, room or unrecognized session as working evidence', async () => {
    await open(idle)
    hooks.clients[0].emit(running('beta-live', 'beta'))
    hooks.clients[0].emit(running('elsewhere', 'alpha', 'other-room'))
    hooks.clients[0].emit(wire('message.start', {}, 'unknown'))
    expect(Object.keys(render().chat.turns)).toEqual(['beta-live'])
    expect(render().bots[0]).toMatchObject({ status: 'idle', status_detail: null })
  })

  it('includes a busy sibling when the cached named room turn is already complete', async () => {
    await open({ ...idle, status_detail: { ...outside, session_id: 'old-live', room_id: 'room' } })
    hooks.clients[0].emit(running('old-live'))
    hooks.clients[0].emit(wire('message.complete', { text: 'Done' }, 'old-live'))
    hooks.clients[0].emit(running())
    expect(render().chat.turns['old-live'].busy).toBe(false)
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'room-live', room_id: 'room' }
    })
  })

  it('preserves the named session’s accepted answer before folding a newer busy sibling', async () => {
    await open({
      ...namedWait,
      status_detail: { ...outside, session_id: 'old-live', section_id: null, room_id: 'room' }
    })
    hooks.clients[0].emit(running('old-live'))
    hooks.clients[0].emit(
      wire('approval.request', { request_id: 'old', choices: ['once'] }, 'old-live')
    )
    hooks.clients[0].emit(
      wire('approval.resolved', { request_id: 'old', choice: 'once' }, 'old-live')
    )
    hooks.clients[0].emit(wire('message.complete', { text: 'Done' }, 'old-live'))
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit(running())
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'room-live', room_id: 'room' }
    })
    expect(render().chat.approvals).toEqual([])
    expect(render().chat.turns['old-live'].resumedWaiting).toBe(true)
  })

  it.each(['get', 'full'])(
    'retires older room activity after a later accepted %s Idle read',
    async kind => {
      await open(idle)
      hooks.clients[0].emit(running())
      expect(render().bots[0].status).toBe('working')
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get') return { bot: idle }
        if (method === 'hexbot.bots.list') return { bots: [idle] }
        if (method === 'hexbot.rooms.list')
          return { rooms: [{ id: 'room', members: [], turns: [] }] }
        return original(method, params)
      }
      if (kind === 'get') {
        hooks.clients[0].emit(namedResolved)
        await flush()
      } else await render().refresh()
      expect(render().chat.turns['room-live'].busy).toBe(true)
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('preserves a new working turn received during an older held Idle roster read', async () => {
    await open(idle)
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return reply.promise
      if (method === 'hexbot.rooms.list') return { rooms: [{ id: 'room', members: [], turns: [] }] }
      return original(method, params)
    }
    const reading = render().refresh()
    hooks.clients[0].emit(running())
    hooks.clients[0].emit(wire('message.start', {}, 'room-live'))
    reply.resolve({ bots: [idle] })
    await reading
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'room-live', room_id: 'room' }
    })
  })

  it.each(['room-live', 'unknown'])(
    'accepts newer explicit Working only for the known room session %s',
    async sessionId => {
      await open(idle)
      hooks.clients[0].emit(running())
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: idle } : original(method, params)
      hooks.clients[0].emit(namedResolved)
      await flush()
      expect(render().bots[0].status).toBe('idle')
      hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }, sessionId))
      expect(render().bots[0].status).toBe(sessionId === 'room-live' ? 'working' : 'idle')
      if (sessionId === 'room-live') {
        hooks.clients[0].emit(
          wire('approval.request', { request_id: 'card', choices: ['once'] }, sessionId)
        )
        hooks.clients[0].emit(
          wire('status.update', { kind: 'working', text: 'Working' }, sessionId)
        )
        expect(render().bots[0].status).toBe('needs_you')
        expect(render().chat.approvals.map(card => card.sessionId)).toEqual([sessionId])
      }
    }
  )

  it.each([false, true])(
    'retains room activity only across the same daemon epoch (changed=%s)',
    async changed => {
      await open(idle)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      hooks.clients[0].emit(running())
      expect(render().bots[0].status).toBe('working')
      hooks.clients[0].emit({
        type: 'gateway.ready',
        payload: { replay_epoch: changed ? 'second' : 'first' }
      })
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0].status).toBe(changed ? 'idle' : 'working')
    }
  )

  it('projects a fresh room snapshot’s busy turn before a later status read retires it', async () => {
    await open(idle)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.get')
        return {
          room: { id: 'room', members: [], turns: [{ bot: 'alpha', live_session_id: 'room-live' }] }
        }
      return original(method, params)
    }
    await render().syncChat()
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'room-live', room_id: 'room' }
    })
    const held = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.get' ? { bot: idle } : held(method, params)
    hooks.clients[0].emit(namedResolved)
    await flush()
    expect(render().bots[0].status).toBe('idle')
  })
})

describe('mobile fallback and snapshot settlement boundaries', () => {
  it.each(
    ['approval', 'question'].flatMap(kind =>
      ['private', 'room'].flatMap(place =>
        [false, true].map(available => [kind, place, available] as const)
      )
    )
  )(
    'keeps an older-daemon %s answer from %s after leaving (lookup=%s)',
    async (kind, place, available) => {
      const cached =
        place === 'private'
          ? namedWait
          : {
              ...namedWait,
              status_detail: { ...namedWait.status_detail!, section_id: null, room_id: 'room' }
            }
      await unopened(cached)
      const base = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.get')
          return {
            room: { id: 'room', members: [], turns: [{ bot: 'alpha', live_session_id: 's1' }] }
          }
        if (method === 'hexbot.rooms.log') return { events: [] }
        return base(method, params)
      }
      if (place === 'private') await render().openSection(cached, section())
      else await render().openRoom({ id: 'room', members: [] } as unknown as Room)
      hooks.clients[0].emit(
        kind === 'approval'
          ? approval
          : wire('clarify.request', { request_id: 'old', question: 'When?' })
      )
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond') return { resolved: true }
        if (method === 'clarify.respond') return { status: 'answered' }
        if (method === 'hexbot.bots.get') {
          expect(params.name).toBe('alpha')
          if (available) return { bot: { ...cached, status: 'working' } }
          throw new Error('Unavailable')
        }
        if (method === 'hexbot.bots.list') throw new Error('Unavailable')
        return original(method, params)
      }
      if (kind === 'approval') await render().approval('old', 'once', 's1')
      else await render().answer('old', 'old', 'Now', 's1')
      await flush()
      expect(render().bots[0].status).toBe('working')
      if (place === 'private') expect(status()).toBe('working')
      render().back()
      expect(render().bots[0].status).toBe('working')
    }
  )

  it.each([false, true])(
    'binds a held legacy ACK to its submitted owner after another route opens (lookup=%s)',
    async available => {
      const beta = {
        ...namedWait,
        name: 'beta',
        status_detail: { ...namedWait.status_detail!, session_id: 's2', section_id: 'other' }
      }
      await unopened()
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.list' ? { bots: [namedWait, beta] } : original(method, params)
      await render().refresh()
      await render().openSection(namedWait, section())
      hooks.clients[0].emit(approval)
      const reply = deferred()
      const current = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond') return reply.promise
        if (method === 'hexbot.bots.get') {
          expect(params.name).toBe('alpha')
          if (!available) throw new Error('Unavailable')
          return { bot: { ...namedWait, status: 'working' } }
        }
        return current(method, params)
      }
      const answering = render().approval('old', 'once', 's1')
      await render().openSection(beta, section('other', 's2'))
      hooks.clients[0].emit(
        wire('approval.request', { request_id: 'old', choices: ['once'] }, 's2')
      )
      reply.resolve({ resolved: true })
      await answering
      await flush()
      expect(render().bots.map(bot => bot.status)).toEqual(['working', 'needs_you'])
      expect(render().chat.approvals.map(card => card.sessionId)).toEqual(['s2'])
      expect(status()).toBe('needs_you')
    }
  )

  it('keeps partial questions and retires retained fallback proof on new cards, authority and epoch', async () => {
    await unopened()
    await render().openSection(namedWait, section())
    hooks.clients[0].emit(
      wire('clarify.request', {
        request_id: 'batch',
        questions: [
          { qid: 'a', question: 'A?' },
          { qid: 'b', question: 'B?' }
        ]
      })
    )
    const original = hooks.handler
    let available = false
    hooks.handler = async (method, params) => {
      if (method === 'clarify.respond')
        return { status: params.question_id === 'a' ? 'waiting' : 'answered' }
      if (method === 'hexbot.bots.get') {
        if (!available) throw new Error('Unavailable')
        return { bot: namedWait }
      }
      return original(method, params)
    }
    await render().answer('batch', 'a', 'First', 's1')
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['b'])
    expect(render().bots[0].status).toBe('needs_you')
    await render().answer('batch', 'b', 'Second', 's1')
    render().back()
    expect(render().bots[0].status).toBe('working')
    available = true
    hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    await flush()
    expect(render().bots[0].status).toBe('needs_you')
    await render().openSection(namedWait, section())
    hooks.clients[0].emit(approval)
    hooks.handler = async (method, params) => {
      if (method === 'approval.respond') return { resolved: true }
      if (method === 'hexbot.bots.get') throw new Error('Unavailable')
      return original(method, params)
    }
    await render().approval('old', 'once', 's1')
    render().back()
    expect(render().bots[0].status).toBe('working')
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['alpha', 'other'])(
    'rejects a held old status only after an ordinary changed event for %s',
    async name => {
      await unopened()
      const gets = holdBotGets()
      hooks.clients[0].emit(namedResolved)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name } })
      gets[0].resolve({ bot: { ...namedWait, status: 'stopped' } })
      await flush()
      if (name === 'alpha') {
        expect(render().bots[0].status).toBe('needs_you')
        expect(gets).toHaveLength(2)
        gets[1].resolve({ bot: { ...namedWait, status: 'idle', status_detail: null } })
        await flush()
        expect(render().bots[0].status).toBe('idle')
      } else expect(render().bots[0].status).toBe('stopped')
    }
  )

  it.each(
    ['approval', 'question'].flatMap(kind =>
      [false, true].flatMap(left =>
        [false, true].map(available => [kind, left, available] as const)
      )
    )
  )(
    'settles a held legacy %s across a newer private wait timestamp (left=%s,lookup=%s)',
    async (kind, left, available) => {
      const initial = {
        ...namedWait,
        status_detail: {
          ...namedWait.status_detail!,
          text: 'Waiting for you',
          since: 100,
          action: null
        }
      }
      await unopened(initial)
      await render().openSection(initial, section())
      hooks.clients[0].emit(
        kind === 'approval'
          ? approval
          : wire('clarify.request', { request_id: 'old', question: 'When?' })
      )
      const reply = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond' || method === 'clarify.respond') return reply.promise
        if (method === 'hexbot.bots.get') {
          expect(params.name).toBe('alpha')
          if (!available) throw new Error('Unavailable')
          return {
            bot: {
              ...initial,
              status: 'working',
              status_detail: { ...initial.status_detail, text: 'Working', since: 120 }
            }
          }
        }
        if (method === 'hexbot.bots.list')
          return {
            bots: [
              {
                ...initial,
                status_detail: {
                  ...initial.status_detail,
                  text: kind === 'question' ? 'Waiting for your answer' : 'Waiting for you',
                  since: 110
                }
              }
            ]
          }
        return original(method, params)
      }
      const answering =
        kind === 'approval'
          ? render().approval('old', 'once', 's1')
          : render().answer('old', 'old', 'Now', 's1')
      if (left) render().back()
      await render().refresh()
      reply.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
      await answering
      await flush()
      expect(render().bots[0].status).toBe('working')
      if (!left) {
        expect(status()).toBe('working')
        expect(render().chat.approvals).toEqual([])
        expect(render().chat.questions).toEqual([])
        render().back()
        expect(render().bots[0].status).toBe('working')
      }
    }
  )

  it.each(['session', 'section', 'room', 'action', 'connector-action', 'connector', 'idle'])(
    'preserves a newer authoritative %s cause through a held legacy answer',
    async cause => {
      const initial: Bot =
        cause === 'connector-action'
          ? {
              ...namedWait,
              status_detail: {
                ...namedWait.status_detail!,
                action: { kind: 'fix_connector', connector: 'mail' }
              }
            }
          : namedWait
      await unopened(initial)
      await render().openSection(initial, section())
      hooks.clients[0].emit(approval)
      const reply = deferred()
      const original = hooks.handler
      const newer: Bot =
        cause === 'idle'
          ? { ...namedWait, status: 'idle', status_detail: null }
          : cause === 'connector'
            ? {
                ...namedWait,
                status: 'stopped',
                status_detail: {
                  session_id: null,
                  section_id: null,
                  room_id: null,
                  since: 110,
                  text: 'Reconnect mail',
                  action: { kind: 'fix_connector', connector: 'mail' }
                }
              }
            : {
                ...namedWait,
                status_detail: {
                  ...namedWait.status_detail!,
                  session_id: cause === 'session' ? 'new-session' : 's1',
                  section_id:
                    cause === 'section' ? 'new-section' : cause === 'room' ? null : 'section',
                  room_id: cause === 'room' ? 'new-room' : null,
                  since: 110,
                  text: 'Waiting for you',
                  action:
                    cause === 'action'
                      ? { kind: 'retry' }
                      : cause === 'connector-action'
                        ? { kind: 'fix_connector', connector: 'calendar' }
                        : null
                }
              }
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond') return reply.promise
        if (method === 'hexbot.bots.list') return { bots: [newer] }
        if (method === 'hexbot.bots.get') throw new Error('Unavailable')
        return original(method, params)
      }
      const answering = render().approval('old', 'once', 's1')
      await render().refresh()
      reply.resolve({ resolved: true })
      await answering
      expect(render().chat.approvals).toEqual([])
      expect(status()).toBe(newer.status)
      render().back()
      expect(render().bots[0]).toMatchObject({
        status: newer.status,
        status_detail: newer.status_detail
      })
    }
  )

  it.each(['s1', 'new-session'])(
    'retires off-route fallback status when a new card arrives in %s',
    async sessionId => {
      await unopened()
      await render().openSection(namedWait, section())
      hooks.clients[0].emit(approval)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond') return { resolved: true }
        if (method === 'hexbot.bots.get') throw new Error('Unavailable')
        return original(method, params)
      }
      await render().approval('old', 'once', 's1')
      render().back()
      expect(render().bots[0].status).toBe('working')
      hooks.clients[0].emit(
        wire(
          'clarify.request',
          {
            bot: 'alpha',
            section_id: sessionId === 's1' ? 'section' : 'another',
            request_id: 'new',
            question: 'Next?'
          },
          sessionId
        )
      )
      expect(render().bots[0].status).toBe('needs_you')
    }
  )

  it('preserves an off-route sibling question received before a held approval acknowledgment', async () => {
    await unopened()
    await render().openSection(namedWait, section())
    hooks.clients[0].emit(approval)
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'approval.respond') return reply.promise
      if (method === 'hexbot.bots.get') throw new Error('Unavailable')
      return original(method, params)
    }
    const answering = render().approval('old', 'once', 's1')
    render().back()
    hooks.clients[0].emit(
      wire('clarify.request', {
        bot: 'alpha',
        section_id: 'section',
        request_id: 'new',
        question: 'Next?'
      })
    )
    reply.resolve({ resolved: true })
    await answering
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('preserves a newer pending history snapshot after leaving a reopened fallback session', async () => {
    await unopened()
    await render().openSection(namedWait, section())
    hooks.clients[0].emit(approval)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'approval.respond') return { resolved: true }
      if (method === 'hexbot.bots.get') throw new Error('Unavailable')
      return original(method, params)
    }
    await render().approval('old', 'once', 's1')
    render().back()
    const previous = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.open'
        ? {
            section: section(),
            messages: [],
            pending_clarify: { request_id: 'new', question: 'Next?' }
          }
        : previous(method, params)
    await render().openSection(namedWait, section())
    expect(render().bots[0].status).toBe('needs_you')
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['absent', 'settled'])(
    'keeps useful legacy proof while reopening a %s pending snapshot',
    async pending => {
      await unopened()
      await render().openSection(namedWait, section())
      const card = { request_id: 'old', question: 'When?' }
      hooks.clients[0].emit(wire('clarify.request', card))
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'clarify.respond') return { status: 'answered' }
        if (method === 'hexbot.bots.get') throw new Error('Unavailable')
        return original(method, params)
      }
      await render().answer('old', 'old', 'Now', 's1')
      render().back()
      const previous = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.sections.open'
          ? {
              section: section(),
              messages: [],
              pending_clarify: pending === 'settled' ? card : undefined
            }
          : previous(method, params)
      await render().openSection(namedWait, section())
      expect(render().chat.questions).toEqual([])
      expect(render().bots[0].status).toBe('working')
      render().back()
      expect(render().bots[0].status).toBe('working')
    }
  )

  it('settles a held room acknowledgment through a benign room rename', async () => {
    const cached = {
      ...namedWait,
      status_detail: { ...namedWait.status_detail!, section_id: null, room_id: 'room' }
    }
    await unopened(cached)
    const reply = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get')
        return {
          room: { id: 'room', members: [], turns: [{ bot: 'alpha', live_session_id: 's1' }] }
        }
      if (method === 'approval.respond') return reply.promise
      if (method === 'hexbot.bots.get' || method === 'hexbot.rooms.list')
        throw new Error('Unavailable')
      return original(method, params)
    }
    await render().openRoom({ id: 'room', members: [] } as unknown as Room)
    hooks.clients[0].emit(approval)
    const answering = render().approval('old', 'once', 's1')
    hooks.clients[0].emit({ type: 'hexbot.rooms.changed', payload: { id: 'room' } })
    reply.resolve({ resolved: true })
    await answering
    expect(render().chat.approvals).toEqual([])
    expect(render().bots[0].status).toBe('working')
    render().back()
    expect(render().bots[0].status).toBe('working')
  })

  it('keeps completed room fallback proof after the native terminal turn event', async () => {
    const cached = {
      ...namedWait,
      status_detail: { ...namedWait.status_detail!, section_id: null, room_id: 'room' }
    }
    await unopened(cached)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.get')
        return {
          room: { id: 'room', members: [], turns: [{ bot: 'alpha', live_session_id: 's1' }] }
        }
      if (method === 'approval.respond') return { resolved: true }
      if (method === 'hexbot.bots.get') throw new Error('Unavailable')
      return original(method, params)
    }
    await render().openRoom({ id: 'room', members: [] } as unknown as Room)
    hooks.clients[0].emit(approval)
    await render().approval('old', 'once', 's1')
    render().back()
    expect(render().bots[0].status).toBe('working')
    hooks.clients[0].emit({
      type: 'hexbot.rooms.turn',
      payload: { room_id: 'room', bot: 'alpha', live_session_id: 's1', status: 'complete' }
    })
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['answer', 'question', 'retry'])(
    'carries exact %s completion proof through the bounded history reread',
    async kind => {
      const cached = kind !== 'retry' ? namedWait : { ...stoppedBot, owner_id: 'owner' }
      await unopened(cached)
      const statusReply = deferred()
      const original = hooks.handler
      let statuses = 0
      hooks.handler = async (method, params) => {
        if (method === 'session.status')
          return ++statuses === 1 ? statusReply.promise : { status: 'idle' }
        if (method === 'hexbot.bots.get') throw new Error('Unavailable')
        return original(method, params)
      }
      const opening = render().openSection(cached, section())
      await flush()
      if (kind === 'answer') {
        hooks.clients[0].emit(approval)
        hooks.clients[0].emit(resolved)
      } else if (kind === 'question') {
        hooks.clients[0].emit(wire('clarify.request', { request_id: 'old', question: 'When?' }))
        hooks.clients[0].emit(
          wire('clarify.resolved', {
            request_id: 'old',
            status: 'answered',
            answers: { old: 'Now' }
          })
        )
      } else hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      statusReply.resolve({ status: 'working' })
      await opening
      expect(statuses).toBe(2)
      expect(status()).toBe('idle')
      expect(render().chat.approvals).toEqual([])
    }
  )

  it.each(['waiting', 'error', 'epoch', 'session', 'authority'])(
    'keeps newer %s evidence across a proof-carrying reread',
    async control => {
      await unopened(namedWait)
      const first = deferred(),
        second = deferred()
      const original = hooks.handler
      let opens = 0,
        statuses = 0
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open')
          return {
            section: section('section', ++opens > 1 && control === 'session' ? 's2' : 's1'),
            messages: opens > 1 ? [{ role: 'assistant', content: 'Done' }] : []
          }
        if (method === 'session.status') return ++statuses === 1 ? first.promise : second.promise
        if (method === 'hexbot.bots.get') return { bot: namedWait }
        return original(method, params)
      }
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      const opening = render().openSection(namedWait, section())
      await flush()
      hooks.clients[0].emit(approval)
      hooks.clients[0].emit(resolved)
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      first.resolve({ status: 'working' })
      await flush()
      if (control === 'waiting')
        hooks.clients[0].emit(wire('clarify.request', { request_id: 'new', question: 'Next?' }))
      if (control === 'error') hooks.clients[0].emit(wire('error', { message: 'New failure' }))
      if (control === 'epoch')
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      if (control === 'authority') {
        hooks.clients[0].emit(namedResolved)
        await flush()
      }
      second.resolve({ status: 'idle' })
      await opening
      expect(status()).toBe(control === 'error' ? 'stopped' : 'needs_you')
      expect(render().chat.messages.map(m => m.text)).toEqual(['Done'])
      expect(opens).toBe(2)
      if (control === 'waiting')
        expect(render().chat.questions.map(q => q.requestId)).toEqual(['new'])
    }
  )
})

describe('mobile tap before the card roster refresh', () => {
  const cases = ['approval', 'question'].flatMap(kind => [
    ...['working', 'idle', 'sibling'].flatMap(cached =>
      [false, true].map(left => [kind, cached, left, false] as const)
    ),
    [kind, 'working', false, true] as const
  ])
  it.each(cases)(
    'settles %s after tapping cached %s before refresh (left=%s,lookup=%s)',
    async (kind, cached, left, available) => {
      vi.useFakeTimers()
      try {
        const initial: Bot =
          cached === 'sibling'
            ? {
                ...namedWait,
                status_detail: {
                  ...namedWait.status_detail!,
                  session_id: 'sibling',
                  section_id: 'sibling-section'
                }
              }
            : { ...namedWait, status: cached === 'idle' ? 'idle' : 'working', status_detail: null }
        const ownWait = {
          ...namedWait,
          status_detail: {
            ...namedWait.status_detail!,
            since: 100,
            text: 'Waiting for you',
            action: null
          }
        }
        await unopened(initial)
        await render().openSection(initial, section())
        const firstRead = deferred(),
          ack = deferred()
        const original = hooks.handler
        let gets = 0
        hooks.handler = async (method, params) => {
          if (method === 'approval.respond' || method === 'clarify.respond') return ack.promise
          if (method === 'hexbot.bots.get') {
            if (++gets === 1) return firstRead.promise
            if (!available) throw new Error('Lookup unavailable')
            return { bot: { ...ownWait, status: 'working' } }
          }
          if (method === 'hexbot.bots.list') return { bots: [ownWait] }
          return original(method, params)
        }
        const changed = { type: 'hexbot.bots.changed', payload: { name: 'alpha' } }
        const card =
          kind === 'approval'
            ? wire('approval.request', {
                request_id: 'old',
                choices: ['once'],
                bot: 'alpha',
                section_id: 'section'
              })
            : wire('clarify.request', {
                request_id: 'old',
                question: 'When?',
                bot: 'alpha',
                section_id: 'section'
              })
        // The extension changes the bot before its approval card; Pi clarification reverses them.
        if (kind === 'approval') hooks.clients[0].emit(changed)
        hooks.clients[0].emit(card)
        if (kind === 'question') hooks.clients[0].emit(changed)
        const answering =
          kind === 'approval'
            ? render().approval('old', 'once', 's1')
            : render().answer('old', 'old', 'Now', 's1')
        if (left) render().back()
        // The old sibling wait, if present, has settled elsewhere before the own-wait snapshot.
        firstRead.resolve({ bot: ownWait })
        await flush()
        await vi.advanceTimersByTimeAsync(200)
        await flush()
        expect(render().bots[0].status).toBe('needs_you')
        ack.resolve(kind === 'approval' ? { resolved: true } : { status: 'answered' })
        await answering
        await flush()
        expect(render().bots[0].status).toBe('working')
        if (!left) {
          expect(status()).toBe('working')
          expect(render().chat.approvals).toEqual([])
          expect(render().chat.questions).toEqual([])
          render().back()
          expect(render().bots[0].status).toBe('working')
        }
      } finally {
        vi.clearAllTimers()
        vi.useRealTimers()
      }
    }
  )
})
