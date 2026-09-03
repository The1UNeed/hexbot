import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { backoffSchedule, findFreePort, parseReadyLine } from './manager'

describe('daemon helpers', () => {
  it('parses only valid ready lines', () => {
    expect(parseReadyLine('HERMES_BACKEND_READY port=9120')).toBe(9120)
    expect(parseReadyLine('noise HERMES_BACKEND_READY port=70000')).toBeUndefined()
    expect(parseReadyLine('ready port=9120')).toBeUndefined()
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
