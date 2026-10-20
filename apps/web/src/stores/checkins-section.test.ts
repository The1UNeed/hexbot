import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { setActiveRpc } from '../lib/rpc'
import type { DaemonInfo, Section } from '../lib/types'

import { useConnection } from './connection'
import { useSections } from './sections'

const section = (id: string, updated_at: number) =>
  ({ id, bot: 'hexbot', title: id, message_count: 3, updated_at, archived_at: null }) as Section

beforeEach(() => {
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, choosing: null })
  // Check-ins from before one chat per bot: no section names its purpose.
  useConnection.setState({
    target: { kind: 'local' },
    epoch: 'process',
    daemon: { one_chat: false } as DaemonInfo
  })
})
afterEach(() => setActiveRpc(null))

it('never takes the Check-ins section of a daemon from before one chat as the chat', async () => {
  const call = vi.fn((method: string, params?: { id?: string }) =>
    Promise.resolve(
      method === 'hexbot.sections.list'
        ? { sections: [section('checkins', 9), section('chat', 2)] }
        : method === 'hexbot.checkins.status'
          ? { section_id: 'checkins' }
          : { section: section(String(params?.id), 2) }
    )
  )

  setActiveRpc({ call } as never)
  expect((await useSections.getState().chat('hexbot'))?.id).toBe('chat')
  expect(call).toHaveBeenCalledWith('hexbot.sections.unarchive', { id: 'chat' })
})
