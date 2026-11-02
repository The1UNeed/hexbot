import { describe, expect, it } from 'vitest'

import {
  AVATAR_SHAPES,
  EYE_MOODS,
  eyePlacements,
  eyeTransform,
  facePose
} from '../ui/face-geometry'

describe('settled mobile poses', () => {
  it('draws two capsule eyes for every activity and keeps the eight outlines', () => {
    expect(AVATAR_SHAPES).toHaveLength(8)
    for (const mood of Object.keys(EYE_MOODS) as (keyof typeof EYE_MOODS)[]) {
      const eyes = eyePlacements(mood)
      expect(eyes).toHaveLength(2)
      expect(eyes.every(eye => eye.sx > 0 && eye.sy > 0)).toBe(true)
      expect(eyeTransform(eyes[0]!)).toMatch(/^translate\(.+\) scale\(.+\) rotate\(.+\)$/)
      expect(facePose(mood)).toMatch(/^translate\(/)
    }
    expect(eyePlacements('sleeping')[0]!.sy).toBeLessThan(eyePlacements('idle')[0]!.sy)
    expect(eyePlacements('writing')[0]!.y).toBeGreaterThan(eyePlacements('thinking')[0]!.y)
  })
})
