import type { StoreApi, UseBoundStore } from 'zustand'

import type { DraftsState } from './drafts'

// The persist middleware reads localStorage when the store module loads, so stub it first.
const values = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => values.get(key) ?? null,
  removeItem: (key: string) => values.delete(key),
  setItem: (key: string, value: string) => values.set(key, value)
})

const { useDrafts } = (await import('./drafts')) as { useDrafts: UseBoundStore<StoreApi<DraftsState>> }

describe('drafts', () => {
  beforeEach(() => useDrafts.setState({ byId: {} }))

  it('keeps text per section and drops blank text', () => {
    useDrafts.getState().set('s1', 'hello')
    useDrafts.getState().set('s2', '   ')
    expect(useDrafts.getState().byId).toEqual({ s1: 'hello' })

    useDrafts.getState().set('s1', '')
    expect(useDrafts.getState().byId).toEqual({})
  })

  it('clears a section', () => {
    useDrafts.getState().set('s1', 'hello')
    useDrafts.getState().clear('s1')
    expect(useDrafts.getState().byId).toEqual({})
  })
})
