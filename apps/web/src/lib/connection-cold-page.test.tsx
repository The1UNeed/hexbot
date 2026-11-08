import { act, render, screen } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'

import { ProvidersSettings, SettingsPanel } from '../app/settings'
import { useConnection } from '../stores/connection'

import { ConnectionSupervisor } from './connection'
import { setActiveRpc } from './rpc'

class DaemonSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
      this.frame({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'cold' } } })
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
        ? { providers: [{ id: 'cold-provider', label: 'Cold provider', configured: false, auth_type: 'api_key', models_source: 'catalog' }] }
      : method === 'hexbot.info'
        ? { install_id: 'cold-page', one_chat: true }
        : { bots: [], rooms: [], sections: [], connectors: [], display_name: 'Alex' }

    queueMicrotask(() => this.frame({ id, result }))
  }

  close() {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close'))
  }
}

afterEach(() => {
  setActiveRpc(null)
  vi.unstubAllGlobals()
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
