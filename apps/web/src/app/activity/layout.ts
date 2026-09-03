import type { ActivityPair } from '../../lib/types'

export interface GraphNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

export function createGraphNodes(
  pairs: ActivityPair[],
  width: number,
  height: number
): GraphNode[] {
  const ids = [...new Set(pairs.flatMap(pair => [pair.from_bot, pair.to_bot]))].sort()

  return ids.map((id, index) => {
    const angle = (index / Math.max(1, ids.length)) * Math.PI * 2

    return {
      id,
      x: width / 2 + Math.cos(angle) * width * 0.3,
      y: height / 2 + Math.sin(angle) * height * 0.3,
      vx: 0,
      vy: 0
    }
  })
}

export function stepGraph(
  nodes: GraphNode[],
  pairs: ActivityPair[],
  width: number,
  height: number
): GraphNode[] {
  const next = nodes.map(node => ({ ...node }))
  const byId = new Map(next.map(node => [node.id, node]))

  for (let i = 0; i < next.length; i += 1)
    {for (let j = i + 1; j < next.length; j += 1) {
      const a = next[i]!,
        b = next[j]!,
        dx = b.x - a.x || 0.1,
        dy = b.y - a.y || 0.1

      const distance2 = Math.max(100, dx * dx + dy * dy),
        force = 900 / distance2

      a.vx -= dx * force
      a.vy -= dy * force
      b.vx += dx * force
      b.vy += dy * force
    }}

  for (const pair of pairs) {
    const a = byId.get(pair.from_bot),
      b = byId.get(pair.to_bot)

    if (!a || !b) {continue}

    const dx = b.x - a.x,
      dy = b.y - a.y,
      distance = Math.max(1, Math.hypot(dx, dy)),
      force = (distance - 130) * 0.002 * Math.min(4, Math.sqrt(pair.count))

    a.vx += (dx / distance) * force
    a.vy += (dy / distance) * force
    b.vx -= (dx / distance) * force
    b.vy -= (dy / distance) * force
  }

  return next.map(node => ({
    ...node,
    vx: node.vx * 0.82 + (width / 2 - node.x) * 0.0008,
    vy: node.vy * 0.82 + (height / 2 - node.y) * 0.0008,
    x: Math.max(28, Math.min(width - 28, node.x + node.vx)),
    y: Math.max(28, Math.min(height - 28, node.y + node.vy))
  }))
}
