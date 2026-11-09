import { act, render, screen, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'

import { ProvidersSettings, SettingsPanel } from '../app/settings'
import { useConnection } from '../stores/connection'

import { ConnectionSupervisor } from './connection'
import { setActiveRpc } from './rpc'

let install = 'cold-page'
let holdInfo: Promise<void> | null = null

class DaemonSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
      this.frame({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: install } } })
    })
  }

  frame(body: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', ...body }) }))
  }

  send(data: string) {
    const { id, method } = JSON.parse(data) as { id: string; method: string }

    const result = method === 'hexbot.memory.user.get'
      ? { text: 'Cold-page About you', path: 'user.md' }
      : method === 'hexbot.providers.list'
        ? { providers: [{ id: 'cold-provider', label: install === 'cold-page' ? 'Cold provider' : `Catalog ${install}`, configured: false, auth_type: 'api_key', models_source: 'catalog' }] }
      : method === 'hexbot.passwords.list'
        ? { logins: [{ id: 'login', title: `Catalog ${install}`, username: 'Alex', bots: null }], store: 'file' }
      : method === 'hexbot.plugins.list'
        ? { connectors: [{ id: 'connector', name: `Catalog ${install}`, description: 'A test connector', fields: [], icon: 'glyph:search', scope: 'daemon', enabled_bots: [], enabled_for_bot: null, last_error: null, state_text: 'Connected', group: 'search', state: 'ready', bots: [], ready: true }], skills: [] }
      : method === 'hexbot.info'
        ? { install_id: install, one_chat: true }
        : { bots: [], rooms: [], sections: [], connectors: [], display_name: 'Alex' }

    queueMicrotask(async () => {
      if (method === 'hexbot.info' && holdInfo) {await holdInfo}
      this.frame({ id, result })
    })
  }

  close() {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }
}

beforeEach(() => {
  install = 'cold-page'
  holdInfo = null
})

afterEach(() => {
  setActiveRpc(null)
  vi.unstubAllGlobals()
})

it.each(['providers', 'passwords', 'plugins'] as const)('keeps mounted %s loaded after delayed replacement identity clears personal state', async tab => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const target = { kind: 'local' as const, origin: window.location.origin }
  useConnection.setState({ target, epoch: null, connects: 0, daemon: null })
  setActiveRpc(null)
  install = 'first'
  const sockets: DaemonSocket[] = []

  const supervisor = new ConnectionSupervisor({
    fetch: vi.fn(async url => String(url).endsWith('/api/auth/ws-ticket')
      ? new Response('{"ticket":"cold"}') : new Response('')),
    socketFactory: () => {
      const socket = new DaemonSocket()
      sockets.push(socket)

      return socket as unknown as WebSocket
    }
  })

  try {
    render(<SettingsPanel tab={tab} />)
    await act(async () => { await supervisor.start(target) })
    expect(await screen.findByText('Catalog first')).toBeVisible()
    install = 'second'
    let release!: () => void
    holdInfo = new Promise<void>(done => { release = done })
    act(() => sockets[0]!.close())
    let reconnect!: Promise<void>
    act(() => { reconnect = supervisor.retryNow() })
    // Reconnect refresh finishes before the replacement identity is known.
    expect(await screen.findByText('Catalog second')).toBeVisible()
    await act(async () => { release(); await reconnect })
    await waitFor(() => expect(useConnection.getState().daemon?.install_id).toBe('second'))
    expect(screen.getByText('Catalog second')).toBeVisible()
  } finally {
    supervisor.stop()
  }
})

it.each(['memory', 'providers'] as const)('a cold /settings/%s page loads through the first supervisor handshake', async tab => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const target = { kind: 'local' as const, origin: window.location.origin }
  useConnection.setState({ target, epoch: null, connects: 0, daemon: null })
  setActiveRpc(null)

  const supervisor = new ConnectionSupervisor({
    fetch: vi.fn(async url => String(url).endsWith('/api/auth/ws-ticket')
      ? new Response('{"ticket":"cold"}') : new Response('')),
    socketFactory: () => new DaemonSocket() as unknown as WebSocket
  })

  try {
    // The route mounts before root startup, as on a direct browser load.
    render(tab === 'providers' ? <ProvidersSettings /> : <SettingsPanel tab="memory" />)
    await act(async () => { await supervisor.start(target) })
    expect(await screen.findByText(tab === 'providers' ? 'Cold provider' : 'Cold-page About you')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  } finally {
    supervisor.stop()
  }
})
