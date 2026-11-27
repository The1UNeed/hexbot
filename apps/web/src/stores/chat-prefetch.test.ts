import type * as api from '../lib/api'
import { sectionsCreate, sectionsHistory } from '../lib/api'
import type { Bot, DaemonInfo, Section } from '../lib/types'

import { useBots } from './bots'
import { prefetchChats, resetChatPrefetchForTests } from './chat-prefetch'
import { useConnection } from './connection'
import { useSections } from './sections'

vi.mock('../lib/api', async original => ({
  ...(await original<typeof api>()),
  sectionsCreate: vi.fn(),
  sectionsHistory: vi.fn()
}))

const daemon = {
  install_id: 'daemon',
  one_chat: true,
  section_history: true
} as DaemonInfo

const bot = (name: string, last_activity_at = 1) =>
  ({ name, last_activity_at, sections_recent: [], status: 'idle' }) as unknown as Bot

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => (resolve = yes))

  return { promise, resolve }
}

const read = { history_cursor: 'c', history_delta: false, messages: [] }
const asked = () => vi.mocked(sectionsHistory).mock.calls.map(([id]) => id)

const roster = (...bots: Bot[]) =>
  useBots.setState({
    byName: Object.fromEntries(bots.map(item => [item.name, item])),
    loaded: true,
    order: bots.map(item => item.name)
  })

beforeEach(() => {
  resetChatPrefetchForTests()
  vi.resetAllMocks()
  vi.mocked(sectionsCreate).mockImplementation(
    async name => ({ section: { bot: name, id: `${name}-chat` } as Section })
  )
  useConnection.setState({
    daemon,
    epoch: 'first',
    status: 'connected',
    target: { kind: 'local' }
  })
  useSections.getState().reset()
  roster(bot('a'), bot('b'), bot('c'))
  resetChatPrefetchForTests()
  vi.mocked(sectionsHistory).mockReset()
})

it("a new connection reads every chat, even while the old one's reads finish", async () => {
  const slow = deferred<typeof read>()
  vi.mocked(sectionsHistory).mockReturnValue(slow.promise)
  prefetchChats()
  await vi.waitFor(() => expect(asked()).toEqual(['a-chat', 'b-chat']))

  vi.mocked(sectionsHistory).mockResolvedValue(read)
  useConnection.setState({ epoch: 'second' })
  slow.resolve(read)

  await vi.waitFor(() => expect(asked().slice(2).sort()).toEqual(['a-chat', 'b-chat', 'c-chat']))
})

it('tries a chat whose read failed again when the list changes', async () => {
  vi.mocked(sectionsHistory).mockImplementation(async id => {
    if (id === 'a-chat') {
      throw new Error('offline')
    }

    return read
  })
  prefetchChats()
  await vi.waitFor(() => expect(asked().sort()).toEqual(['a-chat', 'b-chat', 'c-chat']))

  vi.mocked(sectionsHistory).mockResolvedValue(read)
  // Another bot wrote; the failed one has nothing new, but was never read.
  roster(bot('a'), bot('b'), bot('c', 2))

  await vi.waitFor(() => expect(asked().slice(3).sort()).toEqual(['a-chat', 'c-chat']))
})

it('reads each chat once when asked again before or after it is read', async () => {
  const slow = deferred<typeof read>()
  vi.mocked(sectionsHistory).mockReturnValue(slow.promise)
  prefetchChats()
  await vi.waitFor(() => expect(asked()).toEqual(['a-chat', 'b-chat']))

  // The roster loading again while the first reads wait.
  prefetchChats()
  slow.resolve(read)
  await vi.waitFor(() => expect(asked().sort()).toEqual(['a-chat', 'b-chat', 'c-chat']))
  prefetchChats()
  await new Promise(resolve => setTimeout(resolve, 20))

  expect(asked()).toHaveLength(3)
})
