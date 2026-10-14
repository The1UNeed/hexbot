import { describe, expect, it } from 'vitest'

import { faceWash } from '../ui/faces'

describe('faceWash', () => {
  it('washes a bot bubble with its face colour', () => {
    const orange = { face: { color: 'orange', shape: 'pill' }, name: '中文' }

    expect(faceWash(orange, '#f0f0f2', 'light')).toBe('#f1dfd3')
    expect(faceWash(orange, '#2a2a2d', 'dark')).toBe('#533928')
  })

  it('keeps the plain fill for an uploaded picture', () => {
    expect(faceWash({ imageUri: 'file:///me.png', name: 'Photo' }, '#f0f0f2', 'light')).toBe('#f0f0f2')
  })
})
