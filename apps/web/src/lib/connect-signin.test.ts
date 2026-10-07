import { authorizeUrl, confirmationCode, startAppSignIn } from './connect-signin'

const sha256 = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

it('derives the same confirmation code as Connect', async () => {
  // The same vector is checked in apps/connect/src/__tests__/routes.test.ts.
  expect(confirmationCode(await sha256('hexbot-app-signin-test-vector-0123456789abcdef'))).toBe(
    'BHTN-JQRC'
  )
})

it('sends Connect the S256 challenge of a verifier it keeps', async () => {
  const signIn = await startAppSignIn(1000)
  expect(signIn.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(signIn.deadline).toBe(1000 + 10 * 60_000)
  expect(signIn.code).toBe(confirmationCode(await sha256(signIn.verifier)))
  const url = new URL(authorizeUrl(signIn, 'Alex Mac'))
  expect(url.origin + url.pathname).toBe('https://connect.hexbot.app/connect/authorize')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    challenge: signIn.challenge,
    device: 'Alex Mac',
    state: signIn.state
  })
  expect(url.href).not.toContain(signIn.verifier)
})
