import type * as api from '../lib/api'
import { botsGet, botsList } from '../lib/api'
import type { Bot } from '../lib/types'

import { useBots } from './bots'
import { liveSectionsOf, sectionStatusOf, useSections } from './sections'
import { resetTranscriptEffects, setTranscriptEffects, useTranscripts } from './transcripts'

vi.mock('../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof api>()),
  botsGet: vi.fn(),
  botsList: vi.fn()
}))

const bot = (status: Bot['status']) =>
  ({ name: 'owl', status, status_detail: { section_id: 's1' } }) as Bot

const deferred = () => {
  let resolve!: (value: Awaited<ReturnType<typeof botsList>>) => void

  const promise = new Promise<Awaited<ReturnType<typeof botsList>>>(done => {
    resolve = done
  })

  return { promise, resolve }
}

beforeEach(() => {
  useBots.setState({ byName: {}, order: [], loading: false })
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
