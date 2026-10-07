// Drive the Hexbot dev build on an iOS Simulator for local checks.
//   node apps/mobile/scripts/sim.mjs open  <udid> [metroPort]   install-free launch through the dev client
//   node apps/mobile/scripts/sim.mjs pair  <udid>               pair with the running demo daemon (demo-daemon.mjs)
//   node apps/mobile/scripts/sim.mjs shot  <udid> <file.png>    screenshot
//   node apps/mobile/scripts/sim.mjs url   <udid> <url>         open a deep link, e.g. hexbot://chat/<id>
// Taps use `axe` (brew install cameroncooke/axe/axe).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const [command, udid, arg] = process.argv.slice(2)
const run = (file, args, opts = {}) => execFileSync(file, args, { encoding: 'utf8', ...opts })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tap = label => { try { run('axe', ['tap', '--label', label, '--udid', udid]); return true } catch { return false } }

if (!udid) throw new Error('Pass a simulator UDID (xcrun simctl list devices).')

if (command === 'open') {
  const port = arg ?? '8091'
  try { run('xcrun', ['simctl', 'terminate', udid, 'app.hexbot.mobile.dev']) } catch {}
  run('xcrun', ['simctl', 'openurl', udid, `exp+hexbot://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${port}`)}`])
  await sleep(2500)
  tap('Open')
  await sleep(8000)
  tap('Continue')
} else if (command === 'pair') {
  const demo = JSON.parse(readFileSync(path.join(tmpdir(), 'hexbot-mobile-demo.json'), 'utf8'))
  const out = run(path.join(root, 'backend/hexbot-core/target/debug/hexbot'), ['pair'], { env: { ...process.env, HEXBOT_HOME: demo.home } })
  const code = /^Pairing code: (\S+)/m.exec(out)?.[1]
  run('xcrun', ['simctl', 'openurl', udid, `hexbot://pair?host=127.0.0.1&port=${demo.port}#code=${code}`])
  await sleep(2500)
  tap('Open')
  await sleep(1500)
  tap('Connect')
  console.log(`Paired with code ${code}`)
} else if (command === 'shot') {
  run('xcrun', ['simctl', 'io', udid, 'screenshot', arg], { stdio: 'ignore' })
  console.log(arg)
} else if (command === 'url') {
  run('xcrun', ['simctl', 'openurl', udid, arg])
  await sleep(2000)
  tap('Open')
} else {
  throw new Error(`Unknown command ${command}`)
}
