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

import { ConversationColumn, dayLabel } from './index'

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
  { role: 'assistant', row_id: 2, text: 'On it.', timestamp: minutes(1) },
  { role: 'assistant', row_id: 3, text: 'Biology is ready.', timestamp: minutes(2) },
  // Together but minutes apart: each keeps its own time.
  { role: 'user', row_id: 4, text: 'Thanks', timestamp: minutes(3) },
  { role: 'user', row_id: 5, text: 'One more thing', timestamp: minutes(12) },
  // Hours later: a separator first.
  { role: 'assistant', row_id: 6, text: 'Your summative is due today.', timestamp: minutes(180) }
]

const clock = (seconds: number) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(seconds * 1000))

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

it('shows when restored messages were sent, once per run', async () => {
  await useSections.getState().open('chat')
  render(<ConversationColumn />)
  expect(await screen.findByText('Your summative is due today.')).toBeVisible()

  // The chat opens on its day, and hours later says when again.
  expect(screen.getByText(dayLabel(minutes(0)))).toBeVisible()
  expect(screen.getByText(dayLabel(minutes(180)))).toBeVisible()

  // Your first message, the bot's two-message reply, your two messages nine
  // minutes apart, and the later report: one time under each run's last bubble.
  expect(screen.getAllByTestId('message-time').map(time => time.textContent)).toEqual([
    clock(minutes(0)),
    clock(minutes(2)),
    clock(minutes(3)),
    clock(minutes(12)),
    clock(minutes(180))
  ])
})
