import { describe, expect, it } from 'vitest'

import { AVATAR_SHAPES, EYE_MOODS, eyeRects, facePose } from '../ui/face-geometry'

describe('settled mobile poses', () => {
  it('draws two valid capsules for every activity and keeps the original eight outlines', () => {
    expect(AVATAR_SHAPES).toHaveLength(8)
    for (const mood of Object.keys(EYE_MOODS) as (keyof typeof EYE_MOODS)[]) {
      const rects = eyeRects(mood)
      expect(rects).toHaveLength(2)
      expect(rects.every(rect => rect.height > 0 && rect.width > 0)).toBe(true)
      expect(facePose(mood)).toMatch(/^translate\(/)
    }
    expect(eyeRects('sleeping')[0]!.height).toBeLessThan(eyeRects('idle')[0]!.height)
    expect(eyeRects('writing')[0]!.y).toBeGreaterThan(eyeRects('thinking')[0]!.y)
  })
})
