import type { PairingReply } from '@hermes/shared'
import { afterEach, expect, it, vi } from 'vitest'

import { pair, pairingReply, pairWithGrant } from '../main/pair'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: { sendSync: () => ({}), invoke: ipc.invoke }
}))

afterEach(() => vi.unstubAllGlobals())

it.each(['hexbot:pair', 'hexbot:pair-with-grant'])(
  'carries codes and clock data through %s without an IPC exception',
  async channel => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'dpop_clock_skew',
              server_time: 1000,
              proof_time: 1600
            }),
            { status: 401, headers: { 'retry-after': '3' } }
          )
      )
    )
    ipc.invoke.mockImplementation(async (name, input) => {
      expect(name).toBe(channel)

      const reply = await pairingReply<unknown>(() =>
        name === 'hexbot:pair' ? pair(input) : pairWithGrant(input)
      )

      // Electron carries the envelope as plain structured data, without Error prototypes.
      return structuredClone(reply)
    })
    await import('./index')

    const bridge = ipc.expose.mock.calls[0]![1] as {
      pair: (...args: unknown[]) => Promise<PairingReply<unknown>>
      pairWithGrant: (...args: unknown[]) => Promise<PairingReply<unknown>>
    }

    const reply =
      channel === 'hexbot:pair'
        ? await bridge.pair('daemon.test', 9119, 'CODE', 'Laptop', 'proof')
        : await bridge.pairWithGrant({
            host: 'daemon.test',
            grant: 'grant',
            deviceName: 'Laptop',
            proof: 'proof'
          })

    expect(reply).toEqual({
      ok: false,
      error: {
        code: 'dpop_clock_skew',
        serverTime: 1000,
        proofTime: 1600,
        retryAfterMs: 3000
      }
    })
    expect(JSON.stringify(reply)).not.toContain('message')
  }
)

it('returns only a known code for unexpected pairing failures', async () => {
  expect(
    await pairingReply(async () => {
      throw new Error('raw network diagnostic')
    })
  ).toEqual({ ok: false, error: { code: 'unreachable' } })
})

it('preserves successful pairing values through the preload envelope', async () => {
  ipc.invoke.mockImplementation(async channel => structuredClone(await pairingReply(async () =>
    channel === 'hexbot:pair' ? { deviceToken: 'token', daemonName: 'Studio' } : 'grant-token'
  )))
  await import('./index')
  const bridge = ipc.expose.mock.calls[0]![1]
  expect(await bridge.pair('daemon.test', 9119, 'CODE', 'Laptop')).toEqual({
    ok: true, value: { daemon_name: 'Studio', device_id: '', device_token: 'token' }
  })
  expect(await bridge.pairWithGrant({ host: 'daemon.test', grant: 'grant', deviceName: 'Laptop' })).toEqual({
    ok: true, value: { daemon_name: 'daemon.test', device_id: '', device_token: 'grant-token' }
  })
})
