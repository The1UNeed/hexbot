import { afterEach, describe, expect, it, vi } from 'vitest'

import { OAuthReturns } from './oauth-return'

const returns: OAuthReturns[] = []
const make = (onReturn?: () => void) => {
  const made = new OAuthReturns(onReturn)
  returns.push(made)
  return made
}

afterEach(() => {
  for (const made of returns.splice(0)) made.closeAll()
})

describe('Google sign-in returns to the app', () => {
  it('hands on the address the browser came back to, once', async () => {
    const onReturn = vi.fn()
    const relay = make(onReturn)
    const port = await relay.open()
    const waiting = relay.wait(port)

    expect((await fetch(`http://127.0.0.1:${port}/elsewhere?state=s`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/oauth/google`)).status).toBe(404)

    const page = await fetch(`http://127.0.0.1:${port}/oauth/google?state=s&code=c`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Back to Hexbot')
    expect(await waiting).toBe(`http://127.0.0.1:${port}/oauth/google?state=s&code=c`)

    // A second return changes nothing.
    await fetch(`http://127.0.0.1:${port}/oauth/google?state=other&code=d`)
    expect(await relay.wait(port)).toBe(`http://127.0.0.1:${port}/oauth/google?state=s&code=c`)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('stops listening when closed and tells whoever waits', async () => {
    const relay = make()
    const port = await relay.open()
    const waiting = relay.wait(port)

    relay.close(port)
    expect(await waiting).toBeNull()
    expect(await relay.wait(port)).toBeNull()
    await expect(fetch(`http://127.0.0.1:${port}/oauth/google?state=s`)).rejects.toThrow()
  })

  it('keeps sign-ins on their own ports', async () => {
    const relay = make()
    const first = await relay.open()
    const second = await relay.open()

    expect(first).not.toBe(second)
    relay.close(first)
    await fetch(`http://127.0.0.1:${second}/oauth/google?state=s&code=c`)
    expect(await relay.wait(second)).toContain(`127.0.0.1:${second}`)
  })
})
