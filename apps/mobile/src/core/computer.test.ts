import { describe, expect, it } from 'vitest'

import { computerActivity, screenPlays } from './computer'

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
