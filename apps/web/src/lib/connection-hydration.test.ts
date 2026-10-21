import { useBots } from '../stores/bots'
import { useConnection } from '../stores/connection'
import { useMe } from '../stores/me'
import { useRooms } from '../stores/rooms'
import { useSections } from '../stores/sections'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

import { ConnectionSupervisor } from './connection'
import { type HexbotRpcClient, setActiveRpc } from './rpc'
import type { DaemonInfo, Section } from './types'

const deferred = () => {
  let resolve!: (value: unknown) => void

  const promise = new Promise(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

const section = {
  id: 'existing',
  bot: 'owl',
  message_count: 3,
  archived_at: null,
  peer_bot: null
} as Section

const target = (origin: string) => ({ kind: 'local' as const, origin })
let call: ReturnType<typeof vi.fn>

function supervisor(info: Promise<unknown>) {
  const supervisor = new ConnectionSupervisor()

  // Exercise the actual hydration path with a controlled RPC client, without a socket or credentials.
  const internal = supervisor as unknown as {
    client: HexbotRpcClient
    hydrate: () => Promise<void>
  }

  internal.client = { call: () => info } as unknown as HexbotRpcClient

  return internal
}

beforeEach(() => {
  useConnection.setState({
    target: target('http://modern'),
    epoch: 'modern-epoch',
    daemon: { one_chat: true, install_id: 'modern' } as DaemonInfo
  })
  useSections.setState({ byId: {}, idsByBot: {}, liveSessionId: {}, choosing: null })
  call = vi.fn((method: string) =>
    Promise.resolve(
      method === 'hexbot.sections.list'
        ? { sections: [section] }
        : {
            section: method === 'hexbot.sections.create' ? { ...section, id: 'new-empty' } : section
          }
    )
  )
  setActiveRpc({ call } as never)
  vi.spyOn(useSettings.getState(), 'refresh').mockRejectedValue(
    new Error('Settings hydration failed')
  )
  vi.spyOn(useBots.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useRooms.getState(), 'refresh').mockResolvedValue()
  vi.spyOn(useMe.getState(), 'refresh').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  setActiveRpc(null)
})

it.each([false, true])(
  'publishes current daemon info despite unrelated hydration failure, one_chat=%s',
  async modern => {
    useConnection.getState().setDaemon({ one_chat: !modern, install_id: 'previous' } as DaemonInfo)
    useConnection.getState().setTarget(target('http://next'))
    const held = deferred()
    const hydrating = supervisor(held.promise).hydrate()
    await hydrating // The unrelated failure may finish first; info must still publish when it arrives.
    held.resolve({ one_chat: modern, install_id: 'next' })
    await vi.waitFor(() => expect(useConnection.getState().daemon?.install_id).toBe('next'))
    expect((await useSections.getState().chat('owl'))?.id).toBe(modern ? 'new-empty' : 'existing')
    expect(call.mock.calls.map(([method]) => method)).toEqual(
      modern
        ? ['hexbot.sections.create']
        : ['hexbot.sections.list', 'hexbot.checkins.status', 'hexbot.sections.unarchive']
    )
  }
)

it.each([false, true])(
  'does not create when current info is unavailable, switched=%s',
  async switched => {
    if (switched) {
      useConnection.getState().setTarget(target('http://old'))
    }

    call.mockImplementation((method: string) =>
      method === 'hexbot.info'
        ? Promise.reject(new Error('Info unavailable'))
        : Promise.resolve({ section })
    )
    await supervisor(Promise.reject(new Error('Info unavailable'))).hydrate()
    await expect(useSections.getState().chat('owl')).rejects.toThrow('Info unavailable')
    expect(useConnection.getState().daemon).toBeNull()
    expect(call.mock.calls.map(([method]) => method)).toEqual(['hexbot.info'])
  }
)

it.each(['target', 'epoch', 'client'] as const)(
  'discards info after %s changes even if hydration failed first',
  async boundary => {
    const held = deferred()
    const connection = supervisor(held.promise)
    await connection.hydrate()

    if (boundary === 'target') {
      useConnection.getState().setTarget(target('http://old'))
    }

    if (boundary === 'epoch') {
      useConnection.getState().setEpoch('old-epoch')
    }

    if (boundary === 'client') {
      connection.client = {} as HexbotRpcClient
    }

    useConnection.getState().setDaemon({ version: '0.1.6', install_id: 'old' } as DaemonInfo)
    held.resolve({ one_chat: true, install_id: 'late-modern' })
    await Promise.resolve()
    await Promise.resolve()
    expect(useConnection.getState().daemon?.install_id).toBe('old')
    expect((await useSections.getState().chat('owl'))?.id).toBe('existing')
  }
)

it('forgets capabilities at target, restart, and disconnect boundaries', () => {
  useConnection.getState().setTarget(target('http://next'))
  expect(useConnection.getState().daemon).toBeNull()
  expect(useConnection.getState().epoch).toBeNull()
  useConnection.getState().setDaemon({ one_chat: true } as DaemonInfo)
  useConnection.getState().setEpoch('next-epoch')
  expect(useConnection.getState().daemon).toBeNull()
  useConnection.getState().setDaemon({ one_chat: true } as DaemonInfo)
  useConnection.getState().clearTarget()
  expect(useConnection.getState().daemon).toBeNull()
  expect(useConnection.getState().epoch).toBeNull()
})

it('adopts install identity independently of other hydration RPCs on reconnect', async () => {
  useUi.setState({
    lastSection: { bot: 'owl', section: 'other-install-chat', daemon: 'previous-install' }
  })
  await supervisor(Promise.resolve({ install_id: 'new-install', one_chat: false })).hydrate()
  expect(useUi.getState().lastSection).toBeNull()
  expect(useConnection.getState().daemon?.install_id).toBe('new-install')
})

it('clears capability info when the supervisor stops, before reconnect hydration', () => {
  new ConnectionSupervisor().stop()
  expect(useConnection.getState().daemon).toBeNull()
})

it('keeps a remembered chat when reconnect hydration confirms the same install', async () => {
  const lastSection = { bot: 'owl', section: 'existing', daemon: 'same-install' }
  useUi.setState({ lastSection })
  await supervisor(Promise.resolve({ install_id: 'same-install', one_chat: false })).hydrate()
  expect(useUi.getState().lastSection).toEqual(lastSection)
})

it('cancels a cached capability lookup when the connection ends before its write', async () => {
  const pending = useSections.getState().chat('owl')
  new ConnectionSupervisor().stop()
  expect(await pending).toBeNull()
  expect(call).not.toHaveBeenCalled()
})

it('asks again after reconnect rather than reusing another install’s legacy choice', async () => {
  useConnection
    .getState()
    .setDaemon({ version: '0.1.6', install_id: 'first-install' } as DaemonInfo)
  const sections = [section, { ...section, id: 'another' }]
  call.mockImplementation((method: string) =>
    Promise.resolve(method === 'hexbot.sections.list' ? { sections } : { section })
  )
  const first = useSections.getState().chat('owl')
  await vi.waitFor(() => expect(useSections.getState().choosing).not.toBeNull())
  useSections.getState().choosing!.pick(section)
  await first
  new ConnectionSupervisor().stop()
  setActiveRpc({ call } as never)
  useConnection
    .getState()
    .setDaemon({ version: '0.1.6', install_id: 'second-install' } as DaemonInfo)
  const next = useSections.getState().chat('owl')
  await vi.waitFor(() => expect(useSections.getState().choosing).not.toBeNull())
  useSections.getState().choosing!.pick(null)
  expect(await next).toBeNull()
  expect(call.mock.calls.filter(([method]) => method === 'hexbot.sections.unarchive')).toHaveLength(
    1
  )
  expect(call.mock.calls.map(([method]) => method)).not.toContain('hexbot.sections.create')
})
