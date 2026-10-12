import { routeEvent } from '../lib/events'
import { setActiveRpc } from '../lib/rpc'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import {
  botStatusWithLive,
  clearDeletedSections,
  liveSectionsOf,
  sectionStatusOf,
  useSections
} from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void

  const promise = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function fixture(kind: 'approval' | 'clarify') {
  const row = {
    id: 'target',
    bot: 'owl',
    archived_at: null,
    live_session_id: 'target-live',
    title: 'Conversation',
    preview: 'Hello',
    message_count: 1
  } as Section

  const state = {
    row,
    failBots: false,
    failEdit: false,
    canonical: true,
    heldAnswer: null as ReturnType<typeof deferred> | null,
    heldBot: null as ReturnType<typeof deferred> | null,
    heldSections: null as ReturnType<typeof deferred> | null
  }

  const projection = (): Bot =>
    ({
      name: 'owl',
      status: state.row.archived_at ? 'idle' : 'needs_you',
      status_detail: state.row.archived_at
        ? null
        : {
            section_id: row.id,
            session_id: 'target-live',
            room_id: null,
            action: null,
            since: 1,
            text: 'Waiting for you'
          }
    }) as Bot

  clearDeletedSections()
  useSections.setState({
    byId: { target: row },
    idsByBot: { owl: ['target'] },
    liveSessionId: { target: 'target-live' }
  })
  useBots.setState({ byName: { owl: projection() }, order: ['owl'] })
  useRooms.setState({ byId: {}, liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  useTranscripts.getState().open('target-live', row.id, [], undefined, 'owl')
  routeEvent({
    type: `${kind}.request`,
    session_id: 'target-live',
    payload: { request_id: 'pending', question: 'Choose?', bot: 'owl', section_id: row.id }
  } as never)

  const call = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'hexbot.sections.archive' || method === 'hexbot.sections.unarchive') {
      if (state.failEdit) {
        throw new Error('Edit unavailable')
      }

      state.row = { ...state.row, archived_at: method.endsWith('.archive') ? 1 : null }

      return { section: state.row }
    }

    if (method === 'hexbot.sections.list') {
      return state.heldSections?.promise ?? { sections: [state.row] }
    }

    if (method === 'hexbot.bots.list' || method === 'hexbot.bots.get') {
      if (state.failBots) {
        throw new Error('Bot refresh unavailable')
      }

      return (
        state.heldBot?.promise ??
        (method.endsWith('.list') ? { bots: [projection()] } : { bot: projection() })
      )
    }

    if (method === 'approval.respond') {
      return (
        state.heldAnswer?.promise ?? {
          resolved: true,
          ...(state.canonical ? { choice: 'once' } : {})
        }
      )
    }

    if (method === 'clarify.respond') {
      return (
        state.heldAnswer?.promise ??
        (state.canonical
          ? { status: 'answered', answers: { pending: 'Yes' } }
          : { status: 'answered' })
      )
    }

    throw new Error(`Unexpected ${method}`)
  })

  setActiveRpc({ call } as never)

  function changed() {
    let sections!: Promise<void>
    let bots!: Promise<void>
    routeEvent(
      {
        type: 'hexbot.sections.changed',
        payload: { id: row.id, bot: 'owl', name: 'owl' }
      } as never,
      {
        refreshSections: () => {
          sections = useSections.getState().refresh()
        },
        refreshBots: () => {
          bots = useBots.getState().refresh()
        }
      }
    )

    return { sections, bots }
  }

  function status() {
    const sessions = useTranscripts.getState().bySession
    const live = liveSectionsOf(sessions)
    const bot = useBots.getState().byName.owl!

    return {
      section: sectionStatusOf(bot, row.id, live),
      bot: botStatusWithLive(bot, Object.values(useSections.getState().byId), live, sessions)
    }
  }

  const answer = () =>
    kind === 'approval'
      ? useTranscripts.getState().respondApproval('target-live', 'pending', 'once')
      : useTranscripts.getState().respondClarify('target-live', 'pending', 'Yes')

  return { state, projection, changed, status, call, answer }
}

async function siblingOverlap(
  kind: 'approval' | 'clarify',
  progress: 'working' | 'needs_you' | 'stopped',
  timing: 'before' | 'after',
  boundary: 'active' | 'archived' | 'new request' | 'new run' = 'active',
  cause: 'private' | 'room' | 'unspecified' = 'private'
) {
  const f = fixture(kind)

  const sibling = {
    ...f.state.row,
    id: 'sibling',
    live_session_id: 'sibling-live',
    archived_at: boundary === 'archived' ? 1 : null
  }

  useSections.setState(state => ({
    byId: { ...state.byId, sibling },
    idsByBot: { owl: ['target', 'sibling'] },
    liveSessionId: { ...state.liveSessionId, sibling: 'sibling-live' }
  }))
  useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')
  routeEvent({
    type: `${kind}.request`,
    session_id: 'sibling-live',
    payload: {
      request_id: 'sibling-pending',
      question: 'Continue?',
      bot: 'owl',
      section_id: 'sibling'
    }
  } as never)

  if (cause === 'room') {
    useTranscripts.getState().setSectionId('target-live', 'room:r', 'owl')
    useRooms.setState({
      liveTurnsByRoom: { r: { owl: { live_session_id: 'target-live', status: 'running' } } }
    } as never)
  }

  f.state.heldSections = deferred()
  const metadata = useSections.getState().refresh()
  const older = deferred()
  const newer = deferred()
  f.state.heldBot = older
  const oldRead = useBots.getState().refresh()
  f.state.heldBot = newer
  let newRead: Promise<void> | undefined

  if (timing === 'before') {
    newRead = useBots.getState().refreshOne('owl')
  }

  older.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
  await oldRead

  if (timing === 'after') {
    newRead = useBots.getState().refreshOne('owl')
  }

  if (boundary === 'new request') {
    routeEvent({
      type: `${kind}.request`,
      session_id: 'sibling-live',
      payload: {
        request_id: 'fresh-sibling',
        question: 'Again?',
        bot: 'owl',
        section_id: 'sibling'
      }
    } as never)
  } else if (boundary === 'new run') {
    routeEvent({ type: 'message.start', session_id: 'sibling-live', payload: {} } as never)
    routeEvent({
      type: 'status.update',
      session_id: 'sibling-live',
      payload: { kind: 'working' }
    } as never)
  }

  const bot = {
    ...f.projection(),
    status: progress,
    status_detail:
      cause === 'unspecified'
        ? null
        : cause === 'room'
          ? { section_id: 'r', room_id: 'r', session_id: 'target-live' }
          : f.projection().status_detail
  } as Bot

  newer.resolve({ bot })
  await newRead
  f.state.heldSections.resolve({ sections: [f.state.row, sibling] })
  await metadata
  // The metadata promise settles before the dependent cleanup continuations.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  return {
    ...f,
    siblingStatus: () =>
      sectionStatusOf(
        useBots.getState().byName.owl,
        'sibling',
        liveSectionsOf(useTranscripts.getState().bySession)
      )
  }
}

afterEach(() => {
  resetTranscriptEffects()
  setActiveRpc(null)
})

describe.each(['approval', 'clarify'] as const)('%s archive restoration', kind => {
  it.each([
    ['working', 'before'],
    ['working', 'after'],
    ['needs_you', 'before'],
    ['needs_you', 'after']
  ] as const)(
    'settles the untouched sibling after newer %s starts %s provisional retirement',
    async (progress, timing) => {
      const f = await siblingOverlap(kind, progress, timing)
      await vi.waitFor(() =>
        expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual([])
      )
      expect(f.siblingStatus()).toBe('idle')
      expect(f.status().bot).toBe(progress)
    }
  )

  it.each(['archived', 'new request', 'new run'] as const)(
    'protects an untouched sibling with %s evidence after newer named authority',
    async boundary => {
      const f = await siblingOverlap(kind, 'working', 'before', boundary)
      const transcript = useTranscripts.getState().bySession['sibling-live']!

      if (boundary === 'new run') {
        expect(transcript.waitingRequests).toEqual([])
        expect(f.siblingStatus()).toBe('working')
      } else {
        expect(transcript.waitingRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requestId: boundary === 'archived' ? 'sibling-pending' : 'fresh-sibling'
            })
          ])
        )
        expect(f.siblingStatus()).toBe('needs_you')
      }

      expect(f.status().bot).toBe(boundary === 'new request' ? 'needs_you' : 'working')
    }
  )

  it.each(['room', 'unspecified'] as const)(
    'retains untouched sibling cleanup when newer Stopped authority names %s',
    async cause => {
      const f = await siblingOverlap(kind, 'stopped', 'before', 'active', cause)
      await vi.waitFor(() =>
        expect(useTranscripts.getState().bySession['sibling-live']?.waitingRequests).toEqual([])
      )
      expect(f.siblingStatus()).toBe('idle')
      expect(f.status().bot).toBe('stopped')
    }
  )

  it.each(['full', 'scoped'] as const)(
    'retains confirmed pending evidence through an archived %s Idle read',
    async scope => {
      const f = fixture(kind)
      await useSections.getState().archive('target')
      expect(f.status().bot).toBe('idle')

      if (scope === 'full') {
        await useBots.getState().refresh()
      } else {
        await useBots.getState().refreshOne('owl')
      }

      f.state.failBots = true
      await useSections.getState().unarchive('target')
      await useBots.getState().refresh()
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([
        expect.objectContaining({ kind, requestId: 'pending' })
      ])
      expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
    }
  )

  it.each(['sections first', 'Idle first'] as const)(
    'retains remote archive evidence when %s responds first',
    async order => {
      const f = fixture(kind)
      f.state.row = { ...f.state.row, archived_at: 1 }

      if (order === 'sections first') {
        f.state.heldBot = deferred()
      } else {
        f.state.heldSections = deferred()
      }

      const archive = f.changed()

      if (order === 'sections first') {
        await archive.sections
        f.state.heldBot!.resolve({ bots: [f.projection()] })
      } else {
        await archive.bots
        f.state.heldSections!.resolve({ sections: [f.state.row] })
      }

      await Promise.all([archive.sections, archive.bots])
      expect(f.status().bot).toBe('idle')
      f.state.heldBot = null
      f.state.heldSections = null
      f.state.row = { ...f.state.row, archived_at: null }
      f.state.failBots = true
      const restore = f.changed()
      await Promise.all([restore.sections, restore.bots])
      expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
    }
  )

  it('does not let a read captured while archived clear a card after restore', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')
    f.state.heldBot = deferred()
    const snapshot = f.projection()
    const reading = useBots.getState().refresh()
    await useSections.getState().unarchive('target')
    f.state.heldBot.resolve({ bots: [snapshot] })
    await reading
    expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
  })

  it('honors Idle captured while active even if archive finishes before the read', async () => {
    const f = fixture(kind)
    f.state.heldBot = deferred()
    const reading = useBots.getState().refresh()
    await useSections.getState().archive('target')
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading
    await useSections.getState().unarchive('target')

    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('ignores archived metadata superseded by restore before the bot read started', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')
    const archived = f.state.row
    f.state.heldSections = deferred()
    const metadata = useSections.getState().refresh()
    await useSections.getState().unarchive('target')
    f.state.heldBot = deferred()
    const reading = useBots.getState().refresh()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading
    f.state.heldSections.resolve({ sections: [archived] })
    await metadata
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )

    expect(useSections.getState().byId.target?.archived_at).toBeNull()
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('retains remote archived proof when restore finishes after the bot read started', async () => {
    const f = fixture(kind)
    f.state.row = { ...f.state.row, archived_at: 1 }
    const archived = f.state.row
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    const idle = f.projection()
    await useSections.getState().unarchive('target')
    f.state.heldBot.resolve({ bots: [idle] })
    await reading.bots
    f.state.heldSections.resolve({ sections: [archived] })
    await reading.sections
    f.state.failBots = true
    await useBots.getState().refresh()

    expect(useSections.getState().byId.target?.archived_at).toBeNull()
    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toHaveLength(1)
    expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
  })

  it('clears active Idle with held metadata when archive finishes after the bot read started', async () => {
    const f = fixture(kind)
    const active = f.state.row
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    await useSections.getState().archive('target')
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    f.state.heldSections.resolve({ sections: [active] })
    await reading.sections
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )
    await useSections.getState().unarchive('target')

    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('clears active and room confirmations without clearing archived or another bot', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')

    const sibling = {
      ...f.state.row,
      id: 'sibling',
      archived_at: null,
      live_session_id: 'sibling-live'
    }

    useSections.setState(state => ({
      byId: { ...state.byId, sibling },
      idsByBot: { owl: ['target', 'sibling'] },
      liveSessionId: { target: 'target-live', sibling: 'sibling-live' }
    }))

    for (const [live, section, bot] of [
      ['sibling-live', 'sibling', 'owl'],
      ['room-live', 'room:r', 'owl'],
      ['other-live', 'other', 'cat']
    ]) {
      useTranscripts.getState().open(live!, section!, [], undefined, bot)
      routeEvent({
        type: 'approval.request',
        session_id: live,
        payload: {
          request_id: live,
          bot,
          section_id: section,
          choices: ['once', 'deny']
        }
      } as never)
    }

    await useBots.getState().refreshOne('owl')
    const transcripts = useTranscripts.getState().bySession
    expect(transcripts['target-live']?.waitingRequests).toHaveLength(1)
    expect(transcripts['sibling-live']?.waitingRequests).toEqual([])
    expect(transcripts['room-live']?.waitingRequests).toEqual([])
    expect(transcripts['other-live']?.waitingRequests).toHaveLength(1)
    expect(f.status().bot).toBe('idle')
  })

  it.each(['canonical', 'legacy ACK'] as const)(
    'accepts a fresh %s answer after archived Idle and restore',
    async mode => {
      const f = fixture(kind)
      await useSections.getState().archive('target')
      await useBots.getState().refresh()
      await useSections.getState().unarchive('target')
      f.state.failBots = true
      f.state.canonical = mode === 'canonical'
      await f.answer()

      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
      expect(useTranscripts.getState().bySession['target-live']?.answeredWaiting).toEqual({
        kind,
        requestId: 'pending'
      })
      expect(f.status()).toEqual({ section: 'working', bot: 'working' })
    }
  )

  it('fences an answer begun before archived authority cleanup', async () => {
    const f = fixture(kind)
    f.state.heldAnswer = deferred()
    const answering = f.answer()
    await useSections.getState().archive('target')
    await useBots.getState().refresh()
    await useSections.getState().unarchive('target')
    f.state.heldAnswer.resolve(
      kind === 'approval'
        ? { resolved: true, choice: 'once' }
        : { status: 'answered', answers: { pending: 'Yes' } }
    )
    await answering

    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    expect(useTranscripts.getState().bySession['target-live']?.answeredWaiting).toBeUndefined()
  })

  it.each(['message.complete', 'error', 'status.update'] as const)(
    'retains real %s settlement received while archived',
    async type => {
      const f = fixture(kind)
      await useSections.getState().archive('target')
      await useBots.getState().refresh()
      routeEvent({
        type,
        session_id: 'target-live',
        payload: {
          text: 'Done',
          message: 'Failed',
          kind: 'idle'
        }
      } as never)
      await useSections.getState().unarchive('target')
      f.state.failBots = true
      await useBots.getState().refresh()

      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
      expect(f.status().bot).not.toBe('needs_you')
    }
  )

  it('does not reconfirm a historical card after active Idle', async () => {
    const f = fixture(kind)
    f.state.heldBot = deferred()
    const reading = useBots.getState().refresh()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading
    await useSections.getState().archive('target')
    f.state.heldBot = null
    await useBots.getState().refresh()
    await useSections.getState().unarchive('target')

    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('does not use a failed archive reply as excluded activity', async () => {
    const f = fixture(kind)
    f.state.failEdit = true
    await expect(useSections.getState().archive('target')).rejects.toThrow('Edit unavailable')
    f.state.heldBot = deferred()
    const reading = useBots.getState().refresh()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading

    expect(useSections.getState().byId.target?.archived_at).toBeNull()
    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
  })

  it('applies active Idle when concurrent metadata fails instead of inferring archive', async () => {
    const f = fixture(kind)
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    f.state.heldSections.reject(new Error('Metadata unavailable'))
    await reading.sections

    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )
    expect(f.status().bot).toBe('idle')
  })

  it.each([
    ['full', true],
    ['full', false],
    ['scoped', true],
    ['scoped', false]
  ] as const)(
    'uses the accepted newer metadata when the older %s reply finishes first=%s',
    async (olderScope, olderFirst) => {
      const f = fixture(kind)
      const archived = { ...f.state.row, archived_at: 1 }
      const older = deferred()
      const newer = deferred()
      f.state.heldSections = older

      const olderRead = useSections.getState().refresh(olderScope === 'full' ? {} : { bot: 'owl' })

      f.state.heldSections = newer

      const newerRead = useSections.getState().refresh(olderScope === 'full' ? { bot: 'owl' } : {})

      f.state.heldBot = deferred()
      const botRead = useBots.getState().refresh()
      f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
      await botRead

      const finishOlder = async () => {
        older.resolve({ sections: [archived] })
        await olderRead
      }

      const finishNewer = async () => {
        newer.resolve({ sections: [f.state.row] })
        await newerRead
      }

      if (olderFirst) {
        await finishOlder()
        await finishNewer()
      } else {
        await finishNewer()
        await finishOlder()
      }

      await vi.waitFor(() =>
        expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
      )
      expect(useSections.getState().byId.target?.archived_at).toBeNull()
      expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    }
  )

  it('does not let deferred old Idle touch a recreated transcript after epoch reset', async () => {
    const f = fixture(kind)
    f.state.row = { ...f.state.row, archived_at: 1 }
    f.state.heldSections = deferred()
    const reading = f.changed()
    await reading.bots
    useSections.getState().clearLive()
    useTranscripts.getState().open('target-live', 'target', [], undefined, 'owl')
    routeEvent({
      type: 'approval.request',
      session_id: 'target-live',
      payload: {
        request_id: 'new-process',
        bot: 'owl',
        section_id: 'target'
      }
    } as never)
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections

    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([
      expect.objectContaining({ requestId: 'new-process' })
    ])
  })

  it.each(['canonical', 'legacy ACK'] as const)(
    'fences a pre-Idle %s answer while metadata is pending',
    async mode => {
      const f = fixture(kind)
      f.state.heldAnswer = deferred()
      const answering = f.answer()
      f.state.heldSections = deferred()
      f.state.heldBot = deferred()
      const reading = f.changed()
      f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
      await reading.bots
      f.state.heldAnswer.resolve(
        kind === 'approval'
          ? mode === 'canonical'
            ? { resolved: true, choice: 'once' }
            : { resolved: true }
          : mode === 'canonical'
            ? { status: 'answered', answers: { pending: 'Yes' } }
            : { status: 'answered' }
      )
      await answering
      f.state.heldSections.resolve({ sections: [f.state.row] })
      await reading.sections

      expect(useTranscripts.getState().bySession['target-live']?.answeredWaiting).toBeUndefined()
      expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    }
  )

  it('retires existing Working immediately when Idle arrives before metadata', async () => {
    const f = fixture(kind)
    await f.answer()
    expect(f.status().bot).toBe('working')
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    expect(useTranscripts.getState().bySession['target-live']?.answeredWaiting).toBeUndefined()
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections
  })

  it.each(['full', 'scoped'] as const)(
    'preserves a newer accepted %s NeedsYou read started before deferred Idle retirement',
    async scope => {
      const f = fixture(kind)
      f.state.heldSections = deferred()
      const metadata = useSections.getState().refresh()
      const older = deferred()
      const newer = deferred()
      f.state.heldBot = older
      const oldRead = useBots.getState().refresh()
      f.state.heldBot = newer

      const newRead =
        scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

      older.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
      await oldRead
      newer.resolve(scope === 'full' ? { bots: [f.projection()] } : { bot: f.projection() })
      await newRead
      f.state.heldSections.resolve({ sections: [f.state.row] })
      await metadata
      await vi.waitFor(() => expect(f.status().bot).toBe('needs_you'))
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toHaveLength(1)
    }
  )

  it.each(['full', 'scoped'] as const)(
    'applies active Idle when a newer accepted %s Idle read began before retirement',
    async scope => {
      const f = fixture(kind)
      f.state.heldSections = deferred()
      const metadata = useSections.getState().refresh()
      const older = deferred()
      const newer = deferred()
      f.state.heldBot = older
      const oldRead = useBots.getState().refresh()
      f.state.heldBot = newer

      const newRead =
        scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

      const idle = { name: 'owl', status: 'idle', status_detail: null }
      older.resolve({ bots: [idle] })
      await oldRead
      newer.resolve(scope === 'full' ? { bots: [idle] } : { bot: idle })
      await newRead
      f.state.heldSections.resolve({ sections: [f.state.row] })
      await metadata
      await vi.waitFor(() =>
        expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
      )
      expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    }
  )

  it.each(['working', 'stopped'] as const)(
    'honors newer accepted %s for the exact session after provisional Idle retirement',
    async status => {
      const f = fixture(kind)
      f.state.heldSections = deferred()
      const metadata = useSections.getState().refresh()
      const older = deferred()
      const newer = deferred()
      f.state.heldBot = older
      const oldRead = useBots.getState().refresh()
      f.state.heldBot = newer
      const newRead = useBots.getState().refreshOne('owl')
      older.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
      await oldRead
      newer.resolve({ bot: { ...f.projection(), status } })
      await newRead
      f.state.heldSections.resolve({ sections: [f.state.row] })
      await metadata

      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
      expect(f.status()).toEqual({ section: status, bot: status })
    }
  )

  it('uses newer active Idle proof when an older Idle read started archived', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')
    const archived = f.state.row
    f.state.heldSections = deferred()
    const metadata = useSections.getState().refresh()
    const older = deferred()
    const newer = deferred()
    f.state.heldBot = older
    const oldRead = useBots.getState().refresh()
    await useSections.getState().unarchive('target')
    f.state.heldBot = newer
    const newRead = useBots.getState().refreshOne('owl')
    const idle = { name: 'owl', status: 'idle', status_detail: null }
    older.resolve({ bots: [idle] })
    await oldRead
    newer.resolve({ bot: idle })
    await newRead
    f.state.heldSections.resolve({ sections: [archived] })
    await metadata
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )

    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('keeps newer NeedsYou without a card above provisional Idle for the exact session', async () => {
    const f = fixture(kind)
    useTranscripts.getState().dropAll()
    useTranscripts.getState().open('target-live', 'target', [], undefined, 'owl')
    f.state.heldSections = deferred()
    const metadata = useSections.getState().refresh()
    const older = deferred()
    const newer = deferred()
    f.state.heldBot = older
    const oldRead = useBots.getState().refresh()
    f.state.heldBot = newer
    const newRead = useBots.getState().refreshOne('owl')
    older.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await oldRead
    newer.resolve({ bot: f.projection() })
    await newRead
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await metadata

    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
  })

  it('retires a prior stream immediately while Idle metadata is held', async () => {
    const f = fixture(kind)
    routeEvent({ type: 'message.start', session_id: 'target-live', payload: {} } as never)
    routeEvent({
      type: 'status.update',
      session_id: 'target-live',
      payload: { kind: 'working' }
    } as never)
    expect(f.status().bot).toBe('working')
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections
  })

  it('does not let a profile edit cancel pending active Idle authority', async () => {
    const f = fixture(kind)
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    f.call.mockImplementationOnce(async () => ({
      bot: { name: 'owl', title: 'Fresh', status: 'idle', status_detail: null }
    }))
    await useBots.getState().update('owl', { title: 'Fresh' })
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )

    expect(useBots.getState().byName.owl?.title).toBe('Fresh')
    expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
  })

  it('honors exact Working authority returned by a concurrent profile edit', async () => {
    const f = fixture(kind)
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    f.call.mockImplementationOnce(async () => ({
      bot: { ...f.projection(), title: 'Fresh', status: 'working' }
    }))
    await useBots.getState().update('owl', { title: 'Fresh' })
    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections

    expect(useBots.getState().byName.owl?.title).toBe('Fresh')
    expect(f.status()).toEqual({ section: 'working', bot: 'working' })
  })

  it('preserves a new confirmed request received while deferred Idle awaits metadata', async () => {
    const f = fixture(kind)
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    routeEvent({
      type: `${kind}.request`,
      session_id: 'target-live',
      payload: {
        request_id: 'new-request',
        question: 'Continue?',
        bot: 'owl',
        section_id: 'target'
      }
    } as never)
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual(
        expect.arrayContaining([expect.objectContaining({ requestId: 'new-request' })])
      )
    )
    expect(f.status().bot).toBe('needs_you')
  })

  it.each([true, false])(
    'uses successful archive metadata when the newer concurrent read fails=%s',
    async newerFails => {
      const f = fixture(kind)
      const older = deferred()
      const newer = deferred()
      f.state.row = { ...f.state.row, archived_at: 1 }
      f.state.heldSections = older
      const oldRead = useSections.getState().refresh()
      f.state.heldSections = newer
      const newRead = useSections.getState().refresh({ bot: 'owl' })
      await useBots.getState().refresh()
      const failed = newerFails ? newer : older
      const successful = newerFails ? older : newer
      failed.reject(new Error('Metadata unavailable'))
      successful.resolve({ sections: [f.state.row] })
      await Promise.all([oldRead, newRead])
      f.state.heldSections = null
      f.state.failBots = true
      await useSections.getState().unarchive('target')
      await useBots.getState().refresh()

      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toHaveLength(1)
      expect(f.status()).toEqual({ section: 'needs_you', bot: 'needs_you' })
    }
  )

  it('keeps canonical settlement received while archived after restore', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')
    await useBots.getState().refresh()
    routeEvent({
      type: `${kind}.resolved`,
      session_id: 'target-live',
      payload: {
        request_id: 'pending',
        bot: 'owl',
        section_id: 'target',
        ...(kind === 'approval'
          ? { choice: 'session' }
          : { status: 'answered', answers: { pending: 'Peer answer' } })
      }
    } as never)
    await useSections.getState().unarchive('target')
    f.state.failBots = true
    await useBots.getState().refresh()

    const transcript = useTranscripts.getState().bySession['target-live']!
    expect(transcript.waitingRequests).toEqual([])
    expect(transcript.answeredWaiting).toEqual({ kind, requestId: 'pending' })
    expect(transcript.approvals[0]?.decision ?? transcript.clarifies[0]?.answers.pending).toBe(
      kind === 'approval' ? 'session' : 'Peer answer'
    )
    expect(f.status()).toEqual({ section: 'working', bot: 'working' })
  })

  it('clears archived confirmation when the bot is omitted from an accepted roster', async () => {
    const f = fixture(kind)
    await useSections.getState().archive('target')
    f.state.heldBot = deferred()
    const reading = useBots.getState().refresh()
    f.state.heldBot.resolve({ bots: [] })
    await reading

    expect(useBots.getState().byName.owl).toBeUndefined()
    expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    expect(useTranscripts.getState().bySession['target-live']?.answeredWaiting).toBeUndefined()
  })

  it('does not recreate an archived transcript deleted while Idle awaits metadata', async () => {
    const f = fixture(kind)
    f.state.row = { ...f.state.row, archived_at: 1 }
    f.state.heldSections = deferred()
    const reading = f.changed()
    await reading.bots
    routeEvent(
      { type: 'hexbot.sections.changed', payload: { id: 'target', deleted: true } } as never,
      { refreshSections: vi.fn(), refreshBots: vi.fn() }
    )
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections

    expect(useTranscripts.getState().bySession['target-live']).toBeUndefined()
    expect(useSections.getState().byId.target).toBeUndefined()
  })

  it('preserves progress newer than the bot read before deferred retirement begins', async () => {
    const f = fixture(kind)
    f.state.heldSections = deferred()
    f.state.heldBot = deferred()
    const reading = f.changed()
    useTranscripts.getState().open('sibling-live', 'sibling', [], undefined, 'owl')
    routeEvent({
      type: 'status.update',
      session_id: 'sibling-live',
      payload: { kind: 'working' }
    } as never)
    f.state.heldBot.resolve({ bots: [{ name: 'owl', status: 'idle', status_detail: null }] })
    await reading.bots
    f.state.heldSections.resolve({ sections: [f.state.row] })
    await reading.sections
    await vi.waitFor(() =>
      expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
    )

    expect(useTranscripts.getState().bySession['sibling-live']?.liveStatus).toBe('working')
    expect(f.status().bot).toBe('working')
  })
})

it('does not restore a clarification that expired while archived', async () => {
  const f = fixture('clarify')
  await useSections.getState().archive('target')
  await useBots.getState().refresh()
  routeEvent({
    type: 'clarify.expire',
    session_id: 'target-live',
    payload: { request_id: 'pending' }
  } as never)
  await useSections.getState().unarchive('target')
  f.state.failBots = true
  await useBots.getState().refresh()

  expect(useTranscripts.getState().bySession['target-live']?.clarifies[0]?.expired).toBe(true)
  expect(useTranscripts.getState().bySession['target-live']?.waitingRequests).toEqual([])
  expect(f.status()).toEqual({ section: 'idle', bot: 'idle' })
})

it.each(['private', 'room'] as const)(
  'keeps raw %s NeedsYou until the exact named session has fresh proof',
  kind => {
    fixture('approval')
    const id = kind === 'room' ? 'room:r' : 'unlisted'

    const bot = {
      name: 'owl',
      status: 'needs_you',
      status_detail: {
        section_id: kind === 'room' ? 'r' : id,
        session_id: 'own-live',
        ...(kind === 'room' ? { room_id: 'r' } : {})
      }
    } as Bot

    const sections = kind === 'room' ? [] : [{ id, bot: 'owl', archived_at: null } as Section]

    const sessions = {
      'sibling-live': { sectionId: id, bot: 'cat', liveStatus: 'working' as const }
    }

    const live = liveSectionsOf(sessions as never)

    for (const rows of [[], sections]) {
      expect(botStatusWithLive(bot, rows, live, sessions)).toBe('needs_you')
      expect(
        botStatusWithLive(bot, rows, live, {
          ...sessions,
          'own-live': { sectionId: 'wrong-section', liveStatus: 'working' }
        })
      ).toBe('needs_you')
      expect(
        botStatusWithLive(bot, rows, live, {
          ...sessions,
          'own-live': { sectionId: id, bot: 'owl', liveStatus: 'working' }
        })
      ).toBe('working')
      expect(
        botStatusWithLive(bot, rows, live, {
          ...sessions,
          'own-live': { sectionId: id, bot: 'owl', liveStatus: 'idle' }
        })
      ).toBe('idle')
      expect(botStatusWithLive({ ...bot, status: 'stopped' }, rows, live, sessions)).toBe('stopped')
    }
  }
)
