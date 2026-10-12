import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    // Old setters belong to their fixture after beforeEach starts the next one.
    const slots = hooks.slots
    if (!(index in slots)) slots[index] = typeof value === 'function' ? (value as () => T)() : value
    return [
      slots[index],
      (next: T | ((previous: T) => T)) => {
        slots[index] =
          typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next
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

describe('mobile answers when the roster never observed the wait', () => {
  const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
  const room = {
    id: 'room',
    members: [],
    turns: [{ bot: 'alpha', live_session_id: 's1' }]
  } as unknown as Room
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function open(place = 'private', cached = idle) {
    await unopened(cached)
    const original = hooks.handler
    const reads = { get: 0, list: 0 }
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get') {
        reads.get++
        throw new Error('Bot read unavailable')
      }
      if (method === 'hexbot.bots.list') {
        reads.list++
        throw new Error('Roster unavailable')
      }
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      return original(method, params)
    }
    if (place === 'private') await render().openSection(cached, section())
    else await render().openRoom(room)
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    return reads
  }
  async function request(kind = 'approval', place = 'private', batch = false) {
    const changed = { type: 'hexbot.bots.changed', payload: { name: 'alpha' } }
    if (kind === 'approval') hooks.clients[0].emit(changed)
    hooks.clients[0].emit(
      wire(kind === 'approval' ? 'approval.request' : 'clarify.request', {
        bot: 'alpha',
        section_id: place === 'private' ? 'section' : 'room-conversation',
        request_id: 'old',
        ...(kind === 'approval'
          ? { choices: ['once', 'session', 'deny'] }
          : batch
            ? {
                questions: [
                  { qid: 'first', question: 'When?' },
                  { qid: 'second', question: 'Where?' }
                ]
              }
            : { question: 'When?' })
      })
    )
    if (kind === 'question') hooks.clients[0].emit(changed)
    await flush()
    await vi.advanceTimersByTimeAsync(200)
    await flush()
  }
  async function answer(kind = 'approval', canonical = false) {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'approval.respond')
        return canonical ? { resolved: true, choice: 'once' } : { resolved: true }
      if (method === 'clarify.respond')
        return canonical
          ? { status: 'answered', answers: { old: 'Canonical' } }
          : { status: 'answered' }
      return original(method, params)
    }
    if (kind === 'approval') await render().approval('old', 'once', 's1')
    else await render().answer('old', 'old', 'Now', 's1')
    await flush()
  }

  it.each(
    ['approval', 'question'].flatMap(kind => [false, true].map(botRead => [kind, botRead] as const))
  )(
    'accepts a fresh %s answer after an Idle read completed before its tap (botRead=%s)',
    async (kind, botRead) => {
      await open()
      await request(kind)
      const unavailable = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === (botRead ? 'hexbot.bots.get' : 'hexbot.bots.list'))
          return botRead ? { bot: idle } : { bots: [idle] }
        return unavailable(method, params)
      }
      if (botRead) {
        hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
        await flush()
      } else await render().refresh()
      expect(status()).toBe('needs_you')
      hooks.handler = unavailable
      await answer(kind)
      expect(status()).toBe('working')
      render().back()
      expect(render().bots[0].status).toBe('working')
    }
  )

  it.each(
    ['approval', 'question'].flatMap(kind =>
      ['private', 'room'].flatMap(place =>
        [false, true].flatMap(canonical =>
          [false, true].map(left => [kind, place, canonical, left] as const)
        )
      )
    )
  )(
    'retains %s in %s with all reads failing (canonical=%s,left=%s)',
    async (kind, place, canonical, left) => {
      const reads = await open(place)
      await request(kind, place)
      expect(render().bots[0].status).toBe('needs_you')
      if (place === 'private') expect(status()).toBe('needs_you')
      const reply = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond' || method === 'clarify.respond') return reply.promise
        return original(method, params)
      }
      const answering =
        kind === 'approval'
          ? render().approval('old', 'once', 's1')
          : render().answer('old', 'old', 'Now', 's1')
      if (left) render().back()
      reply.resolve(
        kind === 'approval'
          ? canonical
            ? { resolved: true, choice: 'once' }
            : { resolved: true }
          : canonical
            ? { status: 'answered', answers: { old: 'Canonical' } }
            : { status: 'answered' }
      )
      await answering
      await flush()
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: { session_id: 's1', room_id: place === 'room' ? 'room' : null }
      })
      if (!left) {
        const turn = place === 'private' ? render().chat : render().chat.turns.s1
        expect(turn).toMatchObject({
          busy: true,
          waiting: false,
          resumedWaiting: true,
          approvals: [],
          questions: []
        })
        if (place === 'private') expect(status()).toBe('working')
        render().back()
      }
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0].status).toBe('working')
      if (place === 'private') await render().openSection(idle, section())
      else await render().openRoom(room)
      expect(render().bots[0].status).toBe('working')
      if (place === 'private') expect(status()).toBe('working')
      expect(reads.get).toBeGreaterThanOrEqual(2)
      expect(reads.list).toBeGreaterThanOrEqual(2)
      const held = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: idle } : held(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      expect(render().bots[0].status).toBe('idle')
      if (place === 'private') expect(status()).toBe('idle')
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(
    ['approval', 'question'].flatMap(kind =>
      [false, true].flatMap(canonical =>
        [false, true].map(botRead => [kind, canonical, botRead] as const)
      )
    )
  )(
    'does not revive %s after a newer accepted Idle while its ACK is held (canonical=%s,botRead=%s)',
    async (kind, canonical, botRead) => {
      await open()
      await request(kind)
      const reply = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'approval.respond' || method === 'clarify.respond') return reply.promise
        if (method === (botRead ? 'hexbot.bots.get' : 'hexbot.bots.list'))
          return botRead ? { bot: idle } : { bots: [idle] }
        return original(method, params)
      }
      const answering =
        kind === 'approval'
          ? render().approval('old', 'once', 's1')
          : render().answer('old', 'old', 'Now', 's1')
      if (botRead) {
        hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
        await flush()
      } else await render().refresh()
      reply.resolve(
        kind === 'approval'
          ? canonical
            ? { resolved: true, choice: 'once' }
            : { resolved: true }
          : canonical
            ? { status: 'answered', answers: { old: 'Canonical' } }
            : { status: 'answered' }
      )
      await answering
      expect(status()).toBe('idle')
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(
    ['approval', 'question'].flatMap(kind =>
      ['private', 'room'].map(place => [kind, place] as const)
    )
  )(
    'projects an exact remote %s answer in %s after the old snapshot activity retired',
    async (kind, place) => {
      await open(place)
      const unavailable = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') return { bots: [idle] }
        if (method === 'hexbot.rooms.list') return { rooms: [room] }
        return unavailable(method, params)
      }
      await render().refresh()
      expect(render().bots[0].status).toBe('idle')
      hooks.handler = unavailable
      await request(kind, place)
      expect(render().bots[0].status).toBe('needs_you')
      hooks.clients[0].emit(
        wire(kind === 'approval' ? 'approval.resolved' : 'clarify.resolved', {
          bot: 'alpha',
          section_id: place === 'private' ? 'section' : 'room-conversation',
          request_id: 'old',
          ...(kind === 'approval'
            ? { choice: 'once' }
            : { status: 'answered', answers: { old: 'Canonical' } })
        })
      )
      await flush()
      const turn = place === 'private' ? render().chat : render().chat.turns.s1
      expect(turn).toMatchObject({ busy: true, waiting: false, resumedWaiting: true })
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: { session_id: 's1', room_id: place === 'room' ? 'room' : null }
      })
      if (place === 'private') expect(status()).toBe('working')
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: idle } : unavailable(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['idle', 'complete', 'error', 'epoch', 'source', 'room-complete'])(
    'retires the missed-wait proof on %s',
    async control => {
      const place = control === 'room-complete' ? 'room' : 'private'
      await open(place)
      await request('approval', place)
      await answer()
      render().back()
      expect(render().bots[0].status).toBe('working')
      if (control === 'source') {
        const original = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.bots.list' ? { bots: [idle] } : original(method, params)
        await render().activate({ ...daemon, id: 'other', origin: 'http://other' }, 'token')
        await render().refresh()
      } else if (control === 'epoch') {
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      } else if (control === 'room-complete') {
        hooks.clients[0].emit({
          type: 'hexbot.rooms.turn',
          payload: { room_id: 'room', bot: 'alpha', live_session_id: 's1', status: 'complete' }
        })
      } else {
        hooks.clients[0].emit(
          control === 'idle'
            ? wire('status.update', { kind: 'idle', text: 'Idle' })
            : control === 'complete'
              ? wire('message.complete', { text: 'Done' })
              : wire('error', { message: 'Failed' })
        )
      }
      await flush()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('keeps a partial batch and a newer sibling card waiting until their exact answers arrive', async () => {
    await open()
    await request('question', 'private', true)
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'clarify.respond'
        ? {
            status: params.question_id === 'first' ? 'waiting' : 'answered',
            answers: { [String(params.question_id)]: 'Canonical' }
          }
        : original(method, params)
    await render().answer('old', 'first', 'Typed', 's1')
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['second'])
    expect(status()).toBe('needs_you')
    hooks.clients[0].emit(wire('approval.request', { request_id: 'sibling', choices: ['once'] }))
    await render().answer('old', 'second', 'Typed', 's1')
    expect(render().chat).toMatchObject({ busy: true, waiting: true, resumedWaiting: false })
    expect(status()).toBe('needs_you')
    const held = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'approval.respond' ? { resolved: true } : held(method, params)
    await render().approval('sibling', 'once', 's1')
    expect(status()).toBe('working')
    render().back()
    expect(render().bots[0].status).toBe('working')
  })

  it.each(['sibling', 'stopped'])(
    'preserves the cached stronger %s cause after an exact answer',
    async control => {
      const cached =
        control === 'sibling'
          ? {
              ...namedWait,
              status_detail: {
                ...namedWait.status_detail!,
                session_id: 'sibling',
                section_id: 'other'
              }
            }
          : {
              ...namedWait,
              status: 'stopped' as const,
              status_detail: {
                ...namedWait.status_detail!,
                action: { kind: 'fix_connector' as const, connector: 'mail' }
              }
            }
      await open('private', cached)
      await request()
      await answer()
      expect(render().bots[0]).toMatchObject({
        status: cached.status,
        status_detail: cached.status_detail
      })
      render().back()
      expect(render().bots[0]).toMatchObject({
        status: cached.status,
        status_detail: cached.status_detail
      })
    }
  )

  it.each(['archive', 'delete'])(
    'excludes retained missed-wait proof after its exact section %s',
    async control => {
      await open()
      await request()
      await answer()
      expect(status()).toBe('working')
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.archive')
          return { section: { ...section(), archived_at: 1 } }
        return original(method, params)
      }
      if (control === 'archive') await render().rpc('hexbot.sections.archive', { id: 'section' })
      else
        hooks.clients[0].emit({
          type: 'hexbot.sections.changed',
          payload: { id: 'section', bot: 'alpha', deleted: true }
        })
      expect(render().bots[0].status).toBe('idle')
      if (control === 'archive') expect(status()).toBe('idle')
      else expect(render().route).toBeNull()
      render().back()
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['s1', 'sibling'])(
    'keeps a new confirmed card only in its exact retained session %s after leaving',
    async sessionId => {
      await open()
      await request()
      await answer()
      render().back()
      expect(render().bots[0].status).toBe('working')
      hooks.clients[0].emit(
        wire(
          'clarify.request',
          {
            bot: 'alpha',
            section_id: sessionId === 's1' ? 'section' : 'other',
            request_id: 'new',
            question: 'Next?'
          },
          sessionId
        )
      )
      expect(render().bots[0].status).toBe(sessionId === 's1' ? 'needs_you' : 'idle')
    }
  )
})

describe('mobile current room Retry proof', () => {
  const failed = {
    ...stoppedBot,
    owner_id: 'owner',
    status_detail: {
      ...stoppedBot.status_detail!,
      section_id: 'room-conversation',
      room_id: 'room'
    }
  }
  const room = (sessionId = 's1') =>
    ({
      id: 'room',
      owner_id: 'owner',
      archived_at: null,
      members: [
        {
          room_id: 'room',
          member_kind: 'bot',
          member_id: 'alpha',
          added_at: 1,
          added_by: 'owner',
          last_read_seq: 0,
          left_at: null
        }
      ],
      turns: [{ bot: 'alpha', live_session_id: sessionId }]
    }) as unknown as Room
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function open(sessionId = 's1', cached: Bot = failed) {
    await unopened(cached)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.get') return { room: room(sessionId) }
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Bot read unavailable')
      return original(method, params)
    }
    await render().openRoom(room(sessionId))
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
  }
  const turnEvent = (sessionId = 's1', status = 'running', bot = 'alpha', roomId = 'room') => ({
    type: 'hexbot.rooms.turn',
    payload: { room_id: roomId, bot, live_session_id: sessionId, status }
  })
  it.each(['native', 'explicit', 'rollover', 'missing'])(
    'resolves the exact current room turn with %s cached ownership despite unavailable reads',
    async cause => {
      const sessionId = cause === 'rollover' ? 'reopened-live' : 's1'
      const cached = {
        ...failed,
        status_detail: {
          ...failed.status_detail,
          room_id: cause === 'native' ? null : 'room',
          session_id: cause === 'missing' ? null : 's1'
        }
      }
      await open(sessionId, cached)
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, sessionId))
      hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }, sessionId))
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
      expect(render().chat.turns[sessionId].retryResolution).toMatchObject({
        sessionId,
        resolved: true
      })
      expect(chatActivityLabel(render().chat)).toBe('Working')
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: { session_id: sessionId, room_id: 'room', action: null }
      })
      render().back()
      await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: { session_id: sessionId, room_id: 'room' }
      })
    }
  )

  it.each([
    'connector',
    'global',
    'global-room',
    'other-room',
    'private',
    'private-explicit',
    'unmarked',
    'unknown',
    'other-bot',
    'ambiguous-old'
  ])('preserves the %s failure or untrusted room marker', async cause => {
    const cached = {
      ...failed,
      status_detail: {
        ...failed.status_detail,
        action:
          cause === 'connector'
            ? { kind: 'fix_connector' as const, connector: 'mail' }
            : { kind: 'retry' as const },
        room_id:
          cause === 'other-room'
            ? 'other'
            : ['global', 'private', 'ambiguous-old'].includes(cause)
              ? null
              : 'room',
        section_id: ['global', 'global-room'].includes(cause)
          ? null
          : ['private', 'private-explicit'].includes(cause)
            ? 'section'
            : 'room-conversation'
      }
    }
    await open(cause === 'ambiguous-old' ? 'new-live' : 's1', cached)
    if (cause === 'other-bot') hooks.clients[0].emit(turnEvent('beta-live', 'running', 'beta'))
    hooks.clients[0].emit(
      wire(
        'message.start',
        cause === 'unmarked' ? {} : { retry_resolved: true },
        cause === 'unknown'
          ? 'unknown'
          : cause === 'other-bot'
            ? 'beta-live'
            : cause === 'ambiguous-old'
              ? 'new-live'
              : 's1'
      )
    )
    expect(render().bots[0]).toMatchObject({
      status: 'stopped',
      status_detail: cached.status_detail
    })
    if (['global-room', 'private-explicit'].includes(cause)) {
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      hooks.clients[0].emit(turnEvent('s1', 'complete'))
      expect(render().bots[0]).toMatchObject({
        status: 'stopped',
        status_detail: cached.status_detail
      })
      render().back()
      expect(render().bots[0]).toMatchObject({
        status: 'stopped',
        status_detail: cached.status_detail
      })
    }
  })

  it('binds a new running turn and ignores old markers and terminal SIDs while retaining successful completion', async () => {
    await open('old-live')
    hooks.clients[0].emit(turnEvent('new-live'))
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 'old-live'))
    expect(render().bots[0].status).toBe('stopped')
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 'new-live'))
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'new-live', room_id: 'room' }
    })
    hooks.clients[0].emit(turnEvent('old-live', 'complete'))
    expect(render().bots[0].status).toBe('working')
    hooks.clients[0].emit(wire('message.complete', { text: 'Done' }, 'new-live'))
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit(turnEvent('new-live', 'complete'))
    await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
    expect(render().chat).toMatchObject({ busy: false, waiting: false })
    expect(render().bots[0]).toMatchObject({
      status: 'idle',
      status_detail: { action: null, room_id: 'room' }
    })
    hooks.clients[0].emit(turnEvent('next-live'))
    expect(render().bots[0].status).toBe('stopped')
  })

  it.each([false, true])(
    'keeps completed room Retry proof after reopening (leave=%s)',
    async leave => {
      await open()
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
      expect(render().bots[0].status).toBe('working')
      hooks.clients[0].emit(wire('clarify.request', { request_id: 'old', question: 'Next?' }))
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      hooks.clients[0].emit(turnEvent('s1', 'complete'))
      expect(render().bots[0].status).toBe('idle')
      const completed = { ...room(), turns: [] }
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.rooms.get' ? { room: completed } : original(method, params)
      if (leave) render().back()
      expect(render().bots[0].status).toBe('idle')
      await render().openRoom(completed)
      expect(render().bots[0]).toMatchObject({
        status: 'idle',
        status_detail: { session_id: 's1', room_id: 'room', action: null }
      })
      expect(render().chat).toMatchObject({
        busy: false,
        waiting: false,
        approvals: [],
        questions: []
      })
      expect(render().chat.turns.s1.retryResolution).toMatchObject({
        sessionId: 's1',
        roomId: 'room',
        bot: 'alpha',
        resolved: true
      })
      await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
      expect(render().bots[0].status).toBe('idle')
    }
  )

  async function completedRoom() {
    await open()
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
    hooks.clients[0].emit(turnEvent('s1', 'complete'))
    expect(render().bots[0].status).toBe('idle')
    const completed = { ...room(), turns: [] }
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.rooms.get' ? { room: completed } : original(method, params)
    await render().openRoom(completed)
    return completed
  }

  describe('mobile held room snapshot completion', () => {
    async function runningRetry() {
      const initial = room()
      const beta = { ...failed, name: 'beta', status: 'idle' as const, status_detail: null }
      const current = {
        ...initial,
        members: [...initial.members, { ...initial.members[0], member_id: 'beta' }]
      }
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') return { bots: [failed, beta] }
        if (method === 'hexbot.rooms.list') return { rooms: [current] }
        return original(method, params)
      }
      await render().activate(daemon, 'token')
      await render().refresh()
      const catalog = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.get') return { room: current }
        if (method === 'hexbot.rooms.log') return { events: [] }
        if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
          throw new Error('Bot read unavailable')
        return catalog(method, params)
      }
      await render().openRoom(current)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
      expect(render().bots[0].status).toBe('working')
      return current
    }
    function complete() {
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      hooks.clients[0].emit(turnEvent('s1', 'complete'))
    }

    it.each(['get', 'log'].flatMap(read => [false, true].map(sending => [read, sending] as const)))(
      'preserves completion during held %s with send=%s',
      async (read, sending) => {
        let current = await runningRetry()
        const captured = current
        const held = deferred()
        const send = deferred()
        let pending = true
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === 'hexbot.rooms.send') return send.promise
          if (method === `hexbot.rooms.${read}` && pending) return held.promise
          if (method === 'hexbot.rooms.get') return { room: current }
          return original(method, params)
        }
        const rejection = sending
          ? expect(render().send('Next')).rejects.toThrow('Send rejected')
          : null
        render().back()
        const opening = render().openRoom(current)
        await flush()
        complete()
        current = { ...current, turns: [] }
        expect(render().bots[0].status).toBe('idle')
        held.resolve(read === 'get' ? { room: captured } : { events: [] })
        await opening
        pending = false
        try {
          expect(render().bots[0].status).toBe('idle')
          expect(render().chat).toMatchObject({
            busy: false,
            waiting: false,
            approvals: [],
            questions: []
          })
        } finally {
          if (sending) {
            send.reject(new Error('Send rejected'))
            await rejection
          }
        }
        if (sending) {
          expect(render().chat.busy).toBe(false)
          expect(render().bots[0].status).toBe('idle')
        }
        await render().openRoom(current)
        expect(render().bots[0].status).toBe('idle')
      }
    )

    it.each(['same-after-log', 'new-SID', 'foreign-SID'])(
      'retires completed proof for a genuinely current %s snapshot',
      async owner => {
        const current = await runningRetry()
        const held = deferred()
        const original = hooks.handler
        const read = owner === 'same-after-log' ? 'log' : 'get'
        const snapshot = {
          ...current,
          turns: [
            {
              bot: owner === 'foreign-SID' ? 'beta' : 'alpha',
              live_session_id: owner === 'new-SID' ? 'new-live' : 's1'
            }
          ]
        }
        hooks.handler = async (method, params) => {
          if (method === `hexbot.rooms.${read}`) return held.promise
          if (method === 'hexbot.rooms.get') return { room: snapshot }
          return original(method, params)
        }
        const opening = render().openRoom(current)
        await flush()
        complete()
        held.resolve(read === 'get' ? { room: snapshot } : { events: [] })
        await opening
        expect(render().bots[0].status).toBe('stopped')
        expect(render().chat.turns.s1?.retryResolution?.resolved).not.toBe(true)
        const sessionId = owner === 'new-SID' ? 'new-live' : 's1'
        expect(render().chat.turns[sessionId]).toMatchObject({ busy: true })
      }
    )

    it.each([false, true])(
      'preserves exact settlements before newer GET (fresh card=%s)',
      async fresh => {
        const current = await runningRetry()
        const held = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === 'hexbot.rooms.log') return held.promise
          if (method === 'hexbot.rooms.get') return { room: current }
          return original(method, params)
        }
        const opening = render().openRoom(current)
        await flush()
        hooks.clients[0].emit(wire('message.delta', { text: 'Old reply' }))
        const request = wire('clarify.request', {
          request_id: 'old',
          questions: [{ qid: 'q1', question: 'Next?', choices: [] }]
        })
        hooks.clients[0].emit(request)
        hooks.clients[0].emit(
          wire('clarify.resolved', {
            request_id: 'old',
            status: 'answered',
            answers: { q1: 'yes' }
          })
        )
        complete()
        if (fresh) {
          hooks.clients[0].emit(
            wire('clarify.request', {
              request_id: 'fresh',
              questions: [
                { qid: 'q1', question: 'First?', choices: [] },
                { qid: 'q2', question: 'Second?', choices: [] }
              ]
            })
          )
          hooks.clients[0].emit(
            wire('clarify.resolved', {
              request_id: 'fresh',
              status: 'waiting',
              answers: { q1: 'yes' }
            })
          )
        }
        held.resolve({ events: [] })
        await opening
        expect(render().bots[0].status).toBe('stopped')
        expect(render().chat.turns.s1).toMatchObject({
          busy: true,
          waiting: fresh,
          streaming: ''
        })
        expect(
          render().chat.questions.map(card => [card.requestId, card.questions.map(q => q.id)])
        ).toEqual(fresh ? [['fresh', ['q2']]] : [])
        const questions = render().chat.questions
        hooks.clients[0].emit(request)
        expect(render().chat).toMatchObject({ busy: true, waiting: fresh, questions })
      }
    )

    it.each(['approval', 'question'].flatMap(card => [false, true].map(left => ({ card, left }))))(
      'keeps newer owned $card after an older held answer (leave=$left)',
      async ({ card, left }) => {
        const current = await runningRetry()
        const old = wire('clarify.request', {
          request_id: 'old-batch',
          questions: [
            { qid: 'a', question: 'First?' },
            { qid: 'b', question: 'Second?' }
          ]
        })
        hooks.clients[0].emit(old)
        const ack = deferred()
        const log = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === 'clarify.respond') return ack.promise
          if (method === 'hexbot.rooms.log') return log.promise
          if (method === 'hexbot.rooms.get') return { room: current }
          return original(method, params)
        }
        const answer = render().answer('old-batch', 'a', 'local', 's1')
        if (left) render().back()
        const opening = render().openRoom(current)
        await flush()
        hooks.clients[0].emit(
          wire('clarify.resolved', {
            request_id: 'old-batch',
            status: 'answered',
            answers: { a: 'local', b: 'remote' }
          })
        )
        complete()
        hooks.clients[0].emit(turnEvent())
        hooks.clients[0].emit(wire('message.start', {}))
        const fresh =
          card === 'approval'
            ? wire('approval.request', {
                request_id: 'fresh',
                choices: ['once', 'deny'],
                command: 'pwd'
              })
            : wire('clarify.request', {
                request_id: 'fresh',
                questions: [
                  { qid: 'x', question: 'Next first?' },
                  { qid: 'y', question: 'Next second?' }
                ]
              })
        hooks.clients[0].emit(fresh)
        if (card === 'question')
          hooks.clients[0].emit(
            wire('clarify.resolved', {
              request_id: 'fresh',
              status: 'waiting',
              answers: { x: 'accepted' }
            })
          )
        ack.resolve({ status: 'waiting', answers: { a: 'local' } })
        await answer
        log.resolve({ events: [] })
        await opening
        const retained = render().chat.turns.s1
        expect(retained).toMatchObject({ busy: true, waiting: true })
        expect(retained.approvals.map(a => a.requestId)).toEqual(
          card === 'approval' ? ['fresh'] : []
        )
        expect(
          retained.questions.map(q => [q.requestId, q.questions.map(item => item.id)])
        ).toEqual(card === 'question' ? [['fresh', ['y']]] : [])
        expect(retained.settlements[JSON.stringify(['clarify', 's1', 'old-batch'])]).toMatchObject({
          answered: true,
          answers: { a: 'local', b: 'remote' }
        })
        const freshReceipt =
          retained.settlements[
            JSON.stringify([card === 'question' ? 'clarify' : 'approval', 's1', 'fresh'])
          ]
        expect(freshReceipt?.closed).not.toBe(true)
        if (card === 'question') expect(freshReceipt).toMatchObject({ answers: { x: 'accepted' } })
        hooks.clients[0].emit(old)
        hooks.clients[0].emit(fresh)
        expect(render().chat.turns.s1.approvals).toEqual(retained.approvals)
        expect(render().chat.turns.s1.questions).toEqual(retained.questions)
        expect(render().chat.turns.s1.settlements).toEqual(retained.settlements)
      }
    )

    it.each(['before-log', 'during-get', 'other-room', 'other-bot'])(
      'orders a null-SID failed startup against %s metadata',
      async order => {
        const current = await runningRetry()
        const newer = { ...current, turns: [{ bot: 'alpha', live_session_id: 'new-live' }] }
        const held = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === `hexbot.rooms.${order === 'during-get' ? 'get' : 'log'}`)
            return held.promise
          if (method === 'hexbot.rooms.get') return { room: newer }
          return original(method, params)
        }
        const opening = render().openRoom(current)
        await flush()
        for (const status of ['running', 'failed'])
          hooks.clients[0].emit({
            type: 'hexbot.rooms.turn',
            payload: {
              room_id: order === 'other-room' ? 'other-room' : 'room',
              bot: order === 'other-bot' ? 'beta' : 'alpha',
              live_session_id: null,
              status
            }
          })
        held.resolve(order === 'during-get' ? { room: newer } : { events: [] })
        await opening
        if (order === 'during-get') expect(render().chat.turns['new-live']).toBeUndefined()
        else expect(render().chat.turns['new-live']).toMatchObject({ bot: 'alpha', busy: true })
        expect(render().bots[0].status).toBe('stopped')
      }
    )

    it.each(['error', 'epoch', 'authority', 'delete'])(
      'retires completion received during the read on newer %s',
      async event => {
        const current = await runningRetry()
        const held = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) => {
          if (method === 'hexbot.rooms.get') return held.promise
          return original(method, params)
        }
        const opening = render().openRoom(current)
        await flush()
        complete()
        if (event === 'error') hooks.clients[0].emit(wire('error', { message: 'New failure' }))
        if (event === 'epoch')
          hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
        if (event === 'authority') {
          const pending = hooks.handler
          hooks.handler = async (method, params) =>
            method === 'hexbot.bots.get' ? { bot: failed } : pending(method, params)
          hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
          await flush()
        }
        if (event === 'delete')
          hooks.clients[0].emit({
            type: 'hexbot.rooms.changed',
            payload: { id: 'room', deleted: true }
          })
        held.resolve({ room: current })
        await opening
        expect(render().bots[0].status).toBe(event === 'delete' ? 'idle' : 'stopped')
        if (event === 'delete') {
          expect(render().route).toBeNull()
          expect(render().bots[0].status_detail).toBeNull()
        }
        expect(render().chat.turns.s1?.retryResolution?.resolved).not.toBe(true)
      }
    )
  })

  describe('mobile room send rollback', () => {
    const rejected = 'Room send rejected'
    const profiles = [
      failed,
      ...['beta', 'gamma'].map(name => ({
        ...failed,
        name,
        status: 'idle' as const,
        status_detail: null
      }))
    ]
    async function completedSendRoom(reopen = true) {
      const initial = room()
      let current = {
        ...initial,
        members: profiles.map(bot => ({ ...initial.members[0], member_id: bot.name }))
      }
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') return { bots: profiles }
        if (method === 'hexbot.rooms.list') return { rooms: [current] }
        return original(method, params)
      }
      await render().activate(daemon, 'token')
      await render().refresh()
      const catalog = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.get') return { room: current }
        if (method === 'hexbot.rooms.log') return { events: [] }
        if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
          throw new Error('Bot read unavailable')
        return catalog(method, params)
      }
      await render().openRoom(current)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      hooks.clients[0].emit(turnEvent('s1', 'complete'))
      expect(render().bots[0].status).toBe('idle')
      current = { ...current, turns: [] }
      if (reopen) await render().openRoom(current)
      return current
    }
    function rejectSend() {
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.rooms.send') throw new Error(rejected)
        return original(method, params)
      }
    }

    it.each([false, true])(
      'keeps completed retry inactive after rejected send (reopen=%s)',
      async reopen => {
        await completedSendRoom(reopen)
        rejectSend()
        const sending = render().send('Next')
        expect(render().chat.busy).toBe(true)
        await expect(sending).rejects.toThrow(rejected)
        expect(render().chat).toMatchObject({
          busy: false,
          waiting: false,
          error: rejected,
          approvals: [],
          questions: []
        })
        expect(render().chat.turns.s1).toMatchObject({ busy: false })
        expect(render().bots[0].status).toBe('idle')
      }
    )

    it.each(['empty', 'working', 'approval', 'question', 'error', 'mixed'])(
      'preserves current %s room turns when the send fails',
      async kind => {
        const completed = await completedSendRoom()
        if (kind === 'empty') {
          hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
          await render().openRoom(completed)
        } else {
          hooks.clients[0].emit(turnEvent('beta-live', 'running', 'beta'))
          if (kind === 'approval')
            hooks.clients[0].emit(
              wire('approval.request', { request_id: 'beta', choices: ['once'] }, 'beta-live')
            )
          if (kind === 'question')
            hooks.clients[0].emit(
              wire('clarify.request', { request_id: 'beta', question: 'Next?' }, 'beta-live')
            )
          if (['error', 'mixed'].includes(kind))
            hooks.clients[0].emit(wire('error', { message: 'Beta failed' }, 'beta-live'))
          if (kind === 'mixed') hooks.clients[0].emit(turnEvent('gamma-live', 'running', 'gamma'))
        }
        const before = render().chat
        rejectSend()
        await expect(render().send('Next')).rejects.toThrow(rejected)
        expect(render().chat).toMatchObject({
          busy: !['empty', 'error'].includes(kind),
          waiting: ['approval', 'question'].includes(kind),
          error: rejected
        })
        expect(render().chat.turns).toEqual(before.turns)
        expect(render().chat.approvals).toEqual(before.approvals)
        expect(render().chat.questions).toEqual(before.questions)
      }
    )

    it.each(['start', 'complete', 'wait', 'error'])(
      'uses the current turns after %s arrives during a held failed send',
      async event => {
        await completedSendRoom()
        if (['complete', 'error'].includes(event))
          hooks.clients[0].emit(turnEvent('beta-live', 'running', 'beta'))
        const held = deferred()
        const original = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.rooms.send' ? held.promise : original(method, params)
        const sending = render().send('Next')
        const rejection = expect(sending).rejects.toThrow(rejected)
        if (['start', 'wait'].includes(event))
          hooks.clients[0].emit(turnEvent('beta-live', 'running', 'beta'))
        if (event === 'wait')
          hooks.clients[0].emit(
            wire('clarify.request', { request_id: 'beta', question: 'Next?' }, 'beta-live')
          )
        if (event === 'complete') {
          hooks.clients[0].emit(wire('message.complete', { text: 'Done' }, 'beta-live'))
          hooks.clients[0].emit(turnEvent('beta-live', 'complete', 'beta'))
        }
        if (event === 'error')
          hooks.clients[0].emit(wire('error', { message: 'Beta failed' }, 'beta-live'))
        const before = render().chat
        held.reject(new Error(rejected))
        await rejection
        expect(render().chat).toMatchObject({
          busy: ['start', 'wait'].includes(event),
          waiting: event === 'wait',
          error: rejected
        })
        expect(render().chat.turns).toEqual(before.turns)
        expect(render().chat.questions).toEqual(before.questions)
      }
    )

    it('does not revive retry proof after an epoch change during a held failed send', async () => {
      await completedSendRoom()
      const held = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.rooms.send' ? held.promise : original(method, params)
      const rejection = expect(render().send('Next')).rejects.toThrow(rejected)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      held.reject(new Error(rejected))
      await rejection
      expect(render().chat).toMatchObject({ busy: false, error: rejected })
      expect(render().chat.turns.s1.retryResolution).toBeUndefined()
      expect(render().bots[0].status).toBe('stopped')
    })

    it('keeps private send failure behavior and removes its optimistic message', async () => {
      await openStopped(failed)
      hooks.clients[0].emit(wire('message.complete', { text: 'Done' }))
      const messages = render().chat.messages
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'prompt.submit') throw new Error('Private send rejected')
        return original(method, params)
      }
      await expect(render().send('Next')).rejects.toThrow('Private send rejected')
      expect(render().chat).toMatchObject({ busy: false, error: 'Private send rejected', messages })
    })
  })

  it.each(['new-live', 's1'])(
    'retires completed Retry when the reopened snapshot has a new bot turn at %s',
    async sessionId => {
      await completedRoom()
      const current = room(sessionId)
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.rooms.get' ? { room: current } : original(method, params)
      await render().openRoom(current)
      expect(render().bots[0].status).toBe('stopped')
      expect(render().chat.turns[sessionId]).toMatchObject({ busy: true })
      expect(render().chat.turns[sessionId].retryResolution).toBeUndefined()
      hooks.clients[0].emit(wire('message.start', {}, sessionId))
      expect(render().bots[0].status).toBe('stopped')
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, sessionId))
      expect(render().bots[0].status).toBe('working')
    }
  )

  it('does not replace another bot current owner of the completed SID', async () => {
    await completedRoom()
    const current = { ...room(), turns: [{ bot: 'beta', live_session_id: 's1' }] }
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.rooms.get' ? { room: current } : original(method, params)
    await render().openRoom(current)
    expect(render().bots[0].status).toBe('stopped')
    expect(render().chat.turns.s1).toMatchObject({ bot: 'beta', busy: true })
    expect(render().chat.turns.s1.retryResolution).toBeUndefined()
  })

  it('keeps completed room proof inert until a trusted running turn reuses its SID', async () => {
    const completed = await completedRoom()
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    hooks.clients[0].emit(wire('approval.request', { request_id: 'old', choices: ['once'] }))
    hooks.clients[0].emit(wire('clarify.request', { request_id: 'old', question: 'Next?' }))
    hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }))
    expect(render().bots[0].status).toBe('idle')
    expect(render().chat).toMatchObject({
      busy: false,
      waiting: false,
      approvals: [],
      questions: []
    })
    render().back()
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    expect(render().bots[0].status).toBe('idle')
    await render().openRoom(completed)
    hooks.clients[0].emit(turnEvent())
    expect(render().bots[0].status).toBe('stopped')
    expect(render().chat.turns.s1).toMatchObject({ busy: true })
    expect(render().chat.turns.s1.retryResolution).toBeUndefined()
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
    expect(render().bots[0].status).toBe('working')
  })

  it('preserves completed proof beside another bot current turn and pending card', async () => {
    await completedRoom()
    const current = { ...room(), turns: [{ bot: 'beta', live_session_id: 'beta-live' }] }
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.rooms.get' ? { room: current } : original(method, params)
    await render().openRoom(current)
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit(
      wire('clarify.request', { request_id: 'beta', question: 'Next?' }, 'beta-live')
    )
    expect(render().bots[0].status).toBe('idle')
    expect(render().chat.questions.map(card => card.sessionId)).toEqual(['beta-live'])
  })

  it.each([
    'error',
    'status-error',
    'interrupted',
    'room-failed',
    'incident',
    'epoch',
    'scoped-read',
    'full-read',
    'archive',
    'bot-delete',
    'changed-owner',
    'changed-room-owner',
    'removed-member',
    'missing-member',
    'room-delete'
  ])('retires reopened completed proof on %s', async control => {
    const completed = await completedRoom()
    expect(render().bots[0].status).toBe('idle')
    if (['archive', 'removed-member', 'missing-member', 'changed-room-owner'].includes(control)) {
      const inactive = {
        ...completed,
        owner_id: control === 'changed-room-owner' ? 'new-owner' : 'owner',
        archived_at: control === 'archive' ? 12 : null,
        members:
          control === 'removed-member'
            ? [{ member_kind: 'bot', member_id: 'alpha', left_at: 12 }]
            : control === 'missing-member'
              ? [{ member_kind: 'bot', member_id: 'beta', left_at: null }]
              : completed.members
      } as unknown as Room
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.rooms.get' ? { room: inactive } : original(method, params)
      await render().openRoom(inactive)
      hooks.handler = async (method, params) =>
        method === 'hexbot.rooms.get' ? { room: completed } : original(method, params)
    } else if (control === 'scoped-read') {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: failed } : original(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    } else if (['full-read', 'changed-owner'].includes(control)) {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.list'
          ? { bots: [{ ...failed, owner_id: control === 'changed-owner' ? 'new-owner' : 'owner' }] }
          : method === 'hexbot.rooms.list'
            ? { rooms: [completed] }
            : original(method, params)
      await render().refresh()
    } else if (control === 'epoch')
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    else if (control === 'room-failed') hooks.clients[0].emit(turnEvent('s1', 'failed'))
    else if (control === 'incident')
      hooks.clients[0].emit({ type: 'hexbot.bots.incident', payload: { bot: 'alpha' } })
    else if (control === 'bot-delete')
      hooks.clients[0].emit({
        type: 'hexbot.bots.changed',
        payload: { name: 'alpha', deleted: true }
      })
    else if (control === 'room-delete')
      hooks.clients[0].emit({
        type: 'hexbot.rooms.changed',
        payload: { id: 'room', deleted: true }
      })
    else
      hooks.clients[0].emit(
        control === 'error'
          ? wire('error', { message: 'New failure' })
          : wire('status.update', { kind: control === 'interrupted' ? 'interrupted' : 'error' })
      )
    await flush()
    expect(render().bots[0].status).toBe(control === 'room-delete' ? 'idle' : 'stopped')
    await render().openRoom(completed)
    expect(render().bots[0].status).toBe(control === 'room-delete' ? 'idle' : 'stopped')
    if (control === 'room-delete') {
      expect(render().route).toBeNull()
      expect(render().error).toBe('This room was deleted.')
      expect(render().bots[0].status_detail).toBeNull()
    }
    expect(render().chat.turns.s1?.retryResolution?.resolved).not.toBe(true)
  })

  it('keeps known sibling requests above a resolved room failure without changing another bot', async () => {
    await open()
    hooks.clients[0].emit(wire('clarify.request', { request_id: 'sibling', question: 'Next?' }))
    hooks.clients[0].emit(turnEvent('new-live'))
    hooks.clients[0].emit(turnEvent('beta-live', 'running', 'beta'))
    hooks.clients[0].emit(
      wire('approval.request', { request_id: 'beta', choices: ['once'] }, 'beta-live')
    )
    hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 'new-live'))
    expect(render().bots[0]).toMatchObject({
      status: 'needs_you',
      status_detail: { session_id: 's1', room_id: 'room' }
    })
    expect(render().chat.questions.map(card => card.requestId)).toEqual(['sibling'])
    expect(render().chat.approvals.map(card => card.sessionId)).toEqual(['beta-live'])
  })

  it.each(['error', 'failed-complete', 'incident', 'room-failed', 'epoch', 'authority', 'delete'])(
    'retires accepted room Retry proof on %s',
    async control => {
      await open()
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }))
      expect(render().bots[0].status).toBe('working')
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      expect(render().bots[0].status).toBe('working')
      if (control === 'authority') {
        const original = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.bots.get' ? { bot: failed } : original(method, params)
        hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      } else if (control === 'epoch')
        hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
      else if (control === 'delete')
        hooks.clients[0].emit({
          type: 'hexbot.rooms.changed',
          payload: { id: 'room', deleted: true }
        })
      else if (control === 'incident')
        hooks.clients[0].emit({
          type: 'hexbot.bots.incident',
          payload: { bot: 'alpha', session_id: 's1', section_id: 'room-conversation' }
        })
      else if (control === 'room-failed') hooks.clients[0].emit(turnEvent('s1', 'failed'))
      else
        hooks.clients[0].emit(
          control === 'error'
            ? wire('error', { message: 'New failure' })
            : wire('message.complete', { status: 'error', error: 'New failure' })
        )
      await flush()
      expect(render().bots[0].status).toBe(control === 'delete' ? 'idle' : 'stopped')
      if (control === 'delete') {
        expect(render().route).toBeNull()
        expect(render().bots[0].status_detail).toBeNull()
      }
    }
  )
})

describe('mobile verified private Retry rollover', () => {
  it.each([false, true])(
    'resolves the same stored section after reopen (buffered=%s)',
    async buffered => {
      const cached = { ...stoppedBot, owner_id: 'owner' }
      await unopened(cached)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      const statusRead = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open')
          return { section: section('section', 'new-live'), messages: [] }
        if (method === 'session.status')
          return buffered ? statusRead.promise : { status: 'working' }
        if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
          throw new Error('Bot read unavailable')
        return original(method, params)
      }
      const opening = render().openSection(cached, section())
      if (buffered) await flush()
      else await opening
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 'old-live'))
      expect(render().bots[0].status).toBe('stopped')
      hooks.clients[0].emit(wire('message.start', { retry_resolved: true }, 'new-live'))
      if (buffered) {
        statusRead.resolve({ status: 'working' })
        await opening
      }
      expect(status()).toBe('working')
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: {
          session_id: 'new-live',
          section_id: 'section',
          room_id: null,
          action: null
        }
      })
      await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
      expect(status()).toBe('working')
      render().back()
      expect(render().bots[0].status).toBe('working')
      await render().openSection(cached, section())
      expect(status()).toBe('working')
      const held = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: cached } : held(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      expect(status()).toBe('stopped')
    }
  )
})

describe('mobile retained partial cards', () => {
  const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
  const room = {
    id: 'room',
    members: [],
    turns: [{ bot: 'alpha', live_session_id: 's1' }]
  } as unknown as Room
  const batch = {
    request_id: 'batch',
    questions: [
      { qid: 'first', question: 'When?' },
      { qid: 'second', question: 'Where?' }
    ]
  }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  async function open(place: string) {
    await unopened(idle)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Bot read unavailable')
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      return original(method, params)
    }
    if (place === 'private') await render().openSection(idle, section())
    else await render().openRoom(room)
    hooks.clients[0].emit(
      wire('clarify.request', {
        ...batch,
        bot: 'alpha',
        section_id: place === 'private' ? 'section' : 'room-conversation'
      })
    )
  }
  it.each(
    ['private', 'room'].flatMap(place =>
      [false, true].flatMap(canonical =>
        [false, true].map(left => [place, canonical, left] as const)
      )
    )
  )(
    'keeps remaining cards from %s after a partial answer (canonical=%s,left=%s)',
    async (place, canonical, left) => {
      await open(place)
      const response = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'clarify.respond' ? response.promise : original(method, params)
      const answering = render().answer('batch', 'first', 'Typed', 's1')
      if (left) render().back()
      response.resolve(
        canonical
          ? { status: 'waiting', answers: { first: 'Canonical' }, remaining: ['second'] }
          : { status: 'waiting' }
      )
      await answering
      await flush()
      if (!left) {
        const turn = place === 'private' ? render().chat : render().chat.turns.s1
        expect(turn.questions[0].questions.map(q => q.id)).toEqual(['second'])
        expect(turn).toMatchObject({ waiting: true, resumedWaiting: false })
        render().back()
      }
      await expect(render().refresh()).rejects.toThrow('Bot read unavailable')
      expect(render().bots[0]).toMatchObject({
        status: 'needs_you',
        status_detail: { session_id: 's1', room_id: place === 'room' ? 'room' : null }
      })
      const held = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open')
          return { section: section(), messages: [], pending_clarify: batch }
        return held(method, params)
      }
      if (place === 'private') await render().openSection(idle, section())
      else await render().openRoom(room)
      hooks.clients[0].emit(wire('clarify.request', batch))
      const turn = place === 'private' ? render().chat : render().chat.turns.s1
      expect(turn.questions[0].questions.map(q => q.id)).toEqual(['second'])
      expect(turn).toMatchObject({ waiting: true, resumedWaiting: false })
      const current = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'clarify.respond'
          ? canonical
            ? { status: 'answered', answers: { first: 'Canonical', second: 'Here' } }
            : { status: 'answered' }
          : current(method, params)
      await render().answer('batch', 'second', 'Here', 's1')
      expect(render().chat.questions).toEqual([])
      expect(render().bots[0].status).toBe('working')
      render().back()
      expect(render().bots[0].status).toBe('working')
    }
  )

  async function partial(place = 'private') {
    await open(place)
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'clarify.respond'
        ? { status: 'waiting', answers: { first: 'Canonical' } }
        : original(method, params)
    await render().answer('batch', 'first', 'Typed', 's1')
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
  }
  it.each(['private', 'room'])(
    'keeps failed answer RPC cards actionable in %s without resumed proof',
    async place => {
      await open(place)
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'clarify.respond') throw new Error('Answer unavailable')
        return original(method, params)
      }
      await expect(render().answer('batch', 'first', 'Typed', 's1')).rejects.toThrow(
        'Answer unavailable'
      )
      const turn = place === 'private' ? render().chat : render().chat.turns.s1
      expect(turn.questions[0].questions.map(q => q.id)).toEqual(['first', 'second'])
      expect(turn.resumedWaiting).toBe(false)
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    }
  )
  it.each(
    ['private', 'room'].flatMap(place =>
      [
        'start',
        'complete',
        'error',
        'idle',
        'interrupted',
        'epoch',
        'source',
        'delete',
        'archive',
        'full-read',
        'scoped-read',
        'missing-bot'
      ].map(control => [place, control] as const)
    )
  )('retires retained partial cards in %s on %s', async (place, control) => {
    await partial(place)
    if (control === 'full-read' || control === 'missing-bot') {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.list'
          ? { bots: control === 'missing-bot' ? [] : [idle] }
          : original(method, params)
      await render().refresh()
    } else if (control === 'scoped-read') {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: idle } : original(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    } else if (control === 'source') {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.list' ? { bots: [idle] } : original(method, params)
      await render().activate({ ...daemon, id: 'other' }, 'token')
      await render().refresh()
    } else if (control === 'epoch') {
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    } else if (control === 'delete')
      hooks.clients[0].emit({
        type: place === 'private' ? 'hexbot.sections.changed' : 'hexbot.rooms.changed',
        payload: { id: place === 'private' ? 'section' : 'room', bot: 'alpha', deleted: true }
      })
    else if (control === 'archive') {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.sections.archive'
          ? { section: { ...section(), archived_at: 1 } }
          : original(method, params)
      if (place === 'private') await render().rpc('hexbot.sections.archive', { id: 'section' })
      else hooks.clients[0].emit(wire('status.update', { kind: 'idle' }))
    } else
      hooks.clients[0].emit(
        control === 'start'
          ? wire('message.start', {})
          : control === 'complete'
            ? wire('message.complete', {})
            : control === 'error'
              ? wire('error', { message: 'Failed' })
              : wire('status.update', { kind: control })
      )
    await flush()
    expect(render().bots[0]?.status ?? 'idle').toBe('idle')
  })
  it.each(['unknown', 'other-sid'])(
    'keeps confirmed cards unchanged after an invalid %s answer',
    async control => {
      await open('private')
      const beforeAnswers = structuredClone(render().chat.settlements)
      const requests: string[] = []
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'clarify.respond') requests.push(method)
        return original(method, params)
      }
      await render().answer(
        control === 'unknown' ? 'unknown' : 'batch',
        'first',
        'Typed',
        control === 'other-sid' ? 's2' : 's1'
      )
      expect(requests).toEqual([])
      expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['first', 'second'])
      expect(render().chat.resumedWaiting).toBe(false)
      expect(render().chat.settlements).toEqual(beforeAnswers)
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    }
  )
  it('keeps hidden partial cards through archive, accepted archived Idle, and restore', async () => {
    await partial()
    let archived = true
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
        return { section: { ...section(), archived_at: archived ? 1 : null } }
      if (method === 'hexbot.sections.list')
        return { sections: [{ ...section(), archived_at: archived ? 1 : null }] }
      return original(method, params)
    }
    await render().rpc('hexbot.sections.archive', { id: 'section' })
    expect(render().bots[0].status).toBe('idle')
    const held = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? { bots: [idle] } : held(method, params)
    await render().refresh()
    expect(render().bots[0].status).toBe('idle')
    hooks.handler = held
    archived = false
    await render().rpc('hexbot.sections.unarchive', { id: 'section' })
    await flush()
    expect(render().bots[0]).toMatchObject({
      status: 'needs_you',
      status_detail: { session_id: 's1', section_id: 'section' }
    })
    await render().openSection(idle, section())
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['second'])
    expect(render().chat.resumedWaiting).toBe(false)
  })
  it.each(['local-newer', 'remote-before'])(
    'honors archived card/read ordering for %s',
    async order => {
      await partial()
      let archived = order === 'remote-before'
      const response = deferred()
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
          return { section: { ...section(), archived_at: archived ? 1 : null } }
        if (method === 'hexbot.bots.list') return response.promise
        if (method === 'hexbot.sections.list')
          return { sections: [{ ...section(), archived_at: archived ? 1 : null }] }
        return original(method, params)
      }
      const reading = render().refresh()
      if (order === 'local-newer') {
        archived = true
        await render().rpc('hexbot.sections.archive', { id: 'section' })
      }
      response.resolve({ bots: [idle] })
      await reading
      expect(render().bots[0].status).toBe('idle')
      archived = false
      await render().rpc('hexbot.sections.unarchive', { id: 'section' })
      await flush()
      expect(render().bots[0].status).toBe(order === 'local-newer' ? 'idle' : 'needs_you')
    }
  )
  it('keeps a genuinely newer exact card through an older accepted roster but ignores another session', async () => {
    await partial()
    const roster = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.bots.list' ? roster.promise : original(method, params)
    const reading = render().refresh()
    hooks.clients[0].emit(
      wire('clarify.request', {
        request_id: 'new',
        question: 'Next?',
        bot: 'alpha',
        section_id: 'section'
      })
    )
    roster.resolve({ bots: [idle] })
    await reading
    expect(render().bots[0].status).toBe('needs_you')
    hooks.clients[0].emit(
      wire(
        'clarify.request',
        { request_id: 'new', question: 'Elsewhere?', bot: 'alpha', section_id: 'other' },
        'other-sid'
      )
    )
    expect(render().bots[0]).toMatchObject({
      status: 'needs_you',
      status_detail: { session_id: 's1', section_id: 'section' }
    })
    const current = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'clarify.respond'
        ? params.request_id === 'batch'
          ? { status: 'answered', answers: { first: 'Canonical', second: 'Here' } }
          : { status: 'answered' }
        : current(method, params)
    await render().openSection(idle, section())
    await render().answer('batch', 'second', 'Here', 's1')
    expect(status()).toBe('needs_you')
    await render().answer('new', 'new', 'This', 's1')
    expect(status()).toBe('working')
    render().back()
    expect(render().bots[0].status).toBe('working')
  })
  it('preserves canonical partial broadcasts, duplicate qids, other batches and sibling approvals', async () => {
    await open('private')
    hooks.clients[0].emit(
      wire('clarify.request', {
        ...batch,
        questions: [batch.questions[0], batch.questions[0], batch.questions[1]]
      })
    )
    hooks.clients[0].emit(wire('approval.request', { request_id: 'approval', choices: ['once'] }))
    hooks.clients[0].emit(wire('clarify.request', { request_id: 'other', question: 'Which?' }))
    const response = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'clarify.respond' ? response.promise : original(method, params)
    const answering = render().answer('batch', 'first', 'Typed', 's1')
    render().back()
    hooks.clients[0].emit(
      wire('clarify.resolved', {
        request_id: 'batch',
        answers: { first: 'Canonical' },
        status: 'waiting',
        bot: 'alpha',
        section_id: 'section'
      })
    )
    response.resolve({ status: 'waiting' })
    await answering
    expect(render().bots[0].status).toBe('needs_you')
    await render().openSection(idle, section())
    expect(
      render()
        .chat.questions.find(card => card.requestId === 'batch')
        ?.questions.map(q => q.id)
    ).toEqual(['second'])
    expect(render().chat.questions.map(card => card.requestId)).toEqual(['batch', 'other'])
    expect(render().chat.approvals.map(card => card.requestId)).toEqual(['approval'])
    expect(
      Object.values(render().chat.settlements).find(saved => saved.answers?.first)?.answers?.first
    ).toBe('Canonical')
    const current = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'clarify.respond')
        return params.request_id === 'batch'
          ? { status: 'answered', answers: { first: 'Canonical', second: 'Here' } }
          : { status: 'answered' }
      if (method === 'approval.respond') return { resolved: true }
      return current(method, params)
    }
    await render().answer('batch', 'second', 'Here', 's1')
    await render().answer('other', 'other', 'This', 's1')
    expect(render().bots[0].status).toBe('needs_you')
    await render().approval('approval', 'once', 's1')
    expect(render().chat).toMatchObject({
      questions: [],
      approvals: [],
      waiting: false,
      resumedWaiting: true
    })
    render().back()
    expect(render().bots[0].status).toBe('working')
  })
})

describe('mobile deleted room consumer', () => {
  const failed = {
    ...stoppedBot,
    status_detail: {
      ...stoppedBot.status_detail!,
      section_id: 'room-stored',
      room_id: 'failed-room',
      session_id: 'failed-live'
    }
  } as Bot
  const deleted = (id = 'failed-room') => ({
    type: 'hexbot.rooms.changed',
    payload: { id, deleted: true }
  })
  const room = (id = 'failed-room', live = false) =>
    ({
      id,
      archived_at: null,
      members: [{ member_kind: 'bot', member_id: 'alpha', left_at: null }],
      turns: live ? [{ bot: 'alpha', live_session_id: 'room-sibling' }] : []
    }) as unknown as Room
  async function setup(cached = failed) {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [cached] }
      if (method === 'hexbot.rooms.list') return { rooms: [room(), room('other-room', true)] }
      if (method === 'hexbot.rooms.get')
        return { room: room(String(params.id), params.id === 'other-room') }
      if (method === 'hexbot.rooms.log') return { events: [] }
      return original(method, params)
    }
    await render().activate(daemon, 'token')
    await render().refresh()
  }
  function unavailable() {
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.list' || method === 'hexbot.bots.get')
        throw new Error('Room read unavailable')
      return original(method, params)
    }
  }

  it.each(['closed', 'current', 'other-room', 'private'])(
    'retires a remotely deleted room and its Retry while %s is selected and refresh fails',
    async selected => {
      await setup()
      if (selected === 'current') await render().openRoom(room())
      if (selected === 'other-room') await render().openRoom(room('other-room'))
      if (selected === 'private') await render().openSection(failed, section())
      unavailable()
      hooks.clients[0].emit(deleted())
      await expect(render().refresh()).rejects.toThrow('Room read unavailable')
      expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
      expect(render().bots[0].status).toBe(
        selected === 'other-room' || selected === 'private' ? 'working' : 'idle'
      )
      expect(render().bots[0].status_detail?.action).toBeFalsy()
      if (selected === 'closed' || selected === 'current') expect(render().route).toBeNull()
      if (selected === 'other-room')
        expect(render().route).toMatchObject({ kind: 'room', room: { id: 'other-room' } })
      if (selected === 'private')
        expect(render().route).toMatchObject({ kind: 'section', section: { id: 'section' } })
    }
  )

  it('rejects a held full room list and never reopens a cached deleted room', async () => {
    await setup()
    const held = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.bots.list' ? held.promise : original(method, params)
    const reading = render().refresh()
    hooks.clients[0].emit(deleted())
    held.resolve({ bots: [failed] })
    await reading
    expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
    expect(render().bots[0].status).toBe('idle')
    await render().openRoom(room())
    expect(render().route).toBeNull()
    expect(render().error).toBe('This room was deleted.')
  })

  it.each(['hexbot.rooms.log', 'hexbot.rooms.get'])(
    'rejects a held %s open after deletion',
    async method => {
      await setup()
      const held = deferred()
      const original = hooks.handler
      hooks.handler = (name, params) => (name === method ? held.promise : original(name, params))
      const opening = render().openRoom(room())
      await flush()
      hooks.clients[0].emit(deleted())
      held.resolve(method === 'hexbot.rooms.log' ? { events: [] } : { room: room() })
      await opening
      expect(render().route).toBeNull()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('rejects a held targeted status read and accepts the later sibling status', async () => {
    await setup()
    const gets = holdBotGets()
    hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    hooks.clients[0].emit(deleted())
    gets[0].resolve({ bot: failed })
    await flush()
    expect(render().bots[0].status).toBe('idle')
    expect(gets).toHaveLength(2)
    const sibling = {
      ...failed,
      status: 'needs_you',
      status_detail: { ...namedWait.status_detail!, section_id: 'unseen', session_id: 'unseen' }
    } as Bot
    gets[1].resolve({ bot: sibling })
    await flush()
    expect(render().bots[0]).toEqual(sibling)
  })

  it.each(['private', 'room'])(
    'preserves the known %s sibling card or error when the failed room disappears',
    async place => {
      await setup()
      const sid = place === 'private' ? 's1' : 'room-sibling'
      if (place === 'private') await render().openSection(failed, section())
      else await render().openRoom(room('other-room', true))
      hooks.clients[0].emit(
        wire('clarify.request', { request_id: 'sibling', question: 'Where?' }, sid)
      )
      unavailable()
      hooks.clients[0].emit(deleted())
      expect(render().bots[0].status).toBe('needs_you')
      expect(render().chat.questions.map(card => card.requestId)).toEqual(['sibling'])
      hooks.clients[0].emit(wire('message.complete', { error: 'Sibling failed' }, sid))
      expect(render().bots[0]).toMatchObject({
        status: 'stopped',
        status_detail: { text: 'Sibling failed', action: null }
      })
    }
  )

  it.each(['connector', 'global', 'other-room', 'private'])(
    'preserves an independent %s status',
    async cause => {
      const cached = {
        ...failed,
        status_detail: {
          ...failed.status_detail!,
          room_id:
            cause === 'other-room' ? 'other-room' : cause === 'connector' ? 'failed-room' : null,
          section_id: cause === 'private' ? 'section' : null,
          action:
            cause === 'connector' ? { kind: 'fix_connector', connector: 'mail' } : { kind: 'retry' }
        }
      } as Bot
      await setup(cached)
      unavailable()
      hooks.clients[0].emit(deleted())
      expect(render().bots[0]).toEqual(cached)
    }
  )

  it('retains deletion within the epoch and permits a genuinely newer restarted inventory', async () => {
    await setup()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    await render().refresh()
    expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
    expect(render().bots[0].status).toBe('idle')
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    await render().refresh()
    expect(render().rooms.map(row => row.id)).toEqual(['failed-room', 'other-room'])
    expect(render().bots[0].status).toBe('stopped')
  })
  it.each(['working', 'needs_you'] as const)(
    'retires cached %s from the deleted room without touching private activity',
    async status => {
      await setup({ ...failed, status, status_detail: { ...failed.status_detail!, action: null } })
      unavailable()
      hooks.clients[0].emit(deleted())
      expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
      expect(render().bots[0]).toMatchObject({ status: 'idle', status_detail: null })
    }
  )

  it('verifies every bot whose cached status names the deleted room and preserves another room', async () => {
    await setup()
    const beta = { ...failed, name: 'beta' } as Bot
    const gamma = {
      ...failed,
      name: 'gamma',
      status_detail: { ...failed.status_detail!, room_id: 'other-room' }
    } as Bot
    const names: string[] = []
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [failed, beta, gamma] }
      if (method === 'hexbot.bots.get') {
        names.push(String(params.name))
        throw new Error('Unavailable')
      }
      return original(method, params)
    }
    await render().refresh()
    hooks.clients[0].emit({ ...deleted(), payload: { ...deleted().payload, bot: 'gamma' } })
    await flush()
    expect(names).toEqual(['alpha', 'beta'])
    expect(render().bots.map(row => row.status)).toEqual(['idle', 'idle', 'stopped'])
    expect(render().bots[2]).toEqual(gamma)
  })

  it.each([
    {},
    { id: '' },
    { id: 1 },
    { id: 'failed-room' },
    { id: 'failed-room', deleted: false }
  ])('never infers a room deletion from a noncanonical event %j', async payload => {
    await setup()
    unavailable()
    hooks.clients[0].emit({ type: 'hexbot.rooms.changed', payload })
    expect(render().rooms.map(row => row.id)).toEqual(['failed-room', 'other-room'])
    expect(render().bots[0]).toEqual(failed)
  })

  it('does not repeat verification or invalidate a useful read for the same deletion', async () => {
    await setup()
    const gets = holdBotGets()
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit(deleted())
    expect(gets).toHaveLength(1)
    const sibling = {
      ...failed,
      status: 'working',
      status_detail: { ...failed.status_detail!, action: null, room_id: 'other-room' }
    } as Bot
    gets[0].resolve({ bot: sibling })
    await flush()
    expect(gets).toHaveLength(1)
    expect(render().bots[0]).toEqual(sibling)
  })

  it('keeps the deleted room out after an unnamed bot invalidation and an unsuccessful aggregate refresh', async () => {
    await setup()
    unavailable()
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: {} })
    await expect(render().refresh()).rejects.toThrow('Room read unavailable')
    expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
    expect(render().bots[0]).toMatchObject({ status: 'idle', status_detail: null })
  })

  it('rejects an old-epoch snapshot even though a new epoch releases the tombstone', async () => {
    await setup()
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
    const held = deferred()
    const original = hooks.handler
    hooks.handler = (method, params) =>
      method === 'hexbot.bots.list' ? held.promise : original(method, params)
    const reading = render().refresh()
    hooks.clients[0].emit(deleted())
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'second' } })
    held.resolve({ bots: [{ ...failed, status: 'idle' }] })
    await reading
    expect(render().rooms.map(row => row.id)).toEqual(['other-room'])
    expect(render().bots[0].status).toBe('stopped')
    hooks.handler = original
    await render().refresh()
    expect(render().rooms.map(row => row.id)).toEqual(['failed-room', 'other-room'])
  })

  it('ignores deletion callbacks and held status replies from the previous daemon', async () => {
    await setup()
    const gets = holdBotGets()
    hooks.clients[0].emit(deleted())
    await render().activate({ ...daemon, id: 'other' }, 'token')
    await render().refresh()
    hooks.clients[0].emit(deleted())
    gets[0].resolve({ bot: { ...failed, status: 'idle' } })
    await flush()
    expect(render().rooms.map(row => row.id)).toEqual(['failed-room', 'other-room'])
    expect(render().bots[0]).toEqual(failed)
  })
})

describe('mobile unopened ordinary starts', () => {
  async function ordinary(indexed = true) {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    await unopened(idle)
    if (!indexed) {
      const original = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.sections.list' ? { sections: [] } : original(method, params)
      await render().refresh()
    }
    hooks.handler = async () => {
      throw new Error('Read unavailable')
    }
    return idle
  }
  const start = (marked = false) =>
    hooks.clients[0].emit(
      wire('message.start', {
        bot: 'alpha',
        section_id: 'section',
        room_id: null,
        ...(marked ? { retry_resolved: true } : {})
      })
    )

  it.each([false, true])(
    'projects Working with indexed=%s when the roster missed an ordinary turn',
    async indexed => {
      await ordinary(indexed)
      start()
      hooks.clients[0].emit(wire('status.update', { kind: 'working', text: 'Working' }))
      await flush()
      expect(render().route).toBeNull()
      expect(render().bots[0]).toMatchObject({
        status: 'working',
        status_detail: { session_id: 's1', section_id: 'section' }
      })
      hooks.clients[0].emit(wire('message.complete', { text: 'Finished' }))
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each([
    {},
    { bot: 'alpha', section_id: 'section' },
    { bot: 'alpha', section_id: 'section', room_id: 'room' },
    { bot: 'alpha', section_id: 'room:room', room_id: null },
    { bot: '', section_id: 'section', room_id: null }
  ])('ignores incomplete or room metadata %j', async payload => {
    await ordinary(false)
    hooks.clients[0].emit(wire('message.start', payload))
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['archived', 'deleted', 'foreign', 'newer session'] as const)(
    'preserves %s ownership guards',
    async guard => {
      const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
      const original = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.list') return { bots: [idle] }
        if (method === 'hexbot.sections.list')
          return {
            sections: [
              {
                ...section(),
                archived_at: guard === 'archived' ? 1 : null,
                bot: guard === 'foreign' ? 'other' : 'alpha',
                live_session_id: guard === 'newer session' ? 'newer-live' : 's1'
              }
            ]
          }
        return original(method, params)
      }
      await render().activate(daemon, 'token')
      await render().refresh()
      hooks.handler = async () => {
        throw new Error('Read unavailable')
      }
      if (guard === 'deleted')
        hooks.clients[0].emit({
          type: 'hexbot.sections.changed',
          payload: { id: 'section', deleted: true }
        })
      start()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each([false, true])('preserves old activity across same epoch=%s', async sameEpoch => {
    await ordinary(false)
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'epoch-a' } })
    start()
    expect(render().bots[0].status).toBe('working')
    hooks.clients[0].emit({
      type: 'gateway.ready',
      payload: { replay_epoch: sameEpoch ? 'epoch-a' : 'epoch-b' }
    })
    expect(render().bots[0].status).toBe(sameEpoch ? 'working' : 'idle')
  })

  it('retires activity after a successful later status read', async () => {
    const idle = await ordinary(false)
    start()
    expect(render().bots[0].status).toBe('working')
    hooks.handler = async method => (method === 'hexbot.bots.get' ? { bot: idle } : {})
    hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    await flush()
    expect(render().bots[0].status).toBe('idle')
  })

  it('preserves a newer start over an older in-flight roster', async () => {
    const idle = await ordinary(false)
    const older = deferred()
    hooks.handler = async method => {
      if (method === 'hexbot.bots.list') return older.promise
      if (method === 'hexbot.rooms.list') return { rooms: [] }
      if (method === 'hexbot.sections.list') return { sections: [] }
      if (method === 'hexbot.bots.get') throw new Error('Read unavailable')
      return {}
    }
    const refreshing = render().refresh()
    start()
    older.resolve({ bots: [idle] })
    await refreshing
    expect(render().bots[0].status).toBe('working')
  })

  it('keeps a confirmed sibling question ahead of a new ordinary start', async () => {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    await unopened(idle)
    await render().openSection(idle, section('other', 's2'))
    hooks.clients[0].emit(
      wire(
        'clarify.request',
        { request_id: 'question', question: 'Why?', bot: 'alpha', section_id: 'other' },
        's2'
      )
    )
    hooks.handler = async () => {
      throw new Error('Read unavailable')
    }
    start()
    expect(render().bots[0].status).toBe('needs_you')
    expect(render().chat.questions).toHaveLength(1)
  })

  it('accepts a fresh ordinary start after a verified live session rollover', async () => {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    await unopened(idle)
    start()
    expect(render().bots[0].status).toBe('working')
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.list'
        ? { sections: [section('section', 'newer-live')] }
        : original(method, params)
    await render().refresh()
    hooks.handler = async () => {
      throw new Error('Read unavailable')
    }
    hooks.clients[0].emit(
      wire('message.start', { bot: 'alpha', section_id: 'section', room_id: null }, 'newer-live')
    )
    expect(render().bots[0]).toMatchObject({
      status: 'working',
      status_detail: { session_id: 'newer-live' }
    })
    start()
    expect(render().bots[0].status_detail?.session_id).toBe('newer-live')
  })

  it('projects an ordinary start carrying the daemon retry-resolution marker', async () => {
    await ordinary(false)
    start(true)
    expect(render().bots[0].status).toBe('working')
    hooks.clients[0].emit(wire('message.complete', { text: 'Finished' }))
    expect(render().bots[0].status).toBe('idle')
  })
})

describe('mobile unanswered card retention', () => {
  type Place = 'private' | 'named room' | 'unnamed room'
  type Kind =
    | 'approval'
    | 'question'
    | 'batch'
    | 'partial'
    | 'duplicate question IDs'
    | 'unanswered duplicate IDs'
  async function prepare(place: Place = 'private', kind: Kind = 'question') {
    const room = {
      id: 'retained-room',
      name: 'Planning',
      owner_id: 'owner',
      archived_at: null,
      members: [{ member_kind: 'bot', member_id: 'alpha', left_at: null }],
      turns: [{ bot: 'alpha', live_session_id: 'room-live' }]
    } as unknown as Room
    const idle = {
      ...namedWait,
      status: 'idle',
      status_detail:
        place === 'named room'
          ? { session_id: 'room-live', room_id: room.id, section_id: null, action: null }
          : null
    } as Bot
    await unopened(idle)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      if (method === 'hexbot.rooms.list') return { rooms: [room] }
      return original(method, params)
    }
    await render().refresh()
    if (place === 'private') await render().openSection(idle, section('other', 's2'))
    else await render().openRoom(room)
    const sessionId = place === 'private' ? 's2' : 'room-live'
    const sectionId = place === 'private' ? 'other' : 'room-stored'
    const context = { bot: 'alpha', section_id: sectionId }
    const request =
      kind === 'approval'
        ? wire(
            'approval.request',
            { ...context, request_id: 'unanswered', choices: ['once', 'deny'] },
            sessionId
          )
        : wire(
            'clarify.request',
            {
              ...context,
              request_id: 'unanswered',
              questions:
                kind === 'question'
                  ? [{ qid: 'first', question: 'Why?' }]
                  : [
                      { qid: 'first', question: 'Why?' },
                      ...(kind === 'duplicate question IDs' || kind === 'unanswered duplicate IDs'
                        ? [{ qid: 'first', question: 'Same id?' }]
                        : []),
                      { qid: 'last', question: 'When?' }
                    ]
            },
            sessionId
          )
    const reading = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Roster unavailable')
      return reading(method, params)
    }
    hooks.clients[0].emit(request)
    if (kind === 'partial' || kind === 'duplicate question IDs')
      hooks.clients[0].emit(
        wire(
          'clarify.resolved',
          {
            ...context,
            request_id: 'unanswered',
            answers: { first: 'Here' },
            status: 'waiting',
            remaining: ['last']
          },
          sessionId
        )
      )
    const event = (type: string, payload: Record<string, unknown> = {}) =>
      hooks.clients[0].emit(wire(type, payload, sessionId))
    return { context, event, idle, kind, place, request, room, sectionId, sessionId, reading }
  }

  describe.each(['private', 'named room', 'unnamed room'] as const)('%s', place => {
    it.each([
      'approval',
      'question',
      'batch',
      'partial',
      'duplicate question IDs',
      'unanswered duplicate IDs'
    ] as const)('keeps a confirmed %s after leaving with an older Idle roster', async kind => {
      const f = await prepare(place, kind)
      expect(render().bots[0].status).toBe('needs_you')
      const before = render().chat
      render().back()
      await expect(render().refresh()).rejects.toThrow('Roster unavailable')
      expect(render().bots[0]).toMatchObject({
        status: 'needs_you',
        status_detail: {
          session_id: f.sessionId,
          ...(place === 'private' ? { section_id: f.sectionId } : { room_id: f.room.id })
        }
      })
      if (place === 'private') await render().openSection(f.idle, section('other', 's2'))
      else await render().openRoom(f.room)
      expect(render().chat.approvals).toEqual(before.approvals)
      expect(render().chat.questions).toEqual(before.questions)
      if (kind === 'partial' || kind === 'duplicate question IDs')
        expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['last'])
      if (kind === 'unanswered duplicate IDs')
        expect(render().chat.questions[0].questions.map(q => q.id)).toEqual([
          'first',
          'first',
          'last'
        ])
    })

    it.each(['approval', 'question'] as const)(
      'settles a retained %s after leaving and completion retires its activity',
      async kind => {
        const f = await prepare(place, kind)
        render().back()
        f.event(kind === 'approval' ? 'approval.resolved' : 'clarify.resolved', {
          ...f.context,
          request_id: 'unanswered',
          ...(kind === 'approval'
            ? { choice: 'once' }
            : { answers: { first: 'Yes' }, status: 'answered' })
        })
        expect(render().bots[0].status).toBe('working')
        f.event('message.complete', { text: 'Done' })
        expect(render().bots[0].status).toBe('idle')
      }
    )

    it('retains the remaining question when another connected client answers only the first', async () => {
      const f = await prepare(place, 'batch')
      render().back()
      f.event('clarify.resolved', {
        ...f.context,
        request_id: 'unanswered',
        answers: { first: 'Here' },
        status: 'waiting',
        remaining: ['last']
      })
      expect(render().bots[0].status).toBe('needs_you')
      if (place === 'private') await render().openSection(f.idle, section('other', 's2'))
      else await render().openRoom(f.room)
      expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['last'])
    })

    it.each([true, false])('keeps proof only across same epoch=%s', async sameEpoch => {
      await prepare(place)
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'first' } })
      render().back()
      hooks.clients[0].emit({
        type: 'gateway.ready',
        payload: { replay_epoch: sameEpoch ? 'first' : 'second' }
      })
      expect(render().bots[0].status).toBe(sameEpoch ? 'needs_you' : 'idle')
    })

    it('lets a newer successful status read retire the cached card proof without making duplicate replay fresh', async () => {
      const f = await prepare(place)
      const failed = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.bots.get' ? { bot: f.idle } : failed(method, params)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      hooks.clients[0].emit(f.request)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    })
  })

  it('does not retain stale private-session cards after an accepted newer binding', async () => {
    const f = await prepare()
    const prior = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [f.idle] }
      if (method === 'hexbot.sections.list') return { sections: [section('other', 'newer-live')] }
      return prior(method, params)
    }
    await render().refresh()
    f.event('clarify.request', { ...f.context, request_id: 'late-old', question: 'Late?' })
    render().back()
    expect(render().bots[0].status).toBe('idle')
  })

  it('retains a pending clarification learned from an accepted private open snapshot', async () => {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    await unopened(idle)
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.open')
        return {
          section: section('other', 's2'),
          messages: [],
          pending_clarify: {
            request_id: 'snapshot',
            questions: [{ qid: 'first', question: 'Why?' }]
          }
        }
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Roster unavailable')
      return original(method, params)
    }
    await render().openSection(idle, section('other', 's2'))
    expect(render().chat.questions.map(q => q.requestId)).toEqual(['snapshot'])
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it('does not renew snapshot cards over a newer successful status read', async () => {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    await unopened(idle)
    const snapshot = deferred()
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.open') return snapshot.promise
      if (method === 'hexbot.bots.get') return { bot: idle }
      if (method === 'hexbot.bots.list') throw new Error('Roster unavailable')
      return original(method, params)
    }
    const opening = render().openSection(idle, section('other', 's2'))
    await flush()
    hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
    await flush()
    snapshot.resolve({
      section: section('other', 's2'),
      messages: [],
      pending_clarify: { request_id: 'snapshot', question: 'Why?' }
    })
    await opening
    expect(render().chat.questions).toHaveLength(1)
    render().back()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['delete', 'archive', 'target'] as const)(
    'retires confirmed private cards on %s',
    async control => {
      const f = await prepare()
      render().back()
      if (control === 'delete')
        hooks.clients[0].emit({
          type: 'hexbot.sections.changed',
          payload: { id: 'other', deleted: true }
        })
      else if (control === 'archive') {
        const prior = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.sections.archive'
            ? { section: { ...section('other', 's2'), archived_at: 1 } }
            : prior(method, params)
        await render().rpc('hexbot.sections.archive', { id: 'other' })
      } else {
        hooks.handler = f.reading
        await render().activate({ ...daemon, id: 'next' }, 'token')
        await render().refresh()
        hooks.clients[0].emit(f.request)
      }
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('restores hidden unanswered private cards without inventing an answer', async () => {
    const f = await prepare('private', 'batch')
    render().back()
    const prior = hooks.handler
    let archived = true
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive')
        return { section: { ...section('other', 's2'), archived_at: archived ? 1 : null } }
      return prior(method, params)
    }
    await render().rpc('hexbot.sections.archive', { id: 'other' })
    expect(render().bots[0].status).toBe('idle')
    archived = false
    await render().rpc('hexbot.sections.unarchive', { id: 'other' })
    expect(render().bots[0].status).toBe('needs_you')
    await render().openSection(f.idle, section('other', 's2'))
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['first', 'last'])
    expect(Object.values(render().chat.settlements)).toEqual([{ answers: {} }])
    expect(render().chat.resumedWaiting).toBe(false)
  })

  it('keeps sibling requests ahead of ordinary Working after both conversations close', async () => {
    const f = await prepare()
    render().back()
    hooks.clients[0].emit(
      wire('message.start', { bot: 'alpha', section_id: 'section', room_id: null }, 's1')
    )
    expect(render().bots[0].status).toBe('needs_you')
    f.event('clarify.resolved', {
      ...f.context,
      request_id: 'unanswered',
      status: 'answered',
      answers: { first: 'Here' }
    })
    expect(render().bots[0].status).toBe('working')
  })

  it.each(['approval', 'question'] as const)(
    'does not let a replaced room session retain its old %s',
    async kind => {
      const f = await prepare('unnamed room', kind)
      render().back()
      hooks.clients[0].emit({
        type: 'hexbot.rooms.turn',
        payload: {
          room_id: f.room.id,
          bot: 'alpha',
          live_session_id: 'new-room-live',
          status: 'running'
        }
      })
      expect(render().bots[0].status).not.toBe('needs_you')
    }
  )

  it('keeps distinct request IDs independent while both conversations are closed', async () => {
    const f = await prepare()
    f.event('approval.request', { ...f.context, request_id: 'approval', choices: ['once', 'deny'] })
    f.event('clarify.request', {
      ...f.context,
      request_id: 'second-batch',
      questions: [{ qid: 'first', question: 'Different batch?' }]
    })
    render().back()
    f.event('clarify.resolved', {
      ...f.context,
      request_id: 'unanswered',
      status: 'answered',
      answers: { first: 'Here' }
    })
    expect(render().bots[0].status).toBe('needs_you')
    f.event('approval.resolved', { ...f.context, request_id: 'approval', choice: 'once' })
    expect(render().bots[0].status).toBe('needs_you')
    f.event('clarify.resolved', {
      ...f.context,
      request_id: 'second-batch',
      status: 'answered',
      answers: { first: 'This' }
    })
    expect(render().bots[0].status).toBe('working')
  })

  it('keeps a different room sibling pending when a same-bot room turn is replaced', async () => {
    const f = await prepare('unnamed room')
    render().back()
    const sibling = {
      ...f.room,
      id: 'other-room',
      turns: [{ bot: 'alpha', live_session_id: 'other-room-live' }]
    }
    const prior = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.rooms.get' && params.id === sibling.id
        ? { room: sibling }
        : prior(method, params)
    await render().openRoom(sibling)
    hooks.clients[0].emit(
      wire(
        'approval.request',
        { bot: 'alpha', section_id: 'other-room-stored', request_id: 'sibling', choices: ['once'] },
        'other-room-live'
      )
    )
    render().back()
    hooks.clients[0].emit({
      type: 'hexbot.rooms.turn',
      payload: {
        room_id: f.room.id,
        bot: 'alpha',
        live_session_id: 'new-room-live',
        status: 'running'
      }
    })
    expect(render().bots[0].status).toBe('needs_you')
    expect(render().bots[0].status_detail?.session_id).toBe('other-room-live')
  })
})

describe('mobile buffered card receipt retention', () => {
  type Place = 'private' | 'named room' | 'unnamed room'
  type Kind = 'approval' | 'question'
  type Read = 'get' | 'list'
  async function pending(
    place: Place = 'private',
    kind: Kind = 'question',
    history?: Record<string, unknown>
  ) {
    const room = {
      id: 'buffer-room',
      owner_id: 'owner',
      archived_at: null,
      members: [{ member_kind: 'bot', member_id: 'alpha', left_at: null }],
      turns: [{ bot: 'alpha', live_session_id: 'room-live' }]
    } as unknown as Room
    const idle = {
      ...namedWait,
      status: 'idle',
      status_detail:
        place === 'named room'
          ? { room_id: room.id, session_id: 'room-live', section_id: null, action: null }
          : null
    } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') return { bots: [idle] }
      if (method === 'hexbot.rooms.list') return { rooms: [room] }
      if (method === 'hexbot.rooms.get') return { room }
      if (method === 'hexbot.rooms.log') return { events: [] }
      return original(method, params)
    }
    await render().activate(daemon, 'token')
    await render().refresh()
    const held = deferred(),
      readReply = deferred()
    const before = hooks.handler
    let read: Read = 'get'
    let overlap = false
    let allowedReads = 0
    let currentRoom = room
    let snapshot = history
    let currentSection = section()
    let statusCalls = 0
    let secondStatus: ReturnType<typeof deferred> | undefined
    hooks.handler = async (method, params) => {
      if (method === (place === 'private' ? 'session.status' : 'hexbot.rooms.get')) {
        if (++statusCalls === 1) return held.promise
        return (
          secondStatus?.promise ??
          (place === 'private' ? { status: 'working' } : { room: currentRoom })
        )
      }
      if (method === 'hexbot.sections.open')
        return { section: currentSection, messages: [], pending_clarify: snapshot }
      if (
        method === (read === 'get' ? 'hexbot.bots.get' : 'hexbot.bots.list') &&
        allowedReads-- > 0
      )
        return overlap ? readReply.promise : read === 'get' ? { bot: idle } : { bots: [idle] }
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Read unavailable')
      return before(method, params)
    }
    const opening =
      place === 'private' ? render().openSection(idle, section()) : render().openRoom(room)
    await flush()
    const sessionId = place === 'private' ? 's1' : 'room-live'
    const context = { bot: 'alpha', section_id: place === 'private' ? 'section' : 'room-stored' }
    const frame = (requestId = 'buffer-card', otherKind: Kind = kind) =>
      wire(
        otherKind === 'approval' ? 'approval.request' : 'clarify.request',
        {
          ...context,
          request_id: requestId,
          ...(otherKind === 'approval'
            ? { choices: ['once', 'deny'] }
            : {
                questions: [
                  { qid: 'first', question: 'Why?' },
                  { qid: 'last', question: 'When?' }
                ]
              })
        },
        sessionId
      )
    const card = (id = 'buffer-card', type: Kind = kind) => hooks.clients[0].emit(frame(id, type))
    const reading = async (mode: Read = 'get', heldRead = false) => {
      read = mode
      overlap = heldRead
      allowedReads = 1
      const action =
        mode === 'get'
          ? (hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } }),
            Promise.resolve())
          : render().refresh()
      await flush()
      return { action }
    }
    const finish = async () => {
      held.resolve(place === 'private' ? { status: 'working' } : { room: currentRoom })
      await opening
    }
    const event = (type: string, payload: Record<string, unknown> = {}, sid = sessionId) =>
      hooks.clients[0].emit(wire(type, payload, sid))
    return {
      idle,
      room,
      context,
      sessionId,
      card,
      frame,
      event,
      reading,
      finish,
      readReply,
      opening,
      setSection: (value: Section) => {
        currentSection = value
      },
      setSnapshot: (value: Record<string, unknown>) => {
        snapshot = value
      },
      holdReread: () => {
        secondStatus = deferred()
        return secondStatus
      },
      statusCalls: () => statusCalls,
      setRoom: (value: Room) => {
        currentRoom = value
      }
    }
  }

  it.each(
    (['private', 'named room', 'unnamed room'] as const).flatMap(place =>
      (['approval', 'question'] as const).flatMap(kind =>
        (['get', 'list'] as const).flatMap(read =>
          (['before', 'overlaps', 'after'] as const).map(
            order => [place, kind, read, order] as const
          )
        )
      )
    )
  )('keeps %s %s only when the %s read is %s its receipt', async (place, kind, read, order) => {
    const f = await pending(place, kind)
    let action: Promise<unknown> | undefined
    if (order !== 'after') action = (await f.reading(read, order === 'overlaps')).action
    f.card()
    if (order === 'after') action = (await f.reading(read)).action
    if (order === 'overlaps')
      f.readReply.resolve(read === 'get' ? { bot: f.idle } : { bots: [f.idle] })
    await action
    await flush()
    await f.finish()
    render().back()
    expect(render().bots[0].status).toBe(order === 'after' ? 'idle' : 'needs_you')
  })

  it.each(['approval', 'question'] as const)(
    'does not make duplicate buffered %s fresh after an Idle confirmation',
    async kind => {
      const f = await pending('private', kind)
      f.card()
      await f.reading()
      f.card()
      await f.finish()
      expect(render().chat.approvals.length + render().chat.questions.length).toBe(1)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['settled', 'expired'] as const)(
    'does not lend a later %s card receipt to an older remaining question',
    async control => {
      const f = await pending()
      f.card('old')
      await f.reading()
      f.card('new')
      f.event(control === 'settled' ? 'clarify.resolved' : 'clarify.expire', {
        ...f.context,
        request_id: 'new',
        status: 'answered',
        answers: { first: 'Yes', last: 'Now' }
      })
      await f.finish()
      expect(render().chat.questions.map(q => q.requestId)).toEqual(['old'])
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['settled', 'expired'] as const)(
    'retains a genuinely later card after the older one is %s',
    async control => {
      const f = await pending()
      f.card('old')
      await f.reading()
      f.card('new')
      f.event(control === 'settled' ? 'clarify.resolved' : 'clarify.expire', {
        ...f.context,
        request_id: 'old',
        status: 'answered',
        answers: { first: 'Yes', last: 'Now' }
      })
      await f.finish()
      expect(render().chat.questions.map(q => q.requestId)).toEqual(['new'])
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    }
  )

  it.each(['status.update', 'message.delta', 'thinking.delta'] as const)(
    'does not mint card receipt proof from %s',
    async type => {
      const f = await pending()
      f.card()
      await f.reading()
      f.event(type, { kind: 'working', text: 'Working' })
      await f.finish()
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['approval', 'question'] as const)(
    'carries a new %s and its receipt through a history reread',
    async kind => {
      const f = await pending('private', kind)
      await f.reading()
      f.event('message.complete', { text: 'Previous turn completed' })
      f.event('message.start', {})
      f.card()
      await f.finish()
      expect(f.statusCalls()).toBe(2)
      expect(render().chat.approvals.length + render().chat.questions.length).toBe(1)
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    }
  )

  it.each(['approval', 'question'] as const)(
    'does not renew a carried %s over Idle during the reread',
    async kind => {
      const f = await pending('private', kind)
      await f.reading()
      f.event('message.complete', {})
      f.event('message.start', {})
      f.card()
      const second = f.holdReread()
      const finishing = f.finish()
      await flush()
      expect(f.statusCalls()).toBe(2)
      await f.reading()
      f.event('status.update', { kind: 'working', text: 'Working' })
      second.resolve({ status: 'working' })
      await finishing
      expect(render().chat.approvals.length + render().chat.questions.length).toBe(1)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('keeps old history-only questions behind a newer Idle read', async () => {
    const f = await pending()
    f.setSnapshot({
      request_id: 'snapshot',
      questions: [{ qid: 'first', question: 'From history?' }]
    })
    // The pending question belongs to a later reread, but keeps the original history receipt.
    f.event('message.complete', {})
    f.event('message.start', {})
    const second = f.holdReread()
    const finishing = f.finish()
    await flush()
    await f.reading()
    second.resolve({ status: 'working' })
    await finishing
    expect(render().chat.questions).toHaveLength(1)
    render().back()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['wrong session', 'foreign bot', 'foreign section', 'room hint'] as const)(
    'rejects buffered private card receipt for %s',
    async control => {
      const f = await pending()
      await f.reading()
      const request = f.frame()
      hooks.clients[0].emit({
        ...request,
        session_id: control === 'wrong session' ? 'unopened-room-live' : request.session_id,
        payload: {
          ...(request.payload as Record<string, unknown>),
          ...(control === 'foreign bot' ? { bot: 'other' } : {}),
          ...(control === 'foreign section' ? { section_id: 'room-stored' } : {}),
          ...(control === 'room hint' ? { room_id: 'unknown-room' } : {})
        }
      })
      await f.finish()
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('rejects old-session buffered cards when a reread returns a different live session', async () => {
    const f = await pending()
    await f.reading()
    f.event('message.complete', {})
    f.event('message.start', {})
    f.card()
    f.setSection(section('section', 'replacement-live'))
    await f.finish()
    expect(f.statusCalls()).toBe(2)
    expect(render().chat.questions).toEqual([])
    render().back()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each(['target', 'epoch'] as const)(
    'does not carry pending card receipt across a changed %s',
    async control => {
      const f = await pending()
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'one' } })
      await f.reading()
      f.card()
      if (control === 'target') {
        const prior = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.bots.list' ? { bots: [f.idle] } : prior(method, params)
        await render().activate({ ...daemon, id: 'next' }, 'token')
        await render().refresh()
      } else hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'two' } })
      await f.finish()
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['named room', 'unnamed room'] as const)(
    'does not give unknown or foreign room frames proof in %s',
    async place => {
      const f = await pending(place)
      await f.reading()
      f.event('clarify.request', {
        ...f.context,
        bot: 'other',
        request_id: 'foreign-bot',
        question: 'Foreign?'
      })
      f.event('clarify.request', {
        ...f.context,
        room_id: 'unknown-room',
        request_id: 'foreign-room',
        question: 'Other room?'
      })
      f.event(
        'clarify.request',
        { ...f.context, request_id: 'unknown-session', question: 'Unbound?' },
        'unknown-live'
      )
      await f.finish()
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('keeps a card received after history closes on the ordinary live path', async () => {
    const f = await pending()
    await f.reading()
    await f.finish()
    f.card()
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['approval', 'question'] as const)(
    'does not renew the original %s receipt when Idle preceded the reread start',
    async kind => {
      const f = await pending('private', kind)
      f.event('message.complete', {})
      f.event('message.start', {})
      f.card()
      await f.reading()
      await f.finish()
      expect(f.statusCalls()).toBe(2)
      expect(render().chat.approvals.length + render().chat.questions.length).toBe(1)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('does not turn a replay of an existing history-only question into a live receipt', async () => {
    const f = await pending('private', 'question', {
      request_id: 'buffer-card',
      questions: [
        { qid: 'first', question: 'Why?' },
        { qid: 'last', question: 'When?' }
      ]
    })
    await f.reading()
    f.card()
    await f.finish()
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['first', 'last'])
    render().back()
    expect(render().bots[0].status).toBe('idle')
  })

  it.each([false, true])(
    'tracks only the later question ID when its partial settlement completes=%s',
    async settleNew => {
      const f = await pending('private', 'question', {
        request_id: 'batch',
        questions: [{ qid: 'first', question: 'Old?' }]
      })
      await f.reading()
      f.event('clarify.request', {
        ...f.context,
        request_id: 'batch',
        questions: [
          { qid: 'first', question: 'Old?' },
          { qid: 'new', question: 'New?' }
        ]
      })
      f.event('clarify.resolved', {
        ...f.context,
        request_id: 'batch',
        status: 'waiting',
        answers: settleNew ? { new: 'Yes' } : { first: 'Yes' }
      })
      await f.finish()
      expect(render().chat.questions[0].questions.map(q => q.id)).toEqual([
        settleNew ? 'first' : 'new'
      ])
      render().back()
      expect(render().bots[0].status).toBe(settleNew ? 'idle' : 'needs_you')
    }
  )

  it.each(
    (['private', 'named room', 'unnamed room'] as const).flatMap(place =>
      (['buffered', 'live', 'reopened'] as const).flatMap(flow =>
        (['approval', 'question'] as const).map(kind => [place, flow, kind] as const)
      )
    )
  )('keeps %s %s %s authority separate after leaving', async (place, flow, kind) => {
    const f = await pending(place)
    f.card('old')
    if (flow !== 'buffered') await f.finish()
    await f.reading()
    f.card('fresh', kind)
    if (flow === 'buffered') await f.finish()
    if (flow === 'reopened') {
      render().back()
      if (place === 'private') await render().openSection(f.idle, section())
      else await render().openRoom(f.room)
    }
    expect(render().chat.questions.some(card => card.requestId === 'old')).toBe(true)
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
    f.event(kind === 'approval' ? 'approval.resolved' : 'clarify.resolved', {
      ...f.context,
      request_id: 'fresh',
      ...(kind === 'approval'
        ? { choice: 'once' }
        : { status: 'answered', answers: { first: 'Yes', last: 'Now' } })
    })
    await flush()
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  it.each(['private', 'named room', 'unnamed room'] as const)(
    'expires only fresh question authority in %s',
    async place => {
      const f = await pending(place)
      f.card('old')
      await f.reading()
      f.card('fresh')
      await f.finish()
      render().back()
      f.event('clarify.expire', { ...f.context, request_id: 'fresh' })
      expect(render().bots[0].status).not.toBe('needs_you')
    }
  )

  it('does not lend the fresh question ID authority to older IDs after a partial answer', async () => {
    const f = await pending('private', 'question', {
      request_id: 'batch',
      questions: [{ qid: 'first', question: 'Old?' }]
    })
    await f.reading()
    f.event('clarify.request', {
      ...f.context,
      request_id: 'batch',
      questions: [
        { qid: 'first', question: 'Old?' },
        { qid: 'fresh', question: 'New?' },
        { qid: 'fresh', question: 'Duplicate new ID?' }
      ]
    })
    await f.finish()
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
    f.event('clarify.resolved', {
      ...f.context,
      request_id: 'batch',
      status: 'waiting',
      answers: { fresh: 'Yes' }
    })
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  it('accepts a later pending snapshot for the exact previously disproved key', async () => {
    const f = await pending()
    f.card('old')
    await f.finish()
    await f.reading()
    f.card('fresh', 'approval')
    f.setSnapshot({
      request_id: 'old',
      questions: [{ qid: 'first', question: 'Confirmed again?' }]
    })
    await render().syncChat()
    render().back()
    f.event('approval.resolved', { ...f.context, request_id: 'fresh', choice: 'once' })
    expect(render().bots[0].status).toBe('needs_you')
    f.event('clarify.resolved', {
      ...f.context,
      request_id: 'old',
      status: 'answered',
      answers: { first: 'Yes' }
    })
    expect(render().bots[0].status).toBe('working')
  })

  it('does not renew an older sibling card when a local answer is submitted', async () => {
    const f = await pending()
    f.card('old')
    await f.finish()
    await f.reading()
    f.card('fresh', 'approval')
    const prior = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'approval.respond' ? { resolved: true, choice: 'once' } : prior(method, params)
    await render().approval('fresh', 'once', f.sessionId)
    expect(render().chat.questions.map(card => card.requestId)).toEqual(['old'])
    render().back()
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  it('restores only confirmed cards when an archived turn has an older disproved sibling', async () => {
    const f = await pending()
    f.card('old')
    await f.finish()
    await f.reading()
    f.card('fresh')
    render().back()
    const prior = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive'
        ? { section: { ...section(), archived_at: method.endsWith('.archive') ? 1 : null } }
        : prior(method, params)
    await render().rpc('hexbot.sections.archive', { id: 'section' })
    expect(render().bots[0].status).toBe('idle')
    await render().rpc('hexbot.sections.unarchive', { id: 'section' })
    expect(render().bots[0].status).toBe('needs_you')
    f.event('clarify.expire', { ...f.context, request_id: 'fresh' })
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  it.each(['foreign bot', 'foreign section', 'foreign room'] as const)(
    'does not give an owned private turn a receipt from a %s',
    async foreign => {
      const f = await pending()
      f.card('owned')
      await f.finish()
      render().back()
      f.event('clarify.request', {
        ...f.context,
        ...(foreign === 'foreign bot' ? { bot: 'other' } : {}),
        ...(foreign === 'foreign section' ? { section_id: 'other' } : {}),
        ...(foreign === 'foreign room' ? { room_id: 'other' } : {}),
        request_id: 'foreign',
        question: 'Wrong owner?'
      })
      f.event('clarify.expire', { ...f.context, request_id: 'owned' })
      expect(render().bots[0].status).not.toBe('needs_you')
    }
  )
})

describe('mobile cards included in a loading open snapshot', () => {
  it.each(['fresh', 'duplicate', 'settled', 'unrelated'] as const)(
    'tracks the exact %s receipt before the snapshot response',
    async control => {
      const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
      await unopened(idle)
      const held = deferred()
      const prior = hooks.handler
      let read = true
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open') return held.promise
        if (method === 'hexbot.bots.get' && read) return { bot: idle }
        if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
          throw new Error('Read unavailable')
        return prior(method, params)
      }
      const opening = render().openSection(idle, section())
      await flush()
      const frame = wire('clarify.request', {
        bot: 'alpha',
        section_id: 'section',
        request_id: 'snapshot',
        question: 'Why?'
      })
      if (control === 'duplicate') hooks.clients[0].emit(frame)
      hooks.clients[0].emit({ type: 'hexbot.bots.changed', payload: { name: 'alpha' } })
      await flush()
      read = false
      hooks.clients[0].emit(control === 'unrelated' ? approval : frame)
      if (control === 'settled' || control === 'unrelated')
        hooks.clients[0].emit(
          control === 'unrelated'
            ? resolved
            : wire('clarify.resolved', {
                bot: 'alpha',
                section_id: 'section',
                request_id: 'snapshot',
                status: 'answered',
                answers: { snapshot: 'Yes' }
              })
        )
      held.resolve({ section: section(), messages: [], pending_clarify: frame.payload })
      await opening
      expect(render().chat.questions).toHaveLength(control === 'settled' ? 0 : 1)
      render().back()
      expect(render().bots[0].status).toBe(
        control === 'fresh' ? 'needs_you' : control === 'settled' ? 'working' : 'idle'
      )
    }
  )
})

describe('mobile retained cards follow verified session rollover', () => {
  it.each(
    (['absent', 'stale'] as const).flatMap(row =>
      (['start', 'open', 'list'] as const).map(source => [row, source] as const)
    )
  )('retires the old turn with a %s catalog row on accepted %s', async (row, source) => {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    const original = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.list'
        ? { sections: row === 'stale' ? [section('other', 's2')] : [] }
        : original(method, params)
    await unopened(idle)
    await render().openSection(idle, section('other', 's2'))
    const prior = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.get' || method === 'hexbot.bots.list')
        throw new Error('Read unavailable')
      return prior(method, params)
    }
    const emit = hooks.clients[0].emit
    emit(
      wire(
        'clarify.request',
        {
          bot: 'alpha',
          section_id: 'other',
          request_id: 'old',
          question: 'Old session?'
        },
        's2'
      )
    )
    const cards = render().chat.questions
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
    if (source === 'start') {
      emit(wire('message.start', { bot: 'alpha', section_id: 'other', room_id: null }, 's3'))
      expect(render().bots[0].status).toBe(row === 'absent' ? 'working' : 'needs_you')
      expect(render().chat.questions).toEqual(cards)
      emit(wire('message.complete', { text: 'Finished' }, 's3'))
      if (row === 'stale') {
        // The catalog binding still guards starts until a later snapshot accepts the new SID.
        const failed = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.sections.open'
            ? { section: section('other', 's3'), messages: [] }
            : failed(method, params)
        await render().openSection(idle, section('other', 's3'))
        render().back()
      }
    } else {
      const failed = hooks.handler
      const held = deferred()
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.sections.open')
          return { section: section('other', 's3'), messages: [] }
        if (method === 'hexbot.sections.list') return { sections: [section('other', 's3')] }
        if (method === 'hexbot.bots.list') return held.promise
        return failed(method, params)
      }
      if (source === 'open') await render().openSection(idle, section('other', 's3'))
      else {
        const reading = render().refresh()
        emit(
          wire(
            'clarify.request',
            {
              bot: 'alpha',
              section_id: 'other',
              request_id: 'late-old',
              question: 'Late old card?'
            },
            's2'
          )
        )
        held.resolve({ bots: [idle] })
        await reading
      }
      render().back()
    }
    expect(render().bots[0].status).toBe('idle')
  })
})

describe('mobile open section restore reconfirms pending cards', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function archived(kind: 'question' | 'approval' = 'question') {
    const idle = { ...namedWait, status: 'idle', status_detail: null } as Bot
    let row: Section = { ...section(), archived_at: 1 }
    let reads = true
    let opens = 0
    const question = {
      bot: 'alpha',
      section_id: 'section',
      request_id: 'archived-card',
      questions: [
        { qid: 'first', question: 'Where?' },
        { qid: 'last', question: 'When?' }
      ]
    }
    const approval = {
      bot: 'alpha',
      section_id: 'section',
      request_id: 'archived-card',
      choices: ['once', 'deny']
    }
    let pending: Record<string, unknown> | undefined = kind === 'question' ? question : undefined
    let reemit = kind === 'approval'
    const messages = [{ id: 'readable', role: 'assistant', content: 'Earlier reply' }]
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.bots.list') {
        if (!reads) throw new Error('Roster unavailable')
        return { bots: [idle] }
      }
      if (method === 'hexbot.bots.get') throw new Error('Bot read unavailable')
      if (method === 'hexbot.rooms.list') return { rooms: [] }
      if (method === 'hexbot.sections.list') return { sections: [row] }
      if (method === 'hexbot.sections.open') {
        opens++
        if (params.id !== row.id)
          return {
            section: { ...section(String(params.id), 's2'), archived_at: null },
            messages: []
          }
        if (opens > 1 && reemit) hooks.clients[0].emit(wire('approval.request', approval))
        return { section: row, messages, ...(opens > 1 ? { pending_clarify: pending } : {}) }
      }
      if (method === 'session.status') return { status: 'working' }
      if (method === 'hexbot.sections.unarchive') {
        row = { ...row, archived_at: null }
        return { section: row }
      }
      if (method === 'hexbot.sections.archive') {
        row = { ...row, archived_at: 2 }
        return { section: row }
      }
      if (method === 'clarify.respond')
        return { status: 'waiting', answers: { first: 'Here' }, remaining: ['last'] }
      return {}
    }
    await render().activate(daemon, 'token')
    hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'one' } })
    await render().refresh()
    reads = false
    await render().openSection(idle, row)
    hooks.clients[0].emit(
      wire(
        kind === 'question' ? 'clarify.request' : 'approval.request',
        kind === 'question' ? question : approval
      )
    )
    expect(render().chat.questions.length + render().chat.approvals.length).toBe(1)
    expect(render().bots[0].status).toBe('idle')
    return {
      idle,
      question,
      restore: () => render().rpc('hexbot.sections.unarchive', { id: 'section' }),
      opens: () => opens,
      row: () => row,
      catalog: async (archived_at: number | null, live_session_id = 's1') => {
        row = { ...row, archived_at, live_session_id }
        reads = true
        await render().refresh()
        reads = false
      },
      empty: () => {
        pending = undefined
        reemit = false
      }
    }
  }

  it.each(['question', 'approval'] as const)(
    'reconfirms an unanswered archived-time %s without a bot read',
    async kind => {
      const f = await archived(kind)
      await f.restore()
      expect(f.opens()).toBe(2)
      expect(render().route).toMatchObject({
        kind: 'section',
        section: { id: 'section', archived_at: null }
      })
      expect(render().chat.messages).toMatchObject([{ id: 'readable', text: 'Earlier reply' }])
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    }
  )

  it('keeps the remaining exact question after a partial answer and leave', async () => {
    const f = await archived()
    await f.restore()
    await render().answer('archived-card', 'first', 'Here', 's1')
    expect(render().chat.questions[0].questions.map(q => q.id)).toEqual(['last'])
    expect(
      render().chat.settlements[JSON.stringify(['clarify', 's1', 'archived-card'])]?.answers
    ).toEqual({ first: 'Here' })
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
  })

  it.each(['question', 'approval'] as const)(
    'keeps the restored %s after a fresh sibling approval settles',
    async kind => {
      const f = await archived(kind)
      await f.restore()
      hooks.clients[0].emit(
        wire('approval.request', { request_id: 'sibling', bot: 'alpha', section_id: 'section' })
      )
      render().back()
      hooks.clients[0].emit(
        wire('approval.resolved', {
          request_id: 'sibling',
          bot: 'alpha',
          section_id: 'section',
          choice: 'once'
        })
      )
      expect(render().bots[0].status).toBe('needs_you')
      hooks.clients[0].emit(
        wire(kind === 'question' ? 'clarify.expire' : 'approval.resolved', {
          request_id: 'archived-card',
          bot: 'alpha',
          section_id: 'section',
          choice: 'once'
        })
      )
      expect(render().bots[0].status).not.toBe('needs_you')
    }
  )

  it.each(['question', 'approval'] as const)(
    'reconciles an authoritative empty reopen of the archived-time %s',
    async kind => {
      const f = await archived(kind)
      f.empty()
      const previous = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'session.status' ? { status: 'idle' } : previous(method, params)
      await f.restore()
      expect(render().chat.questions).toEqual([])
      expect(render().chat.approvals).toEqual([])
      expect(render().chat.messages).toMatchObject([{ id: 'readable', text: 'Earlier reply' }])
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['hexbot.sections.open', 'session.status'])(
    'keeps readable cards without making receipt proof when %s fails',
    async failed => {
      const f = await archived()
      const previous = hooks.handler
      hooks.handler = async (method, params) => {
        if (method === failed) throw new Error('Reopen unavailable')
        return previous(method, params)
      }
      await f.restore()
      expect(render().route).toMatchObject({ kind: 'section', section: { archived_at: null } })
      expect(render().chat.questions[0].requestId).toBe('archived-card')
      expect(render().chat.messages[0].text).toBe('Earlier reply')
      expect(render().error).toBe('Reopen unavailable')
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['rejected', 'wrong id', 'wrong bot', 'still archived'])(
    'does not reopen a %s restore',
    async response => {
      const f = await archived()
      const previous = hooks.handler
      hooks.handler = async (method, params) => {
        if (method !== 'hexbot.sections.unarchive') return previous(method, params)
        if (response === 'rejected') throw new Error('Restore rejected')
        return {
          section: {
            ...f.row(),
            id: response === 'wrong id' ? 'other' : 'section',
            bot: response === 'wrong bot' ? 'other' : 'alpha',
            archived_at: response === 'still archived' ? 1 : null
          }
        }
      }
      if (response === 'rejected') await expect(f.restore()).rejects.toThrow('Restore rejected')
      else await f.restore()
      expect(f.opens()).toBe(1)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it.each(['closed', 'other section', 'already active'])(
    'does not reopen a %s route on a restore ACK',
    async route => {
      const f = await archived()
      if (route === 'closed') render().back()
      else if (route === 'other section') await render().openSection(f.idle, section('other', 's2'))
      else await f.catalog(null)
      const before = f.opens()
      await f.restore()
      expect(f.opens()).toBe(before)
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  const boundaries = [
    'other route',
    'same route reopened',
    'deleted',
    'epoch',
    'daemon',
    'archived again',
    'catalog archive and restore',
    'catalog new session'
  ] as const
  async function boundary(
    kind: (typeof boundaries)[number],
    f: Awaited<ReturnType<typeof archived>>
  ) {
    if (kind === 'other route') await render().openSection(f.idle, section('other', 's2'))
    else if (kind === 'same route reopened') await render().openSection(f.idle, f.row())
    else if (kind === 'deleted')
      hooks.clients[0].emit({
        type: 'hexbot.sections.changed',
        payload: { id: 'section', deleted: true }
      })
    else if (kind === 'epoch')
      hooks.clients[0].emit({ type: 'gateway.ready', payload: { replay_epoch: 'two' } })
    else if (kind === 'daemon') await render().activate({ ...daemon, id: 'other-daemon' }, 'token')
    else if (kind === 'archived again')
      await render().rpc('hexbot.sections.archive', { id: 'section' })
    else if (kind === 'catalog new session') await f.catalog(null, 's2')
    else {
      await f.catalog(2)
      await f.catalog(null)
    }
  }

  it.each(boundaries)('does not reopen after a held ACK crosses %s', async kind => {
    const f = await archived()
    const ack = deferred()
    const previous = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.unarchive' ? ack.promise : previous(method, params)
    const restoring = f.restore().catch(e => e)
    await boundary(kind, f)
    const before = f.opens()
    ack.resolve({ section: { ...section(), archived_at: null } })
    await restoring
    expect(f.opens()).toBe(before)
    if (kind !== 'daemon') {
      render().back()
      expect(render().bots[0].status).toBe('idle')
    } else expect(render().bots).toEqual([])
  })

  it.each(
    (['open', 'status'] as const).flatMap(phase =>
      boundaries.filter(kind => kind !== 'same route reopened').map(kind => [phase, kind] as const)
    )
  )('does not apply a held restore %s after %s', async (phase, kind) => {
    const f = await archived()
    const held = deferred()
    const previous = hooks.handler
    let holding = true
    hooks.handler = async (method, params) => {
      if (holding && method === (phase === 'open' ? 'hexbot.sections.open' : 'session.status')) {
        holding = false
        return held.promise
      }
      return previous(method, params)
    }
    const restoring = f.restore()
    await flush()
    holding = false
    await boundary(kind, f)
    held.resolve(
      phase === 'open'
        ? {
            section: { ...section(), archived_at: null },
            messages: [],
            pending_clarify: f.question
          }
        : { status: 'working' }
    )
    await restoring
    if (kind === 'other route')
      expect(render().route).toMatchObject({ kind: 'section', section: { id: 'other' } })
    if (kind === 'deleted' || kind === 'daemon') expect(render().route).toBeNull()
    if (kind === 'archived again')
      expect(render().route).toMatchObject({ kind: 'section', section: { archived_at: 2 } })
    if (kind !== 'daemon') {
      render().back()
      expect(render().bots[0].status).toBe('idle')
    } else expect(render().bots).toEqual([])
  })

  it('accepts the current new session returned by restore without reviving the old one', async () => {
    const f = await archived()
    const previous = hooks.handler
    hooks.handler = async (method, params) => {
      if (method === 'hexbot.sections.open')
        return {
          section: { ...section(), archived_at: null, live_session_id: 'new-live' },
          messages: [{ id: 'readable', role: 'assistant', content: 'Earlier reply' }],
          pending_clarify: { ...f.question, request_id: 'new-card' }
        }
      return previous(method, params)
    }
    await f.restore()
    expect(render().liveSessionId()).toBe('new-live')
    expect(render().chat.questions.map(q => [q.sessionId, q.requestId])).toEqual([
      ['new-live', 'new-card']
    ])
    render().back()
    hooks.clients[0].emit(wire('clarify.expire', { ...f.question }))
    expect(render().bots[0].status).toBe('needs_you')
    hooks.clients[0].emit(
      wire('clarify.expire', { ...f.question, request_id: 'new-card' }, 'new-live')
    )
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  it.each(['approval', 'question'] as const)(
    'keeps a fresh buffered %s readable when a newer archive rejects the restore read',
    async kind => {
      const f = await archived()
      const held = deferred()
      const previous = hooks.handler
      hooks.handler = async (method, params) =>
        method === 'hexbot.sections.open' ? held.promise : previous(method, params)
      const restoring = f.restore()
      await flush()
      await render().rpc('hexbot.sections.archive', { id: 'section' })
      hooks.clients[0].emit(
        wire(kind === 'approval' ? 'approval.request' : 'clarify.request', {
          bot: 'alpha',
          section_id: 'section',
          request_id: 'fresh',
          question: 'Fresh?'
        })
      )
      held.resolve({
        section: { ...section(), archived_at: null },
        messages: [],
        pending_clarify: f.question
      })
      await restoring
      expect(
        render().chat.approvals.some(card => card.requestId === 'fresh') ||
          render().chat.questions.some(card => card.requestId === 'fresh')
      ).toBe(true)
      expect(render().chat.questions[0].requestId).toBe('archived-card')
      render().back()
      expect(render().bots[0].status).toBe('idle')
    }
  )

  it('retains only a fresh buffered approval when the restore read fails', async () => {
    const f = await archived()
    const held = deferred()
    const previous = hooks.handler
    hooks.handler = async (method, params) =>
      method === 'hexbot.sections.open' ? held.promise : previous(method, params)
    const restoring = f.restore()
    await flush()
    hooks.clients[0].emit(
      wire('approval.request', { bot: 'alpha', section_id: 'section', request_id: 'fresh' })
    )
    held.reject(new Error('Reopen unavailable'))
    await restoring
    expect(render().chat.approvals.map(card => card.requestId)).toEqual(['fresh'])
    expect(render().chat.questions[0].requestId).toBe('archived-card')
    render().back()
    expect(render().bots[0].status).toBe('needs_you')
    hooks.clients[0].emit(
      wire('approval.resolved', {
        bot: 'alpha',
        section_id: 'section',
        request_id: 'fresh',
        choice: 'once'
      })
    )
    expect(render().bots[0].status).not.toBe('needs_you')
  })

  describe('restore read completion', () => {
    it.each(
      (['older catalog', 'newer catalog'] as const).flatMap(catalog =>
        (['question', 'approval'] as const).map(kind => [catalog, kind] as const)
      )
    )('reconfirms %s with a %s after the catalog and runtime diverged', async (catalog, kind) => {
      const f = await archived(kind)
      const runtime = catalog === 'older catalog' ? 's1' : 's2'
      await f.catalog(1, catalog === 'older catalog' ? 'old-live' : 's2')
      expect(render().liveSessionId()).toBe('s1')
      const previous = hooks.handler
      hooks.handler = async (method, params) => {
        const result = await previous(method, params)
        if (method !== 'hexbot.sections.open') return result
        if (kind === 'approval')
          hooks.clients[0].emit(
            wire(
              'approval.request',
              { bot: 'alpha', section_id: 'section', request_id: 'archived-card' },
              runtime
            )
          )
        return { ...(result as object), section: { ...f.row(), live_session_id: runtime } }
      }
      await f.restore()
      expect(render().liveSessionId()).toBe(runtime)
      const cards = [...render().chat.questions, ...render().chat.approvals]
      expect(cards.map(card => [card.sessionId, card.requestId])).toEqual([
        [runtime, 'archived-card']
      ])
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
    })

    it.each(['question', 'approval'] as const)(
      'reconfirms a %s when a remote restore is accepted before the local ACK',
      async kind => {
        const f = await archived(kind)
        const ack = deferred()
        const previous = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.sections.unarchive' ? ack.promise : previous(method, params)
        const restoring = f.restore()
        await f.catalog(null)
        ack.resolve({ section: { ...f.row(), archived_at: null } })
        await restoring
        expect(f.opens()).toBe(2)
        render().back()
        expect(render().bots[0].status).toBe('needs_you')
      }
    )

    it.each(['question', 'approval'] as const)(
      'does not use a superseded %s restore after another archive and restore',
      async kind => {
        const f = await archived(kind)
        const ack = deferred()
        const previous = hooks.handler
        hooks.handler = async (method, params) =>
          method === 'hexbot.sections.unarchive' ? ack.promise : previous(method, params)
        const restoring = f.restore()
        await f.catalog(null)
        await f.catalog(2)
        await f.catalog(null)
        ack.resolve({ section: { ...f.row(), archived_at: null } })
        await restoring
        expect(f.opens()).toBe(1)
        render().back()
        expect(render().bots[0].status).toBe('idle')
      }
    )

    it.each(
      (['restore', 'ordinary open'] as const).flatMap(flow =>
        (['approval', 'partial question'] as const).map(kind => [flow, kind] as const)
      )
    )('folds settled snapshots once during %s with a fresh %s', async (flow, kind) => {
      const f = await archived()
      if (flow === 'ordinary open') await f.catalog(null)
      const held = deferred()
      const previous = hooks.handler
      let opens = 0
      let gets = 0
      hooks.handler = async (method, params) => {
        if (method === 'hexbot.bots.get') gets++
        if (method !== 'hexbot.sections.open') return previous(method, params)
        if (++opens === 1) return held.promise
        const result = await previous(method, params)
        if (kind === 'approval') {
          hooks.clients[0].emit(
            wire('approval.request', { bot: 'alpha', section_id: 'section', request_id: 'fresh' })
          )
          return { ...(result as object), pending_clarify: undefined }
        }
        return {
          ...(result as object),
          pending_clarify: { ...f.question, request_id: 'fresh', answers: { first: 'Here' } }
        }
      }
      const reading = flow === 'restore' ? f.restore() : render().syncChat()
      await flush()
      hooks.clients[0].emit(
        wire('clarify.resolved', {
          ...f.question,
          status: 'answered',
          answers: { first: 'Here', last: 'Now' }
        })
      )
      hooks.clients[0].emit(wire('message.complete', { bot: 'alpha', section_id: 'section' }))
      hooks.clients[0].emit(
        wire('message.start', { bot: 'alpha', section_id: 'section', room_id: null })
      )
      hooks.clients[0].emit(
        wire(
          kind === 'approval' ? 'approval.request' : 'clarify.request',
          kind === 'approval'
            ? { bot: 'alpha', section_id: 'section', request_id: 'fresh' }
            : { ...f.question, request_id: 'fresh' }
        )
      )
      if (kind === 'partial question')
        hooks.clients[0].emit(
          wire('clarify.resolved', {
            ...f.question,
            request_id: 'fresh',
            status: 'waiting',
            answers: { first: 'Here' }
          })
        )
      hooks.clients[0].emit({
        type: 'hexbot.sections.changed',
        payload: { id: 'section', bot: 'alpha' }
      })
      await flush()
      await flush()
      const before = gets
      held.resolve({
        section: { ...f.row(), archived_at: null },
        messages: [{ id: 'readable', role: 'assistant', content: 'Earlier reply' }],
        pending_clarify: f.question
      })
      await reading
      await flush()
      expect(opens).toBe(2)
      expect(gets).toBe(before)
      expect(render().chat.messages.map(message => message.text)).toEqual(['Earlier reply'])
      expect(
        render().chat.questions.map(card => [
          card.requestId,
          card.questions.map(question => question.id)
        ])
      ).toEqual(kind === 'approval' ? [] : [['fresh', ['last']]])
      expect(render().chat.approvals.map(card => card.requestId)).toEqual(
        kind === 'approval' ? ['fresh'] : []
      )
      expect(
        render().chat.settlements[JSON.stringify(['clarify', 's1', 'archived-card'])]?.answers
      ).toEqual({ first: 'Here', last: 'Now' })
      render().back()
      expect(render().bots[0].status).toBe('needs_you')
      hooks.clients[0].emit(
        wire(kind === 'approval' ? 'approval.resolved' : 'clarify.resolved', {
          bot: 'alpha',
          section_id: 'section',
          request_id: 'fresh',
          choice: 'once',
          status: 'answered',
          answers: { last: 'Now' }
        })
      )
      expect(render().bots[0].status).not.toBe('needs_you')
    })
  })
})
