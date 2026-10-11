import type * as api from '../lib/api'
import {
  botsList,
  sectionsArchive,
  sectionsCreate,
  sectionsDelete,
  sectionsList,
  sectionsOpen,
  sectionsUnarchive
} from '../lib/api'
import type { Bot, Section } from '../lib/types'

import { useBots } from './bots'
import { botStatusWithLive, liveSectionsOf, sectionStatusOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  botsList: vi.fn(),
  sectionsArchive: vi.fn(),
  sectionsCreate: vi.fn(),
  sectionsDelete: vi.fn(),
  sectionsList: vi.fn(),
  sectionsOpen: vi.fn(),
  sectionsUnarchive: vi.fn()
}))

const section = (id: string, bot = 'owl', title = id) =>
  ({ id, bot, title, archived_at: null }) as Section

const deferred = () => {
  let resolve!: (value: Awaited<ReturnType<typeof sectionsList>>) => void
  let reject!: (error: Error) => void

  const promise = new Promise<Awaited<ReturnType<typeof sectionsList>>>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  useBots.setState({ byName: {}, order: [], loading: false })
  useTranscripts.getState().dropAll()
  setTranscriptEffects({ ackApproval: vi.fn(), notify: vi.fn(), touchSection: vi.fn() })
  useSections.setState({
    byId: {},
    idsByBot: {},
    liveSessionId: {},
    sendingTitles: {},
    loading: false
  })
})

afterEach(resetTranscriptEffects)

it.each([true, false])(
  'merges full and newer scoped replies in either order (scoped first=%s)',
  async scopedFirst => {
    const full = deferred()
    const scoped = deferred()
    vi.mocked(sectionsList).mockReturnValueOnce(full.promise).mockReturnValueOnce(scoped.promise)
    const fullRefresh = useSections.getState().refresh()
    const scopedRefresh = useSections.getState().refresh({ bot: 'owl' })

    const finishFull = async () => {
      full.resolve({ sections: [section('old-owl'), section('cat', 'cat')] })
      await fullRefresh
    }

    const finishScoped = async () => {
      scoped.resolve({ sections: [section('new-owl')] })
      await scopedRefresh
    }

    if (scopedFirst) {
      await finishScoped()
      await finishFull()
    } else {
      await finishFull()
      await finishScoped()
    }

    expect(useSections.getState().idsByBot).toEqual({ owl: ['new-owl'], cat: ['cat'] })
    expect(Object.keys(useSections.getState().byId).sort()).toEqual(['cat', 'new-owl'])
    expect(useSections.getState().loading).toBe(false)
  }
)

it('lets a newer full reply replace an older scoped reply', async () => {
  const scoped = deferred()
  const full = deferred()
  vi.mocked(sectionsList).mockReturnValueOnce(scoped.promise).mockReturnValueOnce(full.promise)
  const oldRefresh = useSections.getState().refresh({ bot: 'owl' })
  const newRefresh = useSections.getState().refresh()
  full.resolve({ sections: [section('new'), section('cat', 'cat')] })
  await newRefresh
  scoped.resolve({ sections: [section('old')] })
  await oldRefresh
  expect(useSections.getState().idsByBot).toEqual({ owl: ['new'], cat: ['cat'] })
})

it.each([true, false])(
  'accepts a full reply when a newer scoped request fails (failure first=%s)',
  async failureFirst => {
    const full = deferred()
    const scoped = deferred()
    vi.mocked(sectionsList).mockReturnValueOnce(full.promise).mockReturnValueOnce(scoped.promise)
    const fullRefresh = useSections.getState().refresh()
    const scopedRefresh = useSections.getState().refresh({ bot: 'owl' })

    const fail = async () => {
      scoped.reject(new Error('offline'))
      await scopedRefresh
    }

    const accept = async () => {
      full.resolve({ sections: [section('owl'), section('cat', 'cat')] })
      await fullRefresh
    }

    if (failureFirst) {
      await fail()
      await accept()
    } else {
      await accept()
      await fail()
    }

    expect(useSections.getState().idsByBot).toEqual({ owl: ['owl'], cat: ['cat'] })
  }
)

it.each([true, false])(
  'accepts a scoped reply when a newer full request fails (failure first=%s)',
  async failureFirst => {
    useSections.setState({ byId: { cat: section('cat', 'cat') }, idsByBot: { cat: ['cat'] } })
    const scoped = deferred()
    const full = deferred()
    vi.mocked(sectionsList).mockReturnValueOnce(scoped.promise).mockReturnValueOnce(full.promise)
    const scopedRefresh = useSections.getState().refresh({ bot: 'owl' })
    const fullRefresh = useSections.getState().refresh()

    const fail = async () => {
      full.reject(new Error('offline'))
      await fullRefresh
    }

    const accept = async () => {
      scoped.resolve({ sections: [section('owl')] })
      await scopedRefresh
    }

    if (failureFirst) {
      await fail()
      await accept()
    } else {
      await accept()
      await fail()
    }

    expect(useSections.getState().idsByBot).toEqual({ owl: ['owl'], cat: ['cat'] })
  }
)

it.each([undefined, 'owl'])(
  'opening a section preserves a pending list and its older rows (%s)',
  async bot => {
    const list = deferred()
    vi.mocked(sectionsList).mockReturnValueOnce(list.promise)
    const refresh = useSections.getState().refresh({ bot })
    const opened = { ...section('current', 'owl', 'Fresh title'), live_session_id: 'live-new' }
    vi.mocked(sectionsOpen).mockResolvedValueOnce({ section: opened, messages: [] } as never)
    await useSections.getState().open('current')
    list.resolve({
      sections: [
        { ...section('current', 'owl', 'Stale title'), live_session_id: 'live-old' },
        section('older')
      ]
    })
    await refresh
    expect(useSections.getState().idsByBot.owl).toEqual(['current', 'older'])
    expect(useSections.getState().byId.current?.title).toBe('Fresh title')
    expect(useSections.getState().liveSessionId.current).toBe('live-new')
  }
)

it.each([undefined, 'owl'])('discards an older reply in the same scope (%s)', async bot => {
  const old = deferred()
  const current = deferred()
  vi.mocked(sectionsList).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const oldRefresh = useSections.getState().refresh({ bot })
  const newRefresh = useSections.getState().refresh({ bot })
  current.resolve({ sections: [section('new')] })
  await newRefresh
  old.resolve({ sections: [section('old', 'owl', 'Stale')] })
  await oldRefresh
  expect(useSections.getState().idsByBot.owl).toEqual(['new'])
})

it('keeps unrelated scopes and removes missing sections within the refreshed bot', async () => {
  useSections.setState({
    byId: { old: section('old'), cat: section('cat', 'cat') },
    idsByBot: { owl: ['old'], cat: ['cat'] }
  })
  const owl = deferred()
  const cat = deferred()
  vi.mocked(sectionsList).mockReturnValueOnce(owl.promise).mockReturnValueOnce(cat.promise)
  const owlRefresh = useSections.getState().refresh({ bot: 'owl' })
  const catRefresh = useSections.getState().refresh({ bot: 'cat' })
  cat.resolve({ sections: [section('new-cat', 'cat')] })
  await catRefresh
  owl.resolve({ sections: [] })
  await owlRefresh
  expect(useSections.getState().idsByBot).toEqual({ cat: ['new-cat'] })
  expect(useSections.getState().byId.old).toBeUndefined()
})

it.each(['archive', 'unarchive', 'remove', 'create'] as const)(
  'preserves a newer %s result against an in-flight full list',
  async action => {
    const initial = {
      ...section('s1'),
      live_session_id: 'live-old',
      archived_at: action === 'unarchive' ? 1 : null
    }

    useSections.setState({
      byId: { s1: initial },
      idsByBot: { owl: ['s1'] },
      liveSessionId: { s1: 'live-old' }
    })
    const full = deferred()
    vi.mocked(sectionsList).mockReturnValueOnce(full.promise)
    const refresh = useSections.getState().refresh()

    if (action === 'archive') {
      vi.mocked(sectionsArchive).mockResolvedValue({ section: { ...initial, archived_at: 2 } })
      await useSections.getState().archive('s1')
    } else if (action === 'unarchive') {
      vi.mocked(sectionsUnarchive).mockResolvedValue({ section: { ...initial, archived_at: null } })
      await useSections.getState().unarchive('s1')
    } else if (action === 'remove') {
      vi.mocked(sectionsDelete).mockResolvedValue({ deleted: true })
      await useSections.getState().remove('s1')
    } else {
      vi.mocked(sectionsCreate).mockResolvedValue({ section: section('s2') })
      await useSections.getState().create('owl')
    }

    full.resolve({ sections: [initial, section('cat', 'cat')] })
    await refresh
    const state = useSections.getState()
    expect(state.idsByBot.cat).toEqual(['cat'])
    expect(state.loading).toBe(false)

    if (action === 'remove') {
      expect(state.byId.s1).toBeUndefined()
      expect(state.liveSessionId.s1).toBeUndefined()
    } else if (action === 'create') {
      expect(state.idsByBot.owl).toEqual(['s2', 's1'])
    } else {
      expect(state.byId.s1?.archived_at).toBe(action === 'archive' ? 2 : null)
    }
  }
)

it('does not resurrect a deleted section when another refresh removed its row during deletion', async () => {
  const item = section('s1')
  useSections.setState({ byId: { s1: item }, idsByBot: { owl: ['s1'] } })
  let finishDelete!: (value: Awaited<ReturnType<typeof sectionsDelete>>) => void
  vi.mocked(sectionsDelete).mockReturnValueOnce(
    new Promise(resolve => {
      finishDelete = resolve
    })
  )
  const removing = useSections.getState().remove('s1')
  vi.mocked(sectionsList).mockResolvedValueOnce({ sections: [] })
  await useSections.getState().refresh()
  const old = deferred()
  vi.mocked(sectionsList).mockReturnValueOnce(old.promise)
  const refresh = useSections.getState().refresh()
  finishDelete({ deleted: true })
  await removing
  old.resolve({ sections: [item] })
  await refresh
  expect(useSections.getState().byId.s1).toBeUndefined()
  expect(useSections.getState().loading).toBe(false)
})

describe.each(['open', 'openThread'] as const)('%s snapshot authority', method => {
  const begin = () =>
    method === 'open'
      ? useSections.getState().open('s1')
      : useSections.getState().openThread('s1', 'cat')

  it.each(['working', 'idle', 'approval', 'clarify'] as const)(
    'preserves newer %s and skips an older pending question snapshot',
    async evidence => {
      const actions = useTranscripts.getState()
      actions.open('live', 's1', [])

      if (evidence === 'approval') {
        actions.approvalRequest('live', { request_id: 'answer' })
      } else if (evidence === 'clarify') {
        actions.clarifyRequest('live', { request_id: 'answer', question: 'Continue?' })
      }

      let resolve!: (value: Awaited<ReturnType<typeof sectionsOpen>>) => void
      vi.mocked(sectionsOpen).mockReturnValueOnce(
        new Promise(done => {
          resolve = done
        })
      )
      const opening = begin()

      if (evidence === 'approval') {
        actions.resolveApproval('live', 'answer', 'once')
      } else if (evidence === 'clarify') {
        actions.answerClarify('live', 'answer', 'answer', 'Yes')
      } else {
        actions.statusUpdate('live', { kind: evidence, text: '' })
      }

      const item = { ...section('s1'), live_session_id: 'live' }
      resolve({
        section: item,
        messages: [],
        pending_clarify: { request_id: 'stale', question: 'Old question?' }
      })
      await opening

      const owner = {
        name: 'owl',
        status: 'needs_you',
        status_detail: { section_id: 's1' }
      } as Bot

      const transcripts = useTranscripts.getState().bySession
      const live = liveSectionsOf(transcripts)

      expect(transcripts.live?.clarifies.some(card => card.requestId === 'stale')).toBe(false)
      expect(sectionStatusOf(owner, 's1', live)).toBe(evidence === 'idle' ? 'idle' : 'working')
      expect(botStatusWithLive(owner, [item], live, transcripts)).toBe(
        evidence === 'idle' ? 'idle' : 'working'
      )

      vi.mocked(botsList).mockResolvedValueOnce({ bots: [{ ...owner, status: 'idle' }] })
      await useBots.getState().refresh()
      const settled = liveSectionsOf(useTranscripts.getState().bySession)
      expect(sectionStatusOf(useBots.getState().byName.owl, 's1', settled)).toBe('idle')
      expect(botStatusWithLive(useBots.getState().byName.owl!, [item], settled)).toBe('idle')
    }
  )

  it('retires evidence that predates a genuinely newer snapshot request', async () => {
    const actions = useTranscripts.getState()
    actions.open('live', 's1', [])
    actions.statusUpdate('live', { kind: 'working', text: '' })
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section: { ...section('s1'), live_session_id: 'live' },
      messages: []
    })
    await begin()
    expect(useTranscripts.getState().bySession.live?.liveStatus).toBeUndefined()
  })

  it('hydrates a current pending question when no newer live event arrived', async () => {
    vi.mocked(sectionsOpen).mockResolvedValueOnce({
      section: { ...section('s1'), live_session_id: 'live' },
      messages: [],
      pending_clarify: { request_id: 'current', question: 'Continue?' }
    })
    await begin()
    const transcript = useTranscripts.getState().bySession.live
    expect(transcript?.sectionId).toBe('s1')
    expect(transcript?.liveStatus).toBe('needs_you')
    expect(transcript?.clarifies.map(card => card.requestId)).toEqual(['current'])
  })
})
