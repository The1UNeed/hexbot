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

describe('the first list', () => {
  it('stays settled when a later list starts after a failure, until reset', async () => {
    useBots.getState().reset()
    setActiveRpc({ call: vi.fn(() => Promise.reject(new Error('Daemon busy'))) } as never)
    await useBots.getState().refresh()
    expect(useBots.getState()).toMatchObject({ error: 'Daemon busy', loaded: false, settled: true })

    setActiveRpc({ call: vi.fn(() => new Promise(() => {})) } as never)
    void useBots.getState().refresh()
    expect(useBots.getState()).toMatchObject({ error: null, settled: true })

    useBots.getState().reset()
    expect(useBots.getState().settled).toBe(false)
  })
})
