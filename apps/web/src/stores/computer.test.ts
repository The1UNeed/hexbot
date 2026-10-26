import { beforeEach, describe, expect, it, vi } from 'vitest'

import { computerControl, computerStatus } from '../lib/api'
import type { ComputerStatus } from '../lib/types'

import { useComputer } from './computer'
import { useConnection } from './connection'

vi.mock('../lib/api', () => ({
  computerConfigure: vi.fn(),
  computerControl: vi.fn(),
  computerStatus: vi.fn(),
  computerStep: vi.fn(),
  computerView: vi.fn()
}))

describe('useComputer', () => {
  beforeEach(() => {
    useComputer.setState({ error: null, read: null, status: null })
    useConnection.setState({ connects: 3 })
  })

  it('counts a connection as read only once its status arrives', async () => {
    vi.mocked(computerStatus).mockRejectedValueOnce(new Error('Not connected'))
    await useComputer.getState().refresh()
    expect(useComputer.getState().read).toBeNull()
    expect(useComputer.getState().error).toBe('Not connected')

    vi.mocked(computerStatus).mockResolvedValueOnce({
      activity: null,
      actor: null,
      control: 'bot',
      cursors: [],
      error: null,
      state: 'running'
    })
    await useComputer.getState().refresh()
    expect(useComputer.getState().read).toBe(3)
    expect(useComputer.getState().status?.control).toBe('bot')
  })

  it('drops an answer from a daemon the app has since left', async () => {
    let answer = (_: ComputerStatus) => {}
    vi.mocked(computerControl).mockImplementationOnce(
      () => new Promise<ComputerStatus>(resolve => (answer = resolve))
    )
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:1' } })
    const taking = useComputer.getState().control('user')
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:2' } })
    answer({ activity: null, actor: null, control: 'user', cursors: [], error: null, state: 'running' })
    await taking
    expect(useComputer.getState().status).toBeNull()
  })
})
