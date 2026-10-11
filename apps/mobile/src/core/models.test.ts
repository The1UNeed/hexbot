import { describe, it, expect } from 'vitest'
import { modelLists, providerModels, type ModelList } from './models'
import type { Rpc } from './types'
const list = (id: string): ModelList => ({ models: [{ id, label: id, provider: 'p' }] })
describe('model lists', () => {
  it('loads each provider once until cleared', async () => {
    const loads: string[] = []
    const lists = modelLists(async provider => {
      loads.push(provider)
      return list(provider)
    })
    const [a, b] = await Promise.all([lists.get('openai'), lists.get('openai')])
    expect(a).toBe(b)
    await lists.get('anthropic')
    expect(loads).toEqual(['openai', 'anthropic'])
    lists.clear()
    await lists.get('openai')
    expect(loads).toEqual(['openai', 'anthropic', 'openai'])
  })
  it('tries a failed load again', async () => {
    let calls = 0
    const lists = modelLists(async provider => {
      if (++calls === 1) throw new Error('offline')
      return list(provider)
    })
    await expect(lists.get('openai')).rejects.toThrow('offline')
    expect((await lists.get('openai')).models[0].id).toBe('openai')
  })
  it('a load from before a clear does not drop the newer one', async () => {
    let fail!: (e: Error) => void
    let calls = 0
    const lists = modelLists(provider =>
      ++calls === 1
        ? new Promise<ModelList>((_, reject) => (fail = reject))
        : Promise.resolve(list(provider))
    )
    const stale = lists.get('openai')
    lists.clear()
    const fresh = lists.get('openai')
    fail(new Error('daemon changed'))
    await expect(stale).rejects.toThrow()
    expect(lists.get('openai')).toBe(fresh)
    expect(calls).toBe(2)
  })
  it('lists recommended models first', async () => {
    const rpc = (async () => ({
      curated: [{ id: 'b', label: 'B', provider: 'p' }],
      all: [
        { id: 'a', label: 'A', provider: 'p' },
        { id: 'b', label: 'B', provider: 'p', reasoning_levels: ['high'] }
      ]
    })) as unknown as Rpc
    const { models } = await providerModels(rpc, 'p')
    expect(models.map(m => m.id)).toEqual(['b', 'a'])
    expect(models[0]).toMatchObject({ label: 'B', reasoning_levels: ['high'] })
  })
})
