import type * as api from '../lib/api'
import {
  approvalRespond,
  botsList,
  clarifyRespond,
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
  approvalRespond: vi.fn(),
  clarifyRespond: vi.fn(),
  sectionsArchive: vi.fn(),
  sectionsCreate: vi.fn(),
  sectionsDelete: vi.fn(),
  sectionsList: vi.fn(),
  sectionsOpen: vi.fn(),
  sectionsUnarchive: vi.fn()
}))

const section = (id: string, bot = 'owl', title = id) =>
  ({ id, bot, title, archived_at: null }) as Section

const deferred = <T = Awaited<ReturnType<typeof sectionsList>>>() => {
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

  const opened = (requestId?: string): Awaited<ReturnType<typeof sectionsOpen>> => ({
    section: { ...section('s1'), live_session_id: 'live' },
    messages: [],
    ...(requestId ? { pending_clarify: { request_id: requestId, question: 'Continue?' } } : {})
  })

  it.each(['approval', 'status'] as const)(
    'hydrates a pending question when a cold client receives %s during the fetch',
    async replay => {
      let resolve!: (value: Awaited<ReturnType<typeof sectionsOpen>>) => void
      vi.mocked(sectionsOpen).mockReturnValueOnce(
        new Promise(done => {
          resolve = done
        })
      )
      const opening = begin()
      const actions = useTranscripts.getState()

      if (replay === 'approval') {
        actions.approvalRequest('live', { request_id: 'approval' })
      } else {
        actions.statusUpdate('live', { kind: 'status', text: 'Checking permissions' })
      }

      resolve({
        section: { ...section('s1'), live_session_id: 'live' },
        messages: [],
        pending_clarify: { request_id: 'question', question: 'Continue?' }
      })
      await opening
      const transcript = useTranscripts.getState().bySession.live

      expect(transcript?.sectionId).toBe('s1')
      expect(transcript?.clarifies.map(card => card.requestId)).toEqual(['question'])
      expect(transcript?.liveStatus).toBe('needs_you')
      expect(transcript?.approvals.map(card => card.requestId)).toEqual(
        replay === 'approval' ? ['approval'] : []
      )
    }
  )

  it.each(['working', 'idle', 'approval', 'clarify'] as const)(
    'preserves newer %s and hydrates only an unsettled question',
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
      const requestId = evidence === 'clarify' ? 'answer' : 'stale'

      if (evidence === 'working' || evidence === 'idle') {
        vi.mocked(sectionsOpen).mockResolvedValueOnce({ section: item, messages: [] })
      }

      resolve({
        section: item,
        messages: [],
        pending_clarify: { request_id: requestId, question: 'Old question?' }
      })
      await opening

      const owner = {
        name: 'owl',
        status: 'needs_you',
        status_detail: { section_id: 's1' }
      } as Bot

      const transcripts = useTranscripts.getState().bySession
      const live = liveSectionsOf(transcripts)

      expect(
        transcripts.live?.clarifies.some(
          card => card.requestId === requestId && !card.answers[requestId]
        )
      ).toBe(evidence === 'approval')

      const expected =
        evidence === 'approval' ? 'needs_you' : evidence === 'idle' ? 'idle' : 'working'

      expect(sectionStatusOf(owner, 's1', live)).toBe(expected)
      expect(botStatusWithLive(owner, [item], live, transcripts)).toBe(expected)
      expect(sectionsOpen).toHaveBeenCalledTimes(
        evidence === 'working' || evidence === 'idle' ? 2 : 1
      )

      const status = evidence === 'approval' ? 'working' : 'idle'
      vi.mocked(botsList).mockResolvedValueOnce({ bots: [{ ...owner, status }] })
      await useBots.getState().refresh()
      const settled = liveSectionsOf(useTranscripts.getState().bySession)
      expect(sectionStatusOf(useBots.getState().byName.owl, 's1', settled)).toBe(status)
      expect(botStatusWithLive(useBots.getState().byName.owl!, [item], settled)).toBe(status)
    }
  )

  describe.each(['replacement', 'ahead'] as const)('%s transcript', branch => {
    it.each(['other-question', 'answered-question', 'answered-approval', 'other-expiry'] as const)(
      'hydrates the pending question after unrelated %s',
      async replay => {
        const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
        vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise)
        const opening = begin()
        const actions = useTranscripts.getState()

        if (replay === 'answered-approval') {
          actions.approvalRequest('live', { request_id: 'other' })
          actions.resolveApproval('live', 'other', 'once')
        } else if (replay === 'other-expiry') {
          actions.clarifyExpire('live', 'other')
        } else {
          actions.clarifyRequest('live', { request_id: 'other', question: 'Different question?' })

          if (replay === 'answered-question') {
            actions.answerClarify('live', 'other', 'other', 'Yes')
          }
        }

        if (branch === 'ahead') {
          actions.appendUserMessage('live', 'Already visible')
        }

        fetch.resolve(opened('question'))
        await opening
        actions.clarifyRequest('live', { request_id: 'question', question: 'Duplicate replay?' })
        const transcript = useTranscripts.getState().bySession.live

        expect(transcript?.clarifies.filter(card => card.requestId === 'question')).toHaveLength(1)
        expect(transcript?.liveStatus).toBe('needs_you')
        expect(sectionsOpen).toHaveBeenCalledTimes(1)

        if (branch === 'ahead') {
          expect(transcript?.messages.some(message => message.text === 'Already visible')).toBe(
            true
          )
        }
      }
    )

    it.each(['answered', 'expired', 'cold-expired', 'partial'] as const)(
      'uses exact %s settlement without discarding a different question',
      async outcome => {
        const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
        vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise)
        const opening = begin()
        const actions = useTranscripts.getState()

        if (outcome !== 'cold-expired') {
          actions.clarifyRequest('live', {
            request_id: 'question',
            questions: [
              { qid: 'a', question: 'First?' },
              { qid: 'b', question: 'Second?' }
            ]
          })
        }

        if (outcome === 'answered' || outcome === 'partial') {
          actions.answerClarify('live', 'question', 'a', 'Yes')

          if (outcome === 'answered') {
            actions.answerClarify('live', 'question', 'b', 'No')
          }
        } else {
          actions.clarifyExpire('live', 'question')
        }

        if (branch === 'ahead') {
          actions.appendUserMessage('live', 'Already visible')
        }

        fetch.resolve(opened('question'))
        await opening
        const transcript = useTranscripts.getState().bySession.live
        const card = transcript?.clarifies.find(item => item.requestId === 'question')

        expect(Boolean(card && !card.expired && !card.answers.b)).toBe(outcome === 'partial')
        expect(transcript?.settledClarifyIds?.includes('question') ?? false).toBe(
          outcome !== 'partial'
        )
        expect(sectionsOpen).toHaveBeenCalledTimes(1)
        actions.clarifyRequest('live', { request_id: 'different', question: 'Still pending?' })
        expect(useTranscripts.getState().bySession.live?.liveStatus).toBe('needs_you')
        expect(useTranscripts.getState().bySession.live?.clarifies.at(-1)?.requestId).toBe(
          'different'
        )
      }
    )
  })

  it('hydrates a cold pending question alongside an already streaming tool event', async () => {
    const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise)
    const opening = begin()
    const actions = useTranscripts.getState()
    actions.toolStart('live', { tool_id: 'tool', name: 'terminal' })
    fetch.resolve(opened('question'))
    await opening
    const transcript = useTranscripts.getState().bySession.live

    expect(transcript?.clarifies.map(card => card.requestId)).toEqual(['question'])
    expect(
      transcript?.messages.some(message => message.toolCalls.some(tool => tool.toolId === 'tool'))
    ).toBe(true)
    expect(transcript?.liveStatus).toBe('needs_you')
    expect(sectionsOpen).toHaveBeenCalledTimes(1)
  })

  describe.each([false, true])('existing question=%s', existing => {
    it.each(['pending', 'different', 'absent', 'failed'] as const)(
      'verifies %s after the actual unrelated approval answer emits Working',
      async verification => {
        const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
        vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise)

        if (verification === 'failed') {
          vi.mocked(sectionsOpen).mockRejectedValueOnce(new Error('offline'))
        } else {
          vi.mocked(sectionsOpen).mockResolvedValueOnce(
            opened(
              verification === 'pending'
                ? 'question'
                : verification === 'different'
                  ? 'different'
                  : undefined
            )
          )
        }

        const opening = begin()
        const actions = useTranscripts.getState()

        if (existing) {
          actions.clarifyRequest('live', { request_id: 'question', question: 'Continue?' })
        }

        actions.approvalRequest('live', { request_id: 'approval' })
        const reply = deferred<Awaited<ReturnType<typeof approvalRespond>>>()
        vi.mocked(approvalRespond).mockReturnValueOnce(reply.promise)
        const answering = actions.respondApproval('live', 'approval', 'once')
        actions.statusUpdate('live', { kind: 'working', text: 'Working' })
        reply.resolve({ resolved: true })
        await answering
        fetch.resolve(opened('question'))
        await opening
        const transcript = useTranscripts.getState().bySession.live

        const pending = transcript?.clarifies.filter(
          card => !card.expired && !card.answers[card.requestId]
        )

        expect(pending?.map(card => card.requestId)).toEqual(
          verification === 'absent'
            ? []
            : verification === 'different'
              ? ['question', 'different']
              : ['question']
        )
        expect(transcript?.approvals[0]?.decision).toBe('once')
        expect(sectionsOpen).toHaveBeenCalledTimes(2)
        const owner = { name: 'owl', status: 'working', status_detail: { section_id: 's1' } } as Bot

        expect(
          sectionStatusOf(owner, 's1', liveSectionsOf(useTranscripts.getState().bySession))
        ).toBe(verification === 'absent' ? 'working' : 'needs_you')

        if (verification === 'absent') {
          vi.mocked(botsList).mockResolvedValueOnce({ bots: [{ ...owner, status: 'idle' }] })
          await useBots.getState().refresh()
          expect(
            sectionStatusOf(
              useBots.getState().byName.owl,
              's1',
              liveSectionsOf(useTranscripts.getState().bySession)
            )
          ).toBe('idle')
          expect(useTranscripts.getState().bySession.live?.settledClarifyIds).toContain('question')
        }
      }
    )
  })

  it('keeps exact answer settlement across overlapping opens and a newer Idle roster', async () => {
    const actions = useTranscripts.getState()
    actions.clarifyRequest('live', { request_id: 'question', question: 'Continue?' })
    const first = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    const second = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    vi.mocked(sectionsOpen).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const openingFirst = useSections.getState().open('s1')
    const openingSecond = begin()
    const reply = deferred<Awaited<ReturnType<typeof clarifyRespond>>>()
    vi.mocked(clarifyRespond).mockReturnValueOnce(reply.promise)
    const answering = actions.respondClarify('live', 'question', 'Yes')
    actions.statusUpdate('live', { kind: 'working', text: 'Working' })
    reply.resolve({ status: 'answered' })
    await answering
    first.resolve(opened('question'))
    await openingFirst
    vi.mocked(botsList).mockResolvedValueOnce({
      bots: [{ name: 'owl', status: 'idle', status_detail: { section_id: 's1' } } as Bot]
    })
    await useBots.getState().refresh()
    second.resolve(opened('question'))
    await openingSecond
    const transcript = useTranscripts.getState().bySession.live

    expect(transcript?.clarifies).toEqual([])
    expect(transcript?.settledClarifyIds).toContain('question')
    expect(
      sectionStatusOf(
        useBots.getState().byName.owl,
        's1',
        liveSectionsOf(useTranscripts.getState().bySession)
      )
    ).toBe('idle')
    expect(sectionsOpen).toHaveBeenCalledTimes(2)
  })

  it.each(['expiry', 'working', 'new-card', 'replacement'] as const)(
    'handles a real %s event while verification is pending',
    async event => {
      const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
      const verification = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
      const started = deferred<void>()
      vi.mocked(sectionsOpen)
        .mockReturnValueOnce(fetch.promise)
        .mockImplementationOnce(() => {
          started.resolve()

          return verification.promise
        })
      const opening = begin()
      const actions = useTranscripts.getState()
      actions.statusUpdate('live', { kind: 'working', text: 'Working' })
      fetch.resolve(opened('question'))
      await started.promise

      if (event === 'expiry') {
        actions.clarifyExpire('live', 'question')
        actions.messageComplete('live')
        actions.statusUpdate('live', { kind: 'idle', text: '' })
      } else if (event === 'working') {
        actions.approvalRequest('live', { request_id: 'other' })
        vi.mocked(approvalRespond).mockResolvedValueOnce({ resolved: true })
        actions.statusUpdate('live', { kind: 'working', text: 'Working' })
        await actions.respondApproval('live', 'other', 'once')
      } else {
        if (event === 'replacement') {
          actions.drop('live')
        }

        actions.clarifyRequest('live', {
          request_id: event === 'replacement' ? 'question' : 'different',
          question: 'New replay?'
        })
      }

      verification.resolve(opened(event === 'replacement' ? undefined : 'question'))
      await opening
      const transcript = useTranscripts.getState().bySession.live

      const pending = transcript?.clarifies.filter(
        card => !card.expired && !card.answers[card.requestId]
      )

      expect(pending?.map(card => card.requestId).sort()).toEqual(
        event === 'expiry' ? [] : event === 'new-card' ? ['different', 'question'] : ['question']
      )
      expect(transcript?.liveStatus).toBe(event === 'expiry' ? 'idle' : 'needs_you')
      expect(sectionsOpen).toHaveBeenCalledTimes(2)

      if (event === 'replacement') {
        expect(transcript?.settledClarifyIds).toBeUndefined()
      }
    }
  )

  it('remembers verified absence before an older concurrent opener returns', async () => {
    const first = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    const second = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
    vi.mocked(sectionsOpen)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(opened())
    const openingFirst = begin()
    const openingSecond = begin()
    useTranscripts.getState().statusUpdate('live', { kind: 'working', text: 'Working' })
    first.resolve(opened('question'))
    await openingFirst
    vi.mocked(botsList).mockResolvedValueOnce({
      bots: [{ name: 'owl', status: 'idle', status_detail: { section_id: 's1' } } as Bot]
    })
    await useBots.getState().refresh()
    second.resolve(opened('question'))
    await openingSecond

    expect(useTranscripts.getState().bySession.live?.clarifies).toEqual([])
    expect(useTranscripts.getState().bySession.live?.settledClarifyIds).toContain('question')
    expect(sectionsOpen).toHaveBeenCalledTimes(3)
  })

  it.each([false, true])(
    'merges a duplicate batch snapshot without inventing Waiting (complete=%s)',
    async complete => {
      const actions = useTranscripts.getState()
      actions.clarifyRequest('live', {
        request_id: 'question',
        questions: [
          { qid: 'a', question: 'First?' },
          { qid: 'b', question: 'Second?' }
        ]
      })
      actions.answerClarify('live', 'question', 'a', 'Yes')
      vi.mocked(sectionsOpen).mockResolvedValueOnce({
        ...opened(),
        pending_clarify: {
          request_id: 'question',
          questions: [
            { qid: 'a', question: 'First?' },
            { qid: 'b', question: 'Second?' }
          ],
          answers: complete ? { a: 'Yes', b: 'No' } : { a: 'Yes' }
        }
      })
      await begin()
      const transcript = useTranscripts.getState().bySession.live

      expect(transcript?.clarifies).toHaveLength(1)
      expect(transcript?.clarifies[0]?.answers).toEqual(
        complete ? { a: 'Yes', b: 'No' } : { a: 'Yes' }
      )
      expect(transcript?.liveStatus).toBe(complete ? undefined : 'needs_you')
      expect(transcript?.settledClarifyIds?.includes('question') ?? false).toBe(complete)
    }
  )

  it('does not install old answer settlement in a dropped and reopened transcript', async () => {
    const actions = useTranscripts.getState()
    actions.clarifyRequest('live', { request_id: 'question', question: 'Old question?' })
    const reply = deferred<Awaited<ReturnType<typeof clarifyRespond>>>()
    vi.mocked(clarifyRespond).mockReturnValueOnce(reply.promise)
    const answering = actions.respondClarify('live', 'question', 'Yes')
    actions.clarifyExpire('live', 'question')
    actions.drop('live')
    actions.clarifyRequest('live', { request_id: 'question', question: 'Replacement question?' })
    reply.resolve({ status: 'answered' })
    await answering
    vi.mocked(sectionsOpen).mockResolvedValueOnce(opened('question'))
    await begin()
    const transcript = useTranscripts.getState().bySession.live

    expect(transcript?.settledClarifyIds).toBeUndefined()
    expect(transcript?.clarifies[0]?.answers).toEqual({})
    expect(transcript?.liveStatus).toBe('needs_you')
  })

  describe.each([false, true])('existing completed snapshot card=%s', existing => {
    it.each([
      ['approval', false],
      ['clarify', false],
      ['approval', true],
      ['clarify', true]
    ] as const)(
      'keeps the unrelated %s answer before Working arrives (reply after snapshot=%s)',
      async (sibling, replyAfter) => {
        const actions = useTranscripts.getState()

        const questions = [
          { qid: 'a', question: 'First?' },
          { qid: 'b', question: 'Second?' }
        ]

        if (existing) {
          actions.clarifyRequest('live', { request_id: 'question', questions })
          actions.answerClarify('live', 'question', 'a', 'Yes')
        }

        const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()
        vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise)
        const opening = begin()
        const approvalReply = deferred<Awaited<ReturnType<typeof approvalRespond>>>()
        const clarifyReply = deferred<Awaited<ReturnType<typeof clarifyRespond>>>()
        let answering: Promise<void>

        if (sibling === 'approval') {
          actions.approvalRequest('live', { request_id: 'other' })
          vi.mocked(approvalRespond).mockReturnValueOnce(approvalReply.promise)
          answering = actions.respondApproval('live', 'other', 'once')
        } else {
          actions.clarifyRequest('live', { request_id: 'other', question: 'Other question?' })
          vi.mocked(clarifyRespond).mockReturnValueOnce(clarifyReply.promise)
          answering = actions.respondClarify('live', 'other', 'Yes')
        }

        const completeAnswer = async () => {
          approvalReply.resolve({ resolved: true })
          clarifyReply.resolve({ status: 'answered' })
          await answering
        }

        if (!replyAfter) {
          await completeAnswer()
        }

        fetch.resolve({
          ...opened(),
          pending_clarify: { request_id: 'question', questions, answers: { a: 'Yes', b: 'No' } }
        })
        await opening

        if (replyAfter) {
          await completeAnswer()
        }

        const transcript = useTranscripts.getState().bySession.live

        const owner = {
          name: 'owl',
          status: 'needs_you',
          status_detail: { section_id: 's1' }
        } as Bot

        const live = liveSectionsOf(useTranscripts.getState().bySession)

        expect(transcript?.answeredWaiting).toEqual({ kind: sibling, requestId: 'other' })
        expect(transcript?.settledClarifyIds).toContain('question')
        expect(sectionStatusOf(owner, 's1', live)).toBe('working')
        expect(
          botStatusWithLive(owner, [section('s1')], live, useTranscripts.getState().bySession)
        ).toBe('working')
        expect(sectionsOpen).toHaveBeenCalledTimes(1)
      }
    )

    it.each([
      ['approval', true],
      ['question', true],
      ['approval', false],
      ['question', false]
    ] as const)(
      'settles its own question while preserving %s freshness=%s',
      async (sibling, fresh) => {
        const actions = useTranscripts.getState()

        const questions = [
          { qid: 'a', question: 'First?' },
          { qid: 'b', question: 'Second?' }
        ]

        if (existing) {
          actions.clarifyRequest('live', { request_id: 'question', questions })
          actions.answerClarify('live', 'question', 'a', 'Yes')
        }

        const askSibling = () => {
          if (sibling === 'approval') {
            actions.approvalRequest('live', { request_id: 'other' })
          } else {
            actions.clarifyRequest('live', { request_id: 'other', question: 'Still pending?' })
          }
        }

        if (!fresh) {
          askSibling()
        }

        const fetch = deferred<Awaited<ReturnType<typeof sectionsOpen>>>()

        const complete = {
          ...opened(),
          pending_clarify: {
            request_id: 'question',
            questions,
            answers: { a: 'Yes', b: 'No' }
          }
        }

        vi.mocked(sectionsOpen).mockReturnValueOnce(fetch.promise).mockResolvedValueOnce(complete)
        const opening = begin()

        if (fresh) {
          askSibling()
        } else {
          actions.statusUpdate('live', { kind: 'working', text: 'Working' })
        }

        fetch.resolve(complete)
        await opening
        const transcript = useTranscripts.getState().bySession.live
        const owner = { name: 'owl', status: 'working', status_detail: { section_id: 's1' } } as Bot
        const live = liveSectionsOf(useTranscripts.getState().bySession)

        expect(transcript?.settledClarifyIds).toContain('question')
        expect(transcript?.clarifies.find(card => card.requestId === 'question')?.answers).toEqual({
          a: 'Yes',
          b: 'No'
        })
        expect(sectionStatusOf(owner, 's1', live)).toBe(fresh ? 'needs_you' : 'working')
        expect(
          botStatusWithLive(owner, [section('s1')], live, useTranscripts.getState().bySession)
        ).toBe(fresh ? 'needs_you' : 'working')
      }
    )
  })

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
