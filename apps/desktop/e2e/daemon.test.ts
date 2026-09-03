import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { parseReadyPort, pickFreePort } from './daemon'

describe('E2E daemon helpers', () => {
  it('accepts both daemon readiness messages', () => {
    expect(parseReadyPort('HERMES_BACKEND_READY port=9120')).toBe(9120)
    expect(parseReadyPort('noise HERMES_DASHBOARD_READY port=9134')).toBe(9134)
    expect(parseReadyPort('HERMES_BACKEND_READY port=70000')).toBeUndefined()
    expect(parseReadyPort('ready port=9120')).toBeUndefined()
  })

  it('returns the ephemeral port selected by the server', async () => {
    const server = new EventEmitter() as EventEmitter & {
      address(): { address: string; family: string; port: number }
      close(callback?: (error?: Error) => void): void
      listen(port: number, host: string, callback: () => void): void
    }
    server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 42_123 })
    server.close = callback => callback?.()
    server.listen = (_port, _host, callback) => queueMicrotask(callback)

    expect(await pickFreePort((() => server) as never)).toBe(42_123)
  })
})
