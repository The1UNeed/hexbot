import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

import {
  authorizeCache,
  readCache,
  resetDeviceCacheForTests,
  suspendCache,
  writeCache
} from '../lib/device-cache'
import { clearPersonalState, keepRoster, stopRosterWrites } from '../lib/roster-cache'
import { setActiveRpc } from '../lib/rpc'
import type { CurrentUser } from '../lib/types'

import { invalidateConnectionReads, useConnection } from './connection'
import { useMe } from './me'
import { useRooms } from './rooms'

const original = { id: 'owner-a', display_name: 'Alice' } as CurrentUser
const renamed = { ...original, display_name: 'Renamed Alice' }
const replacement = { id: 'owner-b', display_name: 'Bob' } as CurrentUser
const firstScope = 'local:http://daemon-a.test'

beforeEach(async () => {
  await resetDeviceCacheForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  useConnection.setState({
    target: { kind: 'local', origin: 'http://daemon-a.test' },
    epoch: 'epoch',
    status: 'connected'
  })
  clearPersonalState()
  useMe.setState({ me: original, usageSupported: true })
  await authorizeCache(firstScope, 'daemon-a', () => true)
})

afterEach(async () => {
  stopRosterWrites()
  setActiveRpc(null)
  vi.useRealTimers()
  await resetDeviceCacheForTests()
  vi.unstubAllGlobals()
})

function startRosterWrites(scope: string) {
  useRooms.setState({ loaded: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  keepRoster(scope)
}

async function persistedRoster(scope: string) {
  await vi.advanceTimersByTimeAsync(500)
  vi.useRealTimers()
  await writeCache(scope, 'barrier', true)

  return readCache<{ me: CurrentUser }>(scope, 'roster')
}

it.each(['daemon switch', 'epoch replacement', 'reauthorization'] as const)(
  'does not publish or persist a late rename after %s',
  async change => {
    let finish!: (user: CurrentUser) => void

    const held = new Promise<CurrentUser>(resolve => {
      finish = resolve
    })

    setActiveRpc({ call: () => held } as never)
    const renaming = useMe.getState().rename(renamed.display_name)
    let scope = firstScope
    suspendCache()
    clearPersonalState()

    if (change === 'daemon switch') {
      // Same epoch: the selected target alone invalidates the old response.
      useConnection.setState({ target: { kind: 'local', origin: 'http://daemon-b.test' } })
      scope = 'local:http://daemon-b.test'
    } else if (change === 'epoch replacement') {
      useConnection.getState().setEpoch('replacement')
    } else {
      // Same target and epoch: authorization loss still invalidates old work.
      invalidateConnectionReads()
    }

    await authorizeCache(scope, 'daemon-b', () => true)
    useMe.setState({ me: replacement })
    startRosterWrites(scope)
    finish(renamed)
    await renaming
    const saved = await persistedRoster(scope)
    expect({ memory: useMe.getState().me, disk: saved?.me }).toEqual({
      memory: replacement,
      disk: replacement
    })
  }
)

it('does not repopulate personal state after authorization is lost', async () => {
  let finish!: (user: CurrentUser) => void

  const held = new Promise<CurrentUser>(resolve => {
    finish = resolve
  })

  setActiveRpc({ call: () => held } as never)
  const renaming = useMe.getState().rename(renamed.display_name)
  invalidateConnectionReads()
  suspendCache()
  clearPersonalState()
  finish(renamed)
  await renaming
  expect(useMe.getState().me).toBeNull()
})

it('publishes and persists a successful rename on the same connection', async () => {
  const call = vi.fn().mockResolvedValue(renamed)
  setActiveRpc({ call } as never)
  startRosterWrites(firstScope)
  await useMe.getState().rename(renamed.display_name)
  expect(call).toHaveBeenCalledWith('hexbot.users.me.set', { display_name: renamed.display_name })
  expect(useMe.getState().me).toEqual(renamed)
  expect(useMe.getState().usageSupported).toBe(true)
  expect((await persistedRoster(firstScope))?.me).toEqual(renamed)
})

it('preserves the current identity and propagates a failed rename', async () => {
  const error = new Error('Rename refused')
  setActiveRpc({ call: () => Promise.reject(error) } as never)
  await expect(useMe.getState().rename('Refused')).rejects.toBe(error)
  expect(useMe.getState().me).toEqual(original)
})
