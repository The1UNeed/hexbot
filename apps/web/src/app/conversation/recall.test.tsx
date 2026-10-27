import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { routeEvent } from '../../lib/events'
import { setActiveRpc } from '../../lib/rpc'
import type { Bot, DaemonInfo, Section } from '../../lib/types'
import { useBots } from '../../stores/bots'
import { useConnection } from '../../stores/connection'
import { useDrafts } from '../../stores/drafts'
import { useSections } from '../../stores/sections'
import { useTranscripts } from '../../stores/transcripts'

import { ConversationColumn } from './index'

const chat = {
  id: 'chat',
  bot: 'owl',
  title: 'chat',
  peer_bot: null,
  archived_at: null,
  message_count: 1,
  live_session_id: 'chat'
} as Section

const owl = { name: 'owl', display_name: 'Owl' } as Bot
const daemonInfo = { one_chat: true, transcript_identity: true, install_id: 'home', recall: true }

// The daemon side, as in runtime_recall.rs: only the latest user row, named
// by its input id, goes, with everything after it.
let rows: Record<string, unknown>[]

let call: ReturnType<
  typeof vi.fn<(method: string, input: Record<string, unknown>) => Promise<unknown>>
>

function daemon(method: string, input: Record<string, unknown>) {
  switch (method) {
    case 'hexbot.sections.list':
      return { sections: [chat] }

    case 'hexbot.sections.create':
      return { section: chat }

    case 'hexbot.sections.open':
      return { section: chat, messages: rows.map(row => ({ ...row })) }

    case 'prompt.submit':
      rows.push({
        role: 'user',
        row_id: `user-${rows.length}`,
        text: input.text,
        input_id: input.input_id
      })

      return { status: 'submitted', input_id: input.input_id }
    case 'session.recall': {
      const index = rows.findLastIndex(row => row.role === 'user')

      if (index < 0 || rows[index]!.input_id !== input.input_id) {
        throw new Error('Only your latest message can be recalled')
      }

      const [row] = rows.splice(index)

      return { recalled: true, text: row!.text }
    }

    case 'hexbot.bots.clear_status':
      return { bot: owl }

    default:
      return { connectors: [] }
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'first',
    daemon: daemonInfo as DaemonInfo
  })
  useBots.setState({ byName: { owl }, loaded: true })
  useSections.setState({
    byId: { chat },
    idsByBot: { owl: ['chat'] },
    liveSessionId: {},
    choosing: null
  })
  useTranscripts.setState({ bySession: {} })
  useDrafts.setState({ byId: {} })
  rows = [{ role: 'assistant', row_id: 'earlier', text: 'Earlier reply' }]
  call = vi.fn(async (method: string, input: Record<string, unknown>) => daemon(method, input))
  setActiveRpc({ call } as never)
})
afterEach(() => setActiveRpc(null))

async function mount() {
  const root = createRootRoute({ component: Outlet })

  const conversation = createRoute({
    getParentRoute: () => root,
    path: '/b/$bot/s/$section',
    component: ConversationColumn
  })

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/b/owl/s/chat'] }),
    routeTree: root.addChildren([conversation])
  })

  await router.load()
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  await waitFor(() => expect(field()).toBeEnabled())
}

const field = () => screen.getByRole('textbox', { name: 'Message' })
const recallButton = () => screen.queryByRole('button', { name: 'Recall' })

async function send(text: string) {
  fireEvent.change(field(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(screen.getByTestId('user-message')).toHaveTextContent(text))
}

async function stop(text = 'The turn was interrupted') {
  await act(async () => useTranscripts.getState().errorEvent('chat', text))
}

it('takes back the latest message after its turn stopped and puts it in the composer', async () => {
  await mount()
  await send('Read my plan')
  await stop()
  fireEvent.click(recallButton()!)
  await waitFor(() => expect(screen.queryByTestId('user-message')).toBeNull())
  const input = call.mock.calls.find(([method]) => method === 'session.recall')![1]
  expect(input).toEqual({ session_id: 'chat', input_id: expect.any(String) })
  expect(screen.queryByTestId('stopped-card')).toBeNull()
  expect(field()).toHaveValue('Read my plan')
  expect(useDrafts.getState().byId.chat).toBe('Read my plan')
})

it('keeps what was typed since, after the recalled text', async () => {
  await mount()
  await send('Read my plan')
  await stop()
  fireEvent.change(field(), { target: { value: 'and the notes' } })
  fireEvent.click(recallButton()!)
  await waitFor(() => expect(field()).toHaveValue('Read my plan\n\nand the notes'))
})

it('offers Recall only while the bot is on it or after it stopped, on a daemon that has it', async () => {
  rows.push({ role: 'user', row_id: 'user-1', text: 'Finished', input_id: 'finished' })
  rows.push({ role: 'assistant', row_id: 'reply-1', text: 'Done' })
  await mount()
  expect(await screen.findByText('Done')).toBeVisible()
  expect(recallButton()).toBeNull()
  await stop()
  expect(recallButton()).not.toBeNull()
  act(() => useConnection.setState({ daemon: { ...daemonInfo, recall: undefined } as DaemonInfo }))
  expect(recallButton()).toBeNull()
})

it('shows why a recall failed and keeps the message', async () => {
  await mount()
  await send('Read my plan')
  await stop()
  rows.push({ role: 'user', row_id: 'phone', text: 'Sent from the phone', input_id: 'phone' })
  fireEvent.click(recallButton()!)
  await waitFor(() =>
    expect(screen.getAllByTestId('stopped-card').at(-1)).toHaveTextContent(
      'Only your latest message can be recalled'
    )
  )
  expect(screen.getByTestId('user-message')).toHaveTextContent('Read my plan')
  expect(field()).toHaveValue('')
})

it('closes a Stopped card, and the bot’s Stopped state for this chat with it', async () => {
  await mount()
  await send('Read my plan')
  await stop()
  const card = screen.getByTestId('stopped-card')
  fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByTestId('stopped-card')).toBeNull()
  // The turn still stopped without an answer.
  expect(recallButton()).not.toBeNull()
  // An interrupted turn is not a Stopped state.
  expect(call.mock.calls.some(([method]) => method === 'hexbot.bots.clear_status')).toBe(false)

  act(() =>
    useBots.setState({
      byName: {
        owl: {
          ...owl,
          status: 'stopped',
          status_detail: { section_id: 'chat', since: 1_757_600_000, text: 'Notion refused.' }
        } as unknown as Bot
      }
    })
  )
  const status = await screen.findByTestId('stopped-card')
  expect(status).toHaveTextContent('Notion refused.')
  fireEvent.click(within(status).getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByTestId('stopped-card')).toBeNull()
  expect(call).toHaveBeenCalledWith('hexbot.bots.clear_status', { name: 'owl' })
})

it('drops a message recalled from another app, with its card', async () => {
  await mount()
  await send('Read my plan')
  await stop()
  const sent = rows.at(-1)!
  rows.pop()
  act(() =>
    routeEvent(
      {
        type: 'hexbot.sections.changed',
        payload: {
          id: 'chat',
          bot: 'owl',
          reload: true,
          recalled: { row_id: 'pi-1', input_id: sent.input_id }
        }
      } as never,
      { refreshBots: () => undefined, refreshSections: () => undefined }
    )
  )
  await waitFor(() => expect(screen.queryByTestId('user-message')).toBeNull())
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  expect(screen.queryByTestId('user-message')).toBeNull()
  expect(screen.queryByTestId('stopped-card')).toBeNull()
})

it('closes the cards of a message recalled from another app this view never showed', async () => {
  await mount()
  await stop()
  expect(screen.getByTestId('stopped-card')).toBeVisible()
  act(() =>
    routeEvent(
      {
        type: 'hexbot.sections.changed',
        payload: {
          id: 'chat',
          bot: 'owl',
          reload: true,
          recalled: { row_id: 'pi-9', input_id: 'phone' }
        }
      } as never,
      { refreshBots: () => undefined, refreshSections: () => undefined }
    )
  )
  expect(await screen.findByText('Earlier reply')).toBeVisible()
  await waitFor(() => expect(screen.queryByTestId('stopped-card')).toBeNull())
})

it('keeps Recall on a partly answered message after its card is closed', async () => {
  await mount()
  await send('Read my plan')
  await act(async () => {
    useTranscripts.getState().messageStart('chat')
    useTranscripts.getState().messageDelta('chat', 'Half an answer')
  })
  await stop()

  for (const card of screen.queryAllByTestId('stopped-card')) {
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }))
  }

  expect(screen.queryByTestId('stopped-card')).toBeNull()
  expect(recallButton()).not.toBeNull()
})
