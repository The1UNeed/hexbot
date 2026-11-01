import { cleanup, render, screen } from '@testing-library/react'

import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useSections } from '../../stores/sections'
import {
  resetTranscriptEffects,
  setTranscriptEffects,
  useTranscripts
} from '../../stores/transcripts'

import { ConversationColumn, dayLabel, sentAt } from './index'

vi.mock('@tanstack/react-router', () => {
  const router = {
    matchRoutes: () => [{ params: { bot: 'owl', section: 'chat' } }],
    history: { location: {}, subscribe: () => () => {} },
    subscribe: () => () => {}
  }

  return {
    useRouter: () => router,
    useNavigate: () => vi.fn(),
    useParams: () => ({ bot: 'owl', section: 'chat' })
  }
})

const section = {
  id: 'chat',
  bot: 'owl',
  title: 'Trip',
  live_session_id: 'chat',
  archived_at: null,
  message_count: 5,
  peer_bot: null
} as Section

// Mon 26 Oct 2026, 10:12 local time, in Unix seconds like history rows.
const start = new Date(2026, 9, 26, 10, 12).getTime() / 1000
const minutes = (n: number) => start + n * 60

const rows = [
  { role: 'user', row_id: 1, text: 'Spawn a Biology bot', timestamp: minutes(0) },
  { role: 'assistant', row_id: 2, text: 'Biology is ready.', timestamp: minutes(2) },
  { role: 'user', row_id: 3, text: 'One more thing', timestamp: minutes(12) },
  // Hours later, and the next day: a separator before each.
  { role: 'assistant', row_id: 4, text: 'Your summative is due today.', timestamp: minutes(180) },
  { role: 'assistant', row_id: 5, text: 'Still not started.', timestamp: minutes(24 * 60) }
]

beforeEach(() => {
  useSections.getState().reset()
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: { one_chat: true, transcript_identity: true } as DaemonInfo
  })
  useBots.setState({ byName: { owl: { name: 'owl', display_name: 'Owl' } as Bot }, loaded: true })
  useSections.setState({
    byId: { chat: section },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  setTranscriptEffects({ touchSection: () => {}, notify: () => {}, ackApproval: () => {} })
  setActiveRpc({
    call: vi.fn((method: string) =>
      Promise.resolve(
        method === 'hexbot.sections.open'
          ? { section, messages: rows }
          : method === 'hexbot.sections.list'
            ? { sections: [section] }
            : method === 'hexbot.sections.create'
              ? { section }
              : { connectors: [] }
      )
    )
  } as never)
})

afterEach(() => {
  cleanup()
  useSections.getState().reset()
  setActiveRpc(null)
  resetTranscriptEffects()
})

it('dates a live reply from when it finished, not when it started', () => {
  vi.useFakeTimers({ now: new Date(2026, 9, 26, 10, 0) })
  const transcripts = useTranscripts.getState()
  transcripts.messageStart('live')
  vi.setSystemTime(new Date(2026, 9, 26, 10, 30))
  transcripts.messageComplete('live', { text: 'Done.' })
  vi.useRealTimers()

  const [reply] = useTranscripts.getState().bySession.live!.messages

  expect(sentAt(reply!)).toBe(new Date(2026, 9, 26, 10, 30).getTime())
})

it('dates a reply a card closed from when the card arrived', () => {
  vi.useFakeTimers({ now: new Date(2026, 9, 26, 10, 0) })
  const transcripts = useTranscripts.getState()
  transcripts.messageStart('card')
  transcripts.messageDelta('card', 'May I run this?')
  vi.setSystemTime(new Date(2026, 9, 26, 10, 30))
  transcripts.approvalRequest('card', { command: 'ls', request_id: 'a1' })
  vi.setSystemTime(new Date(2026, 9, 26, 10, 45))
  transcripts.messageComplete('card', {})
  vi.useRealTimers()

  const [reply] = useTranscripts.getState().bySession.card!.messages

  expect(sentAt(reply!)).toBe(new Date(2026, 9, 26, 10, 30).getTime())
})

it('separates restored messages by when they were sent', async () => {
  await useSections.getState().open('chat')
  render(<ConversationColumn />)
  expect(await screen.findByText('Still not started.')).toBeVisible()

  // The chat opens on its day, then says when again after hours and on a new day.
  expect([0, 180, 24 * 60].map(at => screen.getByText(dayLabel(minutes(at))))).toHaveLength(3)
  // Minutes apart stays together.
  expect(screen.queryByText(dayLabel(minutes(2)))).toBeNull()
  expect(screen.queryByText(dayLabel(minutes(12)))).toBeNull()
})
