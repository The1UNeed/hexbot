const data = new Map<string, string>()

export default {
  getItem: async (key: string) => data.get(key) ?? null,
  removeItem: async (key: string) => void data.delete(key),
  setItem: async (key: string, value: string) => void data.set(key, value)
}
