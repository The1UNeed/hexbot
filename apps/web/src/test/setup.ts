import '@testing-library/jest-dom/vitest'

// Node 25+ defines its own `localStorage` getter, which shadows jsdom's and is
// undefined without `--localstorage-file`. Persisted stores (`stores/ui`) need
// one that works, so tests get a plain in-memory Storage when none is there.
if (!globalThis.localStorage) {
  const items = new Map<string, string>()

  const storage: Storage = {
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    get length() {
      return items.size
    },
    removeItem: key => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, String(value))
    }
  }

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

// A bot's feelings pass on a timer; a test that ends sooner must not hand
// them to the next.
afterEach(async () => {
  const { useEmotions } = await import('../stores/emotions')
  const { calm, feelings } = useEmotions.getState()

  for (const bot of Object.keys(feelings)) {
    calm(bot)
  }
})
