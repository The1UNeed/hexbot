import type * as api from '../lib/api'
import { botsDelete, botsGet, botsList, botsUpdate } from '../lib/api'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { useRooms } from './rooms'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  botsGet: vi.fn(),
  botsList: vi.fn(),
  botsUpdate: vi.fn(),
  botsDelete: vi.fn()
}))

const bot = (status: Bot['status'], name = 'owl') =>
  ({ name, status, status_detail: { section_id: name === 'owl' ? 's1' : 's2' } }) as Bot

const deferred = <T = Awaited<ReturnType<typeof botsList>>>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  useBots.setState({ byName: {}, order: [], loading: false })
  useSections.setState({ idsByBot: {} })
  useRooms.setState({ liveTurnsByRoom: {} })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
})
afterEach(resetTranscriptEffects)

it('keeps the newest roster when list responses arrive out of order', async () => {
  const old = deferred()
  const current = deferred()
  vi.mocked(botsList).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const oldRefresh = useBots.getState().refresh()
  const newRefresh = useBots.getState().refresh()
  current.resolve({ bots: [bot('working')] })
  await newRefresh
  old.resolve({ bots: [bot('needs_you')] })
  await oldRefresh
  expect(useBots.getState().byName.owl?.status).toBe('working')
  expect(useBots.getState().loading).toBe(false)
})

it.each([true, false])(
  'accepts the only successful full roster (newer failure first=%s)',
  async failureFirst => {
    const old = deferred()
    const current = deferred()
    vi.mocked(botsList).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldRefresh = useBots.getState().refresh()
    const newRefresh = useBots.getState().refresh()

    const accept = async () => {
      old.resolve({ bots: [bot('working')] })
      await oldRefresh
    }

    const fail = async () => {
      current.reject(new Error('offline'))
      await newRefresh
    }

    if (failureFirst) {
      await fail()
      await accept()
    } else {
      await accept()
      await fail()
    }

    expect(useBots.getState().byName.owl?.status).toBe('working')
    expect(useBots.getState().loaded).toBe(true)
    expect(useBots.getState().loading).toBe(false)
    expect(useBots.getState().error).toBe('offline')
  }
)

it.each([true, false])(
  'accepts an older scoped reply after a newer full failure (%s)',
  async failureFirst => {
    const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
    const full = deferred()
    vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
    vi.mocked(botsList).mockReturnValueOnce(full.promise)
    const scopedRefresh = useBots.getState().refreshOne('owl')
    const fullRefresh = useBots.getState().refresh()

    const accept = async () => {
      scoped.resolve({ bot: bot('working') })
      await scopedRefresh
    }

    const fail = async () => {
      full.reject(new Error('offline'))
      await fullRefresh
    }

    if (failureFirst) {
      await fail()
      await accept()
    } else {
      await accept()
      await fail()
    }

    expect(useBots.getState().byName.owl?.status).toBe('working')
  }
)

it.each([true, false])(
  'accepts an older full reply after scoped and fallback failures (%s)',
  async failureFirst => {
    const full = deferred()
    const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
    vi.mocked(botsList)
      .mockReturnValueOnce(full.promise)
      .mockRejectedValueOnce(new Error('offline'))
    vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
    const fullRefresh = useBots.getState().refresh()
    const scopedRefresh = useBots.getState().refreshOne('owl')

    const accept = async () => {
      full.resolve({ bots: [bot('working')] })
      await fullRefresh
    }

    const fail = async () => {
      scoped.reject(new Error('offline'))
      await scopedRefresh
    }

    if (failureFirst) {
      await fail()
      await accept()
    } else {
      await accept()
      await fail()
    }

    expect(useBots.getState().byName.owl?.status).toBe('working')
  }
)

it.each([true, false])(
  'merges full and newer scoped rosters in either order (%s)',
  async scopedFirst => {
    const full = deferred()
    const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
    vi.mocked(botsList).mockReturnValueOnce(full.promise)
    vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
    const fullRefresh = useBots.getState().refresh()
    const scopedRefresh = useBots.getState().refreshOne('owl')

    const acceptFull = async () => {
      full.resolve({ bots: [bot('needs_you'), bot('idle', 'cat')] })
      await fullRefresh
    }

    const acceptScoped = async () => {
      scoped.resolve({ bot: bot('working') })
      await scopedRefresh
    }

    if (scopedFirst) {
      await acceptScoped()
      await acceptFull()
    } else {
      await acceptFull()
      await acceptScoped()
    }

    expect(useBots.getState().byName.owl?.status).toBe('working')
    expect(useBots.getState().byName.cat?.status).toBe('idle')
    expect(useBots.getState().order).toEqual(['owl', 'cat'])
  }
)

it('lets a newer accepted full roster supersede an older scoped reply', async () => {
  const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
  vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
  const scopedRefresh = useBots.getState().refreshOne('owl')
  vi.mocked(botsList).mockResolvedValueOnce({ bots: [bot('working')] })
  await useBots.getState().refresh()
  scoped.resolve({ bot: bot('needs_you') })
  await scopedRefresh
  expect(useBots.getState().byName.owl?.status).toBe('working')
})

it('accepts independent scopes and rejects an older reply in the same scope', async () => {
  const old = deferred<Awaited<ReturnType<typeof botsGet>>>()
  const current = deferred<Awaited<ReturnType<typeof botsGet>>>()
  const cat = deferred<Awaited<ReturnType<typeof botsGet>>>()
  vi.mocked(botsGet)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
    .mockReturnValueOnce(cat.promise)
  const oldRefresh = useBots.getState().refreshOne('owl')
  const newRefresh = useBots.getState().refreshOne('owl')
  const catRefresh = useBots.getState().refreshOne('cat')
  cat.resolve({ bot: bot('idle', 'cat') })
  await catRefresh
  current.resolve({ bot: bot('working') })
  await newRefresh
  old.resolve({ bot: bot('needs_you') })
  await oldRefresh
  expect(useBots.getState().byName.owl?.status).toBe('working')
  expect(useBots.getState().byName.cat?.status).toBe('idle')
})

it.each(['full', 'scoped'] as const)(
  'keeps a successful update against an older %s roster',
  async scope => {
    const full = deferred()
    const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
    vi.mocked(botsList).mockReturnValueOnce(full.promise)
    vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)

    const refresh =
      scope === 'full' ? useBots.getState().refresh() : useBots.getState().refreshOne('owl')

    vi.mocked(botsUpdate).mockResolvedValueOnce({ bot: bot('working') })
    await useBots.getState().update('owl', { title: 'Fresh' })
    full.resolve({ bots: [bot('needs_you'), bot('idle', 'cat')] })
    scoped.resolve({ bot: bot('needs_you') })
    await refresh
    expect(useBots.getState().byName.owl?.status).toBe('working')

    if (scope === 'full') {
      expect(useBots.getState().byName.cat?.status).toBe('idle')
    }
  }
)

it.each(['full', 'scoped'] as const)(
  'a newer accepted %s roster supersedes an older update reply',
  async scope => {
    const update = deferred<Awaited<ReturnType<typeof botsUpdate>>>()
    vi.mocked(botsUpdate).mockReturnValueOnce(update.promise)
    const updating = useBots.getState().update('owl', { title: 'Old' })
    vi.mocked(botsList).mockResolvedValueOnce({ bots: [bot('working')] })
    vi.mocked(botsGet).mockResolvedValueOnce({ bot: bot('working') })

    if (scope === 'full') {
      await useBots.getState().refresh()
    } else {
      await useBots.getState().refreshOne('owl')
    }

    update.resolve({ bot: bot('needs_you') })
    await updating
    expect(useBots.getState().byName.owl?.status).toBe('working')
  }
)

it.each(['full', 'scoped', 'update'] as const)(
  'does not resurrect a removed bot from an older %s reply',
  async scope => {
    useBots.setState({ byName: { owl: bot('working') }, order: ['owl'] })
    const full = deferred()
    const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
    const update = deferred<Awaited<ReturnType<typeof botsUpdate>>>()
    vi.mocked(botsList).mockReturnValueOnce(full.promise)
    vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
    vi.mocked(botsUpdate).mockReturnValueOnce(update.promise)

    const refresh =
      scope === 'full'
        ? useBots.getState().refresh()
        : scope === 'scoped'
          ? useBots.getState().refreshOne('owl')
          : useBots.getState().update('owl', { title: 'Old' })

    vi.mocked(botsDelete).mockResolvedValueOnce({ deleted: true })
    await useBots.getState().remove('owl')
    full.resolve({ bots: [bot('needs_you'), bot('idle', 'cat')] })
    scoped.resolve({ bot: bot('needs_you') })
    update.resolve({ bot: bot('needs_you') })
    await refresh
    expect(useBots.getState().byName.owl).toBeUndefined()
    expect(useBots.getState().order).not.toContain('owl')

    if (scope === 'full') {
      expect(useBots.getState().byName.cat?.status).toBe('idle')
    }
  }
)

it('a failed update does not suppress an older successful list', async () => {
  const full = deferred()
  vi.mocked(botsList).mockReturnValueOnce(full.promise)
  const refresh = useBots.getState().refresh()
  vi.mocked(botsUpdate).mockRejectedValueOnce(new Error('offline'))
  await expect(useBots.getState().update('owl', { title: 'Fresh' })).rejects.toThrow('offline')
  full.resolve({ bots: [bot('working')] })
  await refresh
  expect(useBots.getState().byName.owl?.status).toBe('working')
})

it('expires successful-answer evidence on the next accepted authoritative roster', async () => {
  const actions = useTranscripts.getState()
  actions.open('live', 's1', [])
  actions.approvalRequest('live', { request_id: 'approval' })
  actions.resolveApproval('live', 'approval', 'once')
  expect(
    sectionStatusOf(bot('needs_you'), 's1', liveSectionsOf(useTranscripts.getState().bySession))
  ).toBe('working')
  vi.mocked(botsList).mockResolvedValue({ bots: [bot('needs_you')] })
  await useBots.getState().refresh()
  expect(
    sectionStatusOf(
      useBots.getState().byName.owl,
      's1',
      liveSectionsOf(useTranscripts.getState().bySession)
    )
  ).toBe('needs_you')
})

it('expires only answers for that bot on a scoped authoritative reply', async () => {
  useSections.setState({ idsByBot: { owl: ['s1'], cat: ['s2'] } })
  const actions = useTranscripts.getState()

  for (const [live, section] of [
    ['l1', 's1'],
    ['l2', 's2']
  ]) {
    actions.open(live!, section!, [])
    actions.approvalRequest(live!, { request_id: 'approval' })
    actions.resolveApproval(live!, 'approval', 'once')
  }

  vi.mocked(botsGet).mockResolvedValue({ bot: bot('needs_you') })
  await useBots.getState().refreshOne('owl')
  expect(liveSectionsOf(useTranscripts.getState().bySession)).toEqual({
    s1: 'idle',
    s2: 'answered'
  })
})

it('an older full roster expires evidence only in the scopes it accepts', async () => {
  useSections.setState({ idsByBot: { owl: ['s1'], cat: ['s2'] } })
  const actions = useTranscripts.getState()
  actions.open('owl-live', 's1', [])
  actions.open('cat-live', 's2', [])
  actions.statusUpdate('cat-live', { kind: 'working', text: 'Working' })
  const full = deferred()
  vi.mocked(botsList).mockReturnValueOnce(full.promise)
  const refresh = useBots.getState().refresh()
  vi.mocked(botsGet).mockResolvedValueOnce({ bot: bot('needs_you') })
  await useBots.getState().refreshOne('owl')
  actions.statusUpdate('owl-live', { kind: 'working', text: 'Working' })
  full.resolve({ bots: [bot('idle'), bot('needs_you', 'cat')] })
  await refresh
  expect(useBots.getState().byName.owl?.status).toBe('needs_you')
  expect(useTranscripts.getState().bySession['owl-live']?.liveStatus).toBe('working')
  expect(useTranscripts.getState().bySession['cat-live']?.liveStatus).toBeUndefined()
  expect(
    sectionStatusOf(
      useBots.getState().byName.owl,
      's1',
      liveSectionsOf(useTranscripts.getState().bySession)
    )
  ).toBe('working')
})

it('scoped authority expires its named thread and room session without touching another bot in that room', async () => {
  const actions = useTranscripts.getState()

  for (const [session, section] of [
    ['thread-live', 'thread'],
    ['owl-room', 'room:r'],
    ['cat-room', 'room:r']
  ]) {
    actions.open(session!, section!, [])
    actions.statusUpdate(session!, { kind: 'working', text: 'Working' })
  }

  useBots.setState({
    byName: { owl: { ...bot('working'), status_detail: { section_id: 'thread' } } as Bot }
  })
  useRooms.setState({
    liveTurnsByRoom: {
      r: {
        owl: { bot: 'owl', live_session_id: 'owl-room', room_id: 'r', status: 'running' },
        cat: { bot: 'cat', live_session_id: 'cat-room', room_id: 'r', status: 'running' }
      }
    }
  })
  vi.mocked(botsGet).mockResolvedValueOnce({ bot: bot('idle') })
  await useBots.getState().refreshOne('owl')
  expect(useTranscripts.getState().bySession['thread-live']?.liveStatus).toBeUndefined()
  expect(useTranscripts.getState().bySession['owl-room']?.liveStatus).toBeUndefined()
  expect(useTranscripts.getState().bySession['cat-room']?.liveStatus).toBe('working')
})

describe.each(['full', 'scoped', 'update'] as const)(
  '%s snapshot and newer live evidence',
  scope => {
    it.each(['working', 'idle', 'approval', 'clarify'] as const)(
      'preserves %s installed during the request, then expires it on a newer request',
      async evidence => {
        useSections.setState({ idsByBot: { owl: ['s1'] } })
        useBots.setState({ byName: { owl: bot('needs_you') } })
        const actions = useTranscripts.getState()
        actions.open('live', 's1', [])

        if (evidence === 'approval') {
          actions.approvalRequest('live', { request_id: 'answer' })
        } else if (evidence === 'clarify') {
          actions.clarifyRequest('live', { request_id: 'answer', question: 'Continue?' })
        }

        const full = deferred()
        const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
        const update = deferred<Awaited<ReturnType<typeof botsUpdate>>>()
        vi.mocked(botsList).mockReturnValueOnce(full.promise)
        vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
        vi.mocked(botsUpdate).mockReturnValueOnce(update.promise)

        const refresh =
          scope === 'full'
            ? useBots.getState().refresh()
            : scope === 'scoped'
              ? useBots.getState().refreshOne('owl')
              : useBots.getState().update('owl', { title: 'Fresh' })

        if (evidence === 'approval') {
          actions.resolveApproval('live', 'answer', 'once')
        } else if (evidence === 'clarify') {
          actions.answerClarify('live', 'answer', 'answer', 'Yes')
        } else {
          actions.statusUpdate('live', { kind: evidence, text: '' })
        }

        full.resolve({ bots: [bot('needs_you')] })
        scoped.resolve({ bot: bot('needs_you') })
        update.resolve({ bot: bot('needs_you') })
        await refresh
        expect(
          sectionStatusOf(
            useBots.getState().byName.owl,
            's1',
            liveSectionsOf(useTranscripts.getState().bySession)
          )
        ).toBe(evidence === 'idle' ? 'idle' : 'working')
        vi.mocked(botsList).mockResolvedValueOnce({ bots: [bot('needs_you')] })
        vi.mocked(botsGet).mockResolvedValueOnce({ bot: bot('needs_you') })
        vi.mocked(botsUpdate).mockResolvedValueOnce({ bot: bot('needs_you') })

        if (scope === 'full') {
          await useBots.getState().refresh()
        } else if (scope === 'scoped') {
          await useBots.getState().refreshOne('owl')
        } else {
          await useBots.getState().update('owl', { title: 'Newer' })
        }

        expect(useTranscripts.getState().bySession.live?.answeredWaiting).toBeUndefined()
        expect(useTranscripts.getState().bySession.live?.liveStatus).toBeUndefined()
        expect(
          sectionStatusOf(
            useBots.getState().byName.owl,
            's1',
            liveSectionsOf(useTranscripts.getState().bySession)
          )
        ).toBe('needs_you')
      }
    )

    it.each([
      ['approval', 's1'],
      ['clarify', 's1'],
      ['approval', 'thread'],
      ['clarify', 'thread'],
      ['approval', 'room:r'],
      ['clarify', 'room:r']
    ])(
      'preserves a newer %s card in %s, then lets a newer roster settle the stale card status',
      async (kind, sectionId) => {
        const owner = {
          ...bot('working'),
          status_detail: {
            section_id: sectionId === 'room:r' ? null : sectionId,
            room_id: sectionId === 'room:r' ? 'r' : null,
            session_id: 'live'
          }
        } as Bot

        useSections.setState({ idsByBot: { owl: sectionId === 's1' ? ['s1'] : [] } })
        useBots.setState({ byName: { owl: owner } })
        const actions = useTranscripts.getState()
        actions.open('live', sectionId!, [])
        const full = deferred()
        const scoped = deferred<Awaited<ReturnType<typeof botsGet>>>()
        const update = deferred<Awaited<ReturnType<typeof botsUpdate>>>()
        vi.mocked(botsList).mockReturnValueOnce(full.promise)
        vi.mocked(botsGet).mockReturnValueOnce(scoped.promise)
        vi.mocked(botsUpdate).mockReturnValueOnce(update.promise)

        const refresh =
          scope === 'full'
            ? useBots.getState().refresh()
            : scope === 'scoped'
              ? useBots.getState().refreshOne('owl')
              : useBots.getState().update('owl', { title: 'Fresh' })

        if (kind === 'approval') {
          actions.approvalRequest('live', { request_id: 'new-card' })
        } else {
          actions.clarifyRequest('live', { request_id: 'new-card', question: 'Continue?' })
        }

        full.resolve({ bots: [owner] })
        scoped.resolve({ bot: owner })
        update.resolve({ bot: owner })
        await refresh
        const listed = sectionId === 's1' ? [{ id: 's1', bot: 'owl' } as Section] : []
        const live = liveSectionsOf(useTranscripts.getState().bySession)
        expect(sectionStatusOf(useBots.getState().byName.owl, sectionId!, live)).toBe('needs_you')
        expect(
          botStatusWithLive(
            useBots.getState().byName.owl!,
            listed,
            live,
            useTranscripts.getState().bySession
          )
        ).toBe('needs_you')
        vi.mocked(botsList).mockResolvedValueOnce({ bots: [owner] })
        vi.mocked(botsGet).mockResolvedValueOnce({ bot: owner })
        vi.mocked(botsUpdate).mockResolvedValueOnce({ bot: owner })

        if (scope === 'full') {
          await useBots.getState().refresh()
        } else if (scope === 'scoped') {
          await useBots.getState().refreshOne('owl')
        } else {
          await useBots.getState().update('owl', { title: 'Newer' })
        }

        const settled = liveSectionsOf(useTranscripts.getState().bySession)

        if (sectionId !== 'room:r') {
          expect(sectionStatusOf(useBots.getState().byName.owl, sectionId!, settled)).toBe(
            'working'
          )
        }

        expect(
          botStatusWithLive(
            useBots.getState().byName.owl!,
            listed,
            settled,
            useTranscripts.getState().bySession
          )
        ).toBe('working')
      }
    )
  }
)
