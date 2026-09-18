import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { backoffSchedule, findFreePort, parseReadyLine, parseUpdateRequestLine } from './manager'

describe('daemon helpers', () => {
  it('parses only valid ready lines', () => {
    expect(parseReadyLine('HERMES_BACKEND_READY port=9120')).toBe(9120)
    expect(parseReadyLine('noise HERMES_BACKEND_READY port=70000')).toBeUndefined()
    expect(parseReadyLine('ready port=9120')).toBeUndefined()
  })
  it('parses the daemon update request line', () => {
    expect(parseUpdateRequestLine('HEXBOT_UPDATE_REQUESTED version=0.1.5-nightly.20260916.9')).toBe(
      '0.1.5-nightly.20260916.9'
    )
    expect(parseUpdateRequestLine('HEXBOT_UPDATE_REQUESTED version=../x')).toBeUndefined()
    expect(parseUpdateRequestLine('HERMES_BACKEND_READY port=9120')).toBeUndefined()
  })
  it('uses the specified restart backoff', () => {
    expect(backoffSchedule).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })
  it('walks ports until the mocked net server can listen', async () => {
    let attempts = 0
    const createServer = (() => {
      const server = new EventEmitter() as EventEmitter & {
        listen: (port: number, host: string, callback: () => void) => void
        close: (callback: () => void) => void
      }
      server.listen = (_port, _host, callback) => {
        attempts += 1
        if (attempts < 3) queueMicrotask(() => server.emit('error', new Error('busy')))
        else queueMicrotask(callback)
      }
      server.close = callback => callback()
      return server
    }) as never
    expect(await findFreePort(9119, createServer)).toBe(9121)
  })
})

import { describe as d2, expect as e2, it as i2 } from 'vitest'
import { parseReadyLine as p2 } from './manager'

d2('parseReadyLine dashboard mode', () => {
  i2('accepts HERMES_DASHBOARD_READY', () => {
    e2(p2('HERMES_DASHBOARD_READY port=9134')).toBe(9134)
  })
})
