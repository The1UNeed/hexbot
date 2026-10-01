import { describe, expect, it, vi } from 'vitest'

import { attachFile } from './api'
import { rpcCall } from './rpc'

vi.mock('./rpc', () => ({ rpcCall: vi.fn() }))

describe('attachment size limits', () => {
  it.each([
    ['image.png', 'image/png', 25],
    ['document.pdf', 'application/pdf', 45],
    ['document.PDF', '', 45],
    ['archive.zip', 'application/zip', 45]
  ])('rejects oversized %s before reading or sending it', async (name, type, limit) => {
    const file = new File([], name, { type })
    Object.defineProperty(file, 'size', { value: (limit as number) * 1024 * 1024 + 1 })
    await expect(attachFile('session', file)).rejects.toThrow(`attachment exceeds ${limit} MiB`)
    expect(rpcCall).not.toHaveBeenCalled()
  })

  it('sends a supported file through the existing RPC', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ attached: true })
    await expect(
      attachFile('session', new File(['hello'], 'small.txt', { type: 'text/plain' }))
    ).resolves.toEqual({ attached: true })
    expect(rpcCall).toHaveBeenCalledWith(
      'file.attach',
      expect.objectContaining({
        session_id: 'session',
        name: 'small.txt',
        data_url: 'data:text/plain;base64,aGVsbG8='
      })
    )
  })
})
