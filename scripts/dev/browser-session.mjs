// Sign a Playwright page in to a loopback daemon the way the app does: with the
// home's private token, never from a page. Usage: await signIn(page, base)
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function signIn(page, base, home = process.env.HEXBOT_HOME) {
  if (!home) throw new Error('Set HEXBOT_HOME to the daemon home (never ~/.hexbot for a dev daemon)')
  const token = (await readFile(join(home, 'local-device.token'), 'utf8')).trim()
  // The plain cookie carries the daemon port (serve-state.json), not the page's.
  const { port } = JSON.parse(await readFile(join(home, 'serve-state.json'), 'utf8'))
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The daemon token or port is missing')
  const secure = new URL(base).protocol === 'https:'
  await page.context().addCookies([{ name: secure ? '__Host-hermes_session_at' : `hermes_session_at_${port}`, value: token, url: base, httpOnly: true, secure, sameSite: 'Strict' }])
}
