import { beforeEach, describe, expect, it, vi } from 'vitest'

import { computerControl, computerStatus, computerView } from '../lib/api'
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

  it('keeps the result of a status retry when the first read fails later', async () => {
    let rejectFirst!: (error: Error) => void

    const first = new Promise<never>((_, reject) => {
      rejectFirst = reject
    })

    vi.mocked(computerStatus).mockReturnValueOnce(first).mockResolvedValueOnce({
      activity: null,
      actor: null,
      control: 'bot',
      cursors: [],
      error: null,
      state: 'running'
    })
    const pending = useComputer.getState().refresh()
    await useComputer.getState().refresh()
    rejectFirst(new Error('First status request timed out'))
    await pending
    expect(useComputer.getState().error).toBeNull()
    expect(useComputer.getState().status?.state).toBe('running')
  })

  it('ignores a screen link failing after a reconnect', async () => {
    let rejectFirst!: (error: Error) => void

    const first = new Promise<never>((_, reject) => {
      rejectFirst = reject
    })

    vi.mocked(computerView).mockReturnValueOnce(first)
    const pending = useComputer.getState().view(false)
    useConnection.setState({ connects: 4 })
    rejectFirst(new Error('Old screen link expired'))
    expect(await pending).toBeNull()
    expect(useComputer.getState().error).toBeNull()
  })

  it('drops an answer from a daemon the app has since left', async () => {
    let answer = (_: ComputerStatus) => {}
    vi.mocked(computerControl).mockImplementationOnce(
      () => new Promise<ComputerStatus>(resolve => (answer = resolve))
    )
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:1' } })
    const pausing = useComputer.getState().control('user')
    useConnection.setState({ target: { kind: 'local', origin: 'http://127.0.0.1:2' } })
    answer({
      activity: null,
      actor: null,
      control: 'user',
      cursors: [],
      error: null,
      state: 'running'
    })
    await pausing
    expect(useComputer.getState().status).toBeNull()
  })
})
