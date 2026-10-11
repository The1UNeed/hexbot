import type { ModelOption, Rpc } from './types'
export interface ModelList {
  models: ModelOption[]
  error?: string
}
/** Every model a provider lists right now, recommended ones first, as in the web app. */
export async function providerModels(rpc: Rpc, provider: string): Promise<ModelList> {
  const { all, curated, error } = await rpc<{
    curated: ModelOption[]
    all: ModelOption[]
    error?: string
  }>('hexbot.models.list', { provider })
  const listed = new Map(all.map(m => [m.id, m]))
  const recommended = new Set(curated.map(m => m.id))
  return {
    error,
    models: [
      ...curated.map(m => ({ ...listed.get(m.id), ...m })),
      ...all.filter(m => !recommended.has(m.id))
    ]
  }
}
/**
 * Each provider's list, loaded once until cleared, so a new thread's model line
 * and the model pill share one request. A failed load is tried again. Clearing
 * also replaces `get`, so a screen that loads with it loads again.
 */
export function modelLists(load: (provider: string) => Promise<ModelList>) {
  let lists = new Map<string, Promise<ModelList>>()
  const reader = () => (provider: string) => {
    const known = lists.get(provider)
    if (known) return known
    const owner = lists
    const list = load(provider)
    owner.set(provider, list)
    list.catch(() => {
      if (owner.get(provider) === list) owner.delete(provider)
    })
    return list
  }
  const self = {
    get: reader(),
    clear() {
      lists = new Map()
      self.get = reader()
    }
  }
  return self
}
