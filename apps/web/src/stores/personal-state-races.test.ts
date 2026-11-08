import { clearPersonalState } from '../lib/roster-cache'
import { rpcCall, setActiveRpc } from '../lib/rpc'
import type { Plugin } from '../lib/types'

import { useComputer } from './computer'
import { invalidateConnectionReads, useConnection } from './connection'
import { useConnectors } from './connectors'
import { useHeartbeat } from './heartbeat'
import { usePasswords } from './passwords'
import { usePlugins } from './plugins'
import { useSettings } from './settings'

const plugin = { kind: 'skill', id: 'same', bots: ['scout'] } as Plugin
const login = { id: 'same', title: 'Current daemon login' } as never
const connector = { id: 'same', name: 'Current daemon connector' } as never

const operations: Array<[string, () => Promise<unknown>]> = [
  ['settings read', () => useSettings.getState().refresh()],
  ['settings change', () => useSettings.getState().patch({})],
  ['providers read', () => useSettings.getState().refreshProviders()],
  ['provider key save', () => useSettings.getState().setProviderKey('provider', 'key')],
  ['provider key clear', () => useSettings.getState().clearProviderKey('provider')],
  ['models read', () => useSettings.getState().refreshModels()],
  ['network read', () => useSettings.getState().refreshNetwork()],
  ['network change', () => useSettings.getState().setLanEnabled(true)],
  ['devices read', () => useSettings.getState().refreshDevices()],
  ['device revoke', () => useSettings.getState().revokeDevice('same')],
  ['connector load', () => useConnectors.getState().load('scout')],
  ['connector read', () => useConnectors.getState().refresh('scout')],
  ['connector setup', () => useConnectors.getState().setup({ bot: 'scout', id: 'same', values: {} })],
  ['connector clear', () => useConnectors.getState().clear('scout', 'same')],
  ['connector bots', () => useConnectors.getState().setForBot('scout', 'same', true)],
  ['MCP add', () => useConnectors.getState().addMcp('scout', { name: 'audit', command: 'audit' })],
  ['MCP remove', () => useConnectors.getState().removeMcp('scout', 'same')],
  ['heartbeat read', () => useHeartbeat.getState().refresh('scout')],
  ['heartbeat save', () => useHeartbeat.getState().save('scout', 'Old checklist')],
  ['heartbeat run', () => useHeartbeat.getState().runNow('scout')],
  ['old check-ins delete', () => useHeartbeat.getState().deleteEarlier('scout')],
  ['password read', () => usePasswords.getState().refresh()],
  ['password save', () => usePasswords.getState().save({ title: 'Old login' } as never)],
  ['password bots', () => usePasswords.getState().setBots('same', ['scout'])],
  ['password remove', () => usePasswords.getState().remove('same')],
  ['plugin read', () => usePlugins.getState().refresh()],
  ['plugin bots', () => usePlugins.getState().setBots(plugin, [])],
  ['plugin install', () => usePlugins.getState().install({} as never)],
  ['plugin configure', () => usePlugins.getState().configure(plugin, {} as never)],
  ['plugin remove', () => usePlugins.getState().remove(plugin)],
  ['computer read', () => useComputer.getState().refresh()],
  ['computer change', () => useComputer.getState().configure('small' as never)],
  ['computer control', () => useComputer.getState().control('user')],
  ['computer restart', () => useComputer.getState().step('restart')],
  ['computer view', () => useComputer.getState().view(false)]
]

function snapshot() {
  return JSON.stringify([
    useSettings.getState(), useConnectors.getState(), useHeartbeat.getState(),
    usePasswords.getState(), usePlugins.getState(), useComputer.getState()
  ])
}

function replacement(connectorBot = 'scout') {
  useConnection.getState().setTarget({ kind: 'local', origin: 'http://replacement.test' })
  clearPersonalState()
  useSettings.setState({
    settings: { name: 'Current settings' } as never,
    providers: [{ id: 'current' }] as never,
    network: { hostname: 'current' } as never,
    models: { all: [{ id: 'current' }] as never, curated: [] },
    devices: [{ id: 'current' }] as never
  })
  useConnectors.setState({ byBot: { [connectorBot]: [connector] } })
  useHeartbeat.setState({ byBot: { scout: { text: 'Current checklist' } as never } })
  usePasswords.setState({ logins: [login] })
  usePlugins.setState({ plugins: [plugin] })
  useComputer.setState({ status: { id: 'current' } as never })
}

beforeEach(() => {
  useConnection.getState().setTarget({ kind: 'local', origin: 'http://original.test' })
  clearPersonalState()
  useConnectors.setState({ byBot: {}, error: null, loading: false })
  useHeartbeat.setState({ byBot: {}, errors: {} })
  useSettings.setState({ error: null, loading: false })
})

afterEach(() => {
  setActiveRpc(null)
  clearPersonalState()
})

it.each(operations)('late %s cannot change another daemon or start follow-up RPCs there', async (_name, run) => {
  let resolve!: (value: unknown) => void
  const held = new Promise(yes => { resolve = yes })
  const call = vi.fn(() => held)
  setActiveRpc({ call } as never)
  useHeartbeat.setState({ byBot: { scout: { earlier_checkins: 'old' } as never } })
  const pending = run()
  // The new daemon need not have a catalog for the old daemon's bot.
  replacement(_name === 'connector load' ? 'other-bot' : 'scout')
  const current = snapshot()
  resolve({
    login: { id: 'same', title: 'Old login' },
    connector: { id: 'same', name: 'Old connector' },
    connectors: [], skills: [], packages: [], test: {}, providers: [{ id: 'old' }],
    logins: [{ id: 'old', title: 'Old login' }], store: null,
    all: [{ id: 'old' }], curated: [], devices: [{ id: 'old' }],
    text: 'Old checklist', path: '/old-view', name: 'Old settings'
  })
  await pending
  expect(snapshot()).toBe(current)
  expect(call).toHaveBeenCalledOnce()
})

const errorsOrRollbacks = operations.filter(([name]) => [
  'settings read', 'connector read', 'heartbeat read', 'password read',
  'plugin read', 'plugin bots', 'computer read', 'computer view'
].includes(name))

it.each(errorsOrRollbacks)('late failed %s cannot change another daemon or roll back its data', async (_name, run) => {
  let reject!: (error: Error) => void
  const held = new Promise((_resolve, no) => { reject = no })
  const call = vi.fn(() => held)
  setActiveRpc({ call } as never)
  useHeartbeat.setState({ byBot: { scout: { earlier_checkins: 'old' } as never } })
  const pending = run().catch(() => undefined)
  replacement()
  const current = snapshot()
  reject(new Error('Original daemon failed'))
  await pending
  expect(snapshot()).toBe(current)
  expect(call).toHaveBeenCalledOnce()
})

it('clears daemon-specific settings, connectors and checklists on authorization loss', () => {
  replacement()
  clearPersonalState()
  expect(useSettings.getState()).toMatchObject({ devices: [], providers: [], network: null, settings: null })
  expect(useConnectors.getState().byBot).toEqual({})
  expect(useHeartbeat.getState()).toMatchObject({ byBot: {}, errors: {} })
})

it('a mutation waiting for connection cannot run against a replacement daemon', async () => {
  setActiveRpc(null)
  const pending = rpcCall('hexbot.bots.delete', { name: 'scout' })
  const result = expect(pending).rejects.toThrow('not connected')
  replacement()
  const call = vi.fn()
  setActiveRpc({ call } as never)
  await result
  expect(call).not.toHaveBeenCalled()
})

it('a request waiting for the same daemon still runs when its connection opens', async () => {
  setActiveRpc(null)
  const pending = rpcCall('hexbot.settings.get')
  const call = vi.fn(() => Promise.resolve({ name: 'Original daemon' }))
  setActiveRpc({ call } as never)
  await expect(pending).resolves.toEqual({ name: 'Original daemon' })
  expect(call).toHaveBeenCalledOnce()
})

it.each(['settings', 'connectors'] as const)('%s read ends its spinner after a same-target connection drop', async store => {
  let reject!: (error: Error) => void
  const held = new Promise((_resolve, no) => { reject = no })
  setActiveRpc({ call: () => held } as never)
  const state = store === 'settings' ? useSettings : useConnectors

  const pending = store === 'settings'
    ? useSettings.getState().refresh()
    : useConnectors.getState().refresh('scout')

  expect(state.getState().loading).toBe(true)
  invalidateConnectionReads()
  reject(new Error('WebSocket closed'))
  await pending
  expect(state.getState()).toMatchObject({ error: null, loading: false })
})
