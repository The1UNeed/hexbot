import { createGraphNodes, stepGraph } from './layout'

const pairs = [{ count: 4, from_bot: 'alpha', last_at: 1, to_bot: 'beta' }]

describe('activity graph layout', () => {
  it('is deterministic, finite, and bounded', () => {
    const first = createGraphNodes(pairs, 400, 240)
    expect(first).toEqual(createGraphNodes(pairs, 400, 240))
    const next = stepGraph(first, pairs, 400, 240)
    expect(next.map(node => node.id)).toEqual(['alpha', 'beta'])

    for (const node of next) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(node.x).toBeGreaterThanOrEqual(28)
      expect(node.x).toBeLessThanOrEqual(372)
    }
  })
})
