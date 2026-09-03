import { readStoredTarget } from './connection'

describe('initial connection target', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: () => null,
      length: 0,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    })
    delete window.hexbot
    delete window.__HERMES_AUTH_REQUIRED__
  })

  it('adopts the origin when the daemon injected its auth flag', () => {
    window.__HERMES_AUTH_REQUIRED__ = true

    expect(readStoredTarget()).toEqual({ kind: 'local' })
    expect(localStorage.getItem('hexbot.target')).toBeNull()
  })

  it('does not change Electron first-run behavior', () => {
    window.__HERMES_AUTH_REQUIRED__ = false
    window.hexbot = {} as Window['hexbot']

    expect(readStoredTarget()).toBeNull()
  })

  it('adopts an Electron E2E target when no target is stored', () => {
    window.hexbot = { e2eTarget: 'http://127.0.0.1:43123' } as Window['hexbot']

    expect(readStoredTarget()).toEqual({ kind: 'local', origin: 'http://127.0.0.1:43123' })
    expect(localStorage.getItem('hexbot.target')).toBeNull()
  })
})
