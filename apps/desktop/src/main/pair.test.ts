import { describe, expect, it } from 'vitest'
import { cookieValue } from './pair'
describe('pair cookie parsing', () => {
  it('reads the device token from separate set-cookie headers', () => {
    const headers = new Headers()
    headers.append('set-cookie', 'hermes_session_at=device-token; HttpOnly; Path=/')
    headers.append('set-cookie', 'other=value; Path=/')
    expect(cookieValue(headers, 'hermes_session_at')).toBe('device-token')
  })
})
