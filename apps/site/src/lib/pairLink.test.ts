import { describe, expect, it } from 'vitest'
import { parsePairLocation } from './pairLink'

describe('parsePairLocation', () => {
  it('keeps the pairing code in the deep-link fragment and encodes values', () => {
    expect(parsePairLocation({ search: '?host=hexbox.local&port=8765', hash: '#code=AB 12' })).toEqual({
      code: 'AB 12',
      host: 'hexbox.local',
      port: '8765',
      deepLink: 'hexbot://pair?host=hexbox.local&port=8765#code=AB+12',
    })
  })

  it('rejects missing codes and invalid ports', () => {
    expect(parsePairLocation({ search: '?host=hexbox.local&port=0', hash: '#code=ABC' })).toBeNull()
    expect(parsePairLocation({ search: '?host=hexbox.local&port=8765', hash: '' })).toBeNull()
  })
})
