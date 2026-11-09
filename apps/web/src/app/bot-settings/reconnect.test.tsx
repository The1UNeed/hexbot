import { act, render } from '@testing-library/react'

import type { Bot, DaemonInfo } from '../../lib/types'
import { useConnection } from '../../stores/connection'
import { useConnectors } from '../../stores/connectors'
import { useHeartbeat } from '../../stores/heartbeat'

import { ConnectorsTab } from './connectors'
import { HeartbeatTab } from './heartbeat'

const bot = { name: 'scout', display_name: 'Scout' } as Bot

afterEach(() => vi.restoreAllMocks())

it.each(['connectors', 'heartbeat'] as const)('retries an interrupted first %s read when the same daemon reconnects', async tab => {
  useConnection.setState({ connects: 1, daemon: null })

  const refresh = tab === 'connectors'
    ? vi.spyOn(useConnectors.getState(), 'refresh').mockResolvedValue()
    : vi.spyOn(useHeartbeat.getState(), 'refresh').mockResolvedValue()

  render(tab === 'connectors' ? <ConnectorsTab bot={bot} /> : <HeartbeatTab bot={bot} />)
  expect(refresh).toHaveBeenCalledExactlyOnceWith('scout')
  await act(async () => { useConnection.setState({ connects: 2 }) })
  expect(refresh).toHaveBeenCalledTimes(2)
  await act(async () => { useConnection.setState({ daemon: { install_id: 'replacement' } as DaemonInfo }) })
  expect(refresh).toHaveBeenCalledTimes(3)
})
