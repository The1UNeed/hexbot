import { describe, expect, it, vi } from 'vitest'

import { setActiveRpc } from '../lib/rpc'
import type { Connector } from '../lib/types'

import { useConnectors } from './connectors'

describe('connector catalog for the chat', () => {
  it('loads a bot once, and quietly when the daemon refuses', async () => {
    useConnectors.setState({ byBot: {}, error: null })
    const project = { mcp: { name: 'project_tools' }, name: 'project_tools' } as Connector
    const call = vi.fn(() => Promise.resolve({ connectors: [project] }))
    setActiveRpc({ call } as never)

    await useConnectors.getState().load('scout')
    await useConnectors.getState().load('scout')
    expect(call).toHaveBeenCalledTimes(1)
    expect(useConnectors.getState().byBot.scout).toEqual([project])

    setActiveRpc({ call: vi.fn(() => Promise.reject(new Error('nope'))) } as never)
    await useConnectors.getState().load('writer')
    expect(useConnectors.getState().byBot.writer).toBeUndefined()
    expect(useConnectors.getState().error).toBeNull()
  })
})
