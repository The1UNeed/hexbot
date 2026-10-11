import type * as api from '../lib/api'
import {
  sectionsArchive,
  sectionsCreate,
  sectionsDelete,
  sectionsList,
  sectionsUnarchive
} from '../lib/api'
import type { Section } from '../lib/types'

import { useSections } from './sections'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  sectionsArchive: vi.fn(),
  sectionsCreate: vi.fn(),
  sectionsDelete: vi.fn(),
  sectionsList: vi.fn(),
  sectionsUnarchive: vi.fn()
}))

const section = (id: string, bot = 'owl', title = id) =>
  ({ id, bot, title, archived_at: null }) as Section

const deferred = () => {
  let resolve!: (value: Awaited<ReturnType<typeof sectionsList>>) => void

  const promise = new Promise<Awaited<ReturnType<typeof sectionsList>>>(done => {
    resolve = done
  })

  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSections.setState({
    byId: {},
    idsByBot: {},
    liveSessionId: {},
    sendingTitles: {},
    loading: false
  })
})

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
