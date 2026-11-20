import { describe, expect, it } from 'vitest'

import {
  addNotice,
  computerAccess,
  computerActivity,
  currentComputers,
  latestReads,
  offersComputer,
  screenPlays
} from './computer'
import type { Bot, Computer } from './types'

describe('computerActivity', () => {
  it('says what a bot does on the computer', () => {
    expect(computerActivity('Scout', 'click')).toBe('Scout is clicking on the computer')
    expect(computerActivity('Scout', 'type')).toBe('Scout is typing on the computer')
    expect(computerActivity('Scout', 'teleport')).toBe('Scout is using the computer')
  })
})

describe('screenPlays', () => {
  it('plays over HTTPS and on the daemon itself, not over plain HTTP on the network', () => {
    expect(screenPlays('https://4fbb68407966e3ec.hexconnect.app')).toBe(true)
    expect(screenPlays('http://127.0.0.1:9119')).toBe(true)
    expect(screenPlays('http://localhost:9119')).toBe(true)
    expect(screenPlays('http://192.168.1.10:9119')).toBe(false)
    expect(screenPlays('http://100.101.102.103:9119')).toBe(false)
  })
})

describe('computerAccess', () => {
  // Computer use from this computer's desktop, not the bots' computer.
  const bot = { name: 'scout', tools: ['computer_use'] } as Bot
  const vm = (change: Partial<Computer> = {}) =>
    ({ desktop: { available: true, bots: [] }, id: 'vm', on: true, ...change }) as Computer

  it('waits for the list of computers before it shows the screen', () => {
    expect(computerAccess(bot, 'loading', undefined)).toBe('loading')
    expect(computerAccess(bot, { error: 'The daemon is busy' }, undefined)).toEqual({
      error: 'The daemon is busy'
    })
  })

  it("goes by the bot's place on the bots' computer, not its desktop elsewhere", () => {
    expect(computerAccess(bot, 'listed', vm({ on: false }))).toBe('off')
    expect(computerAccess(bot, 'listed', vm())).toBe('enable')
    expect(computerAccess(bot, 'listed', vm({ desktop: { available: true, bots: ['scout'] } }))).toBe(
      'screen'
    )
  })

  it('stops trusting the list when a later read of it fails', () => {
    // The list kept from the read before still names the grant.
    const granted = vm({ desktop: { available: true, bots: ['scout'] } })
    expect(computerAccess(bot, 'listed', granted)).toBe('screen')
    expect(computerAccess(bot, { error: 'The daemon is busy' }, granted)).toEqual({
      error: 'The daemon is busy'
    })
  })

  it('waits for a reconnect\'s own read, not the grants held from before', () => {
    const granted = vm({ desktop: { available: true, bots: ['scout'] } })
    expect(computerAccess(bot, 'loading', granted)).toBe('loading')
  })

  it("goes by the bot's tools only on a daemon from before computers", () => {
    expect(computerAccess(bot, 'older', undefined)).toBe('screen')
    expect(computerAccess({ ...bot, tools: [] }, 'older', undefined)).toBe('enable')
  })

  it('shows the screen when no bot opened the card', () => {
    expect(computerAccess(undefined, 'loading', undefined)).toBe('screen')
  })
})

describe('currentComputers', () => {
  const held = [{ id: 'vm' }] as Computer[]

  it("shows Settings, Computers only a list this connection read", () => {
    expect(currentComputers('listed', held)).toBe(held)
    // After a reconnect, or when this connection's read failed, the list held
    // from before may name grants changed meanwhile.
    expect(currentComputers('loading', held)).toBeNull()
    expect(currentComputers({ error: 'The daemon is busy' }, held)).toBeNull()
    expect(currentComputers('older', held)).toBeNull()
  })
})

describe('latestReads', () => {
  it('counts only the latest read, whichever answers last', () => {
    const reads = latestReads()
    const older = reads.start()
    const newer = reads.start()
    // The newer read answers first; the older one, failing later, is stale
    // and must not reach the list or the page.
    expect(newer()).toBe(true)
    expect(older()).toBe(false)
  })

  it('makes every read on its way stale after a reconnect', () => {
    const reads = latestReads()
    const before = reads.start()
    reads.drop()
    expect(before()).toBe(false)
    expect(reads.start()()).toBe(true)
  })
})

describe('addNotice', () => {
  it("keeps each computer's unread notice through other Forgets", () => {
    const macbook = "MacBook didn't confirm that bots stopped there."
    const studio = "studio didn't confirm that bots stopped there."
    let notices = addNotice([], macbook)
    // Another computer forgotten cleanly leaves it.
    notices = addNotice(notices, null)
    expect(notices).toEqual([macbook])
    notices = addNotice(notices, studio)
    expect(notices).toEqual([macbook, studio])
    // The same one again isn't shown twice.
    expect(addNotice(notices, macbook)).toEqual([macbook, studio])
  })
})

describe('offersComputer', () => {
  it("offers the card on a daemon with computers, whose bots' tools never list Computer Use", () => {
    // A current daemon's bot: Computer Use is a plugin, not in its tools.
    const bot = { available_tools: ['terminal', 'files'], tools: ['files'] } as Bot
    expect(offersComputer('listed', bot)).toBe(true)
    expect(offersComputer('loading', bot)).toBe(true)
    expect(offersComputer({ error: 'busy' }, bot)).toBe(true)
  })

  it('offers it on a daemon from before computers only to a bot with the tool', () => {
    expect(offersComputer('older', { available_tools: ['files'], tools: [] } as unknown as Bot)).toBe(false)
    expect(offersComputer('older', { available_tools: ['computer_use'], tools: [] } as unknown as Bot)).toBe(true)
  })
})
