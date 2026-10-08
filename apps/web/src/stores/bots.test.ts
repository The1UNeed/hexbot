import { describe, expect, it, vi } from 'vitest'

import { setActiveRpc } from '../lib/rpc'
import type { Bot } from '../lib/types'

import { useBots } from './bots'
import { uiActions } from './ui'

describe('deleting a bot', () => {
  it('forgets its last section, so `/` does not reopen a bot that is gone', async () => {
    const bot = (name: string) => ({ name }) as Bot
    useBots.setState({
      byName: { general: bot('general'), scout: bot('scout') },
      order: ['general', 'scout']
    })
    setActiveRpc({ call: vi.fn(() => Promise.resolve({})) } as never)

    uiActions().setLastSection({ bot: 'scout', section: 's1' })
    await useBots.getState().remove('general')
    expect(uiActions().lastSection).toEqual({ bot: 'scout', section: 's1' })

    await useBots.getState().remove('scout')
    expect(uiActions().lastSection).toBeNull()
    expect(useBots.getState().order).toEqual([])
  })
})
