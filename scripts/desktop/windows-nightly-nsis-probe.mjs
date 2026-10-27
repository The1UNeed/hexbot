// Build the real second NSIS identity on disposable CI source. Central version
// generation is restored byte-for-byte before tests; nothing is published.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setVersion } from './set-version.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.HEXBOT_WINDOWS_NSIS_PROBE, '1')
const [edition, ...extra] = process.argv.slice(2)
assert(['client', 'full'].includes(edition) && !extra.length)
const packageFile = resolve('apps/desktop/package.json')
const original = await readFile(packageFile)
const base = JSON.parse(original).version.split('-')[0]
const nightly = `${base}-nightly.20990101.1`
const run = (args, env = process.env) => new Promise((done, reject) => {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code, signal) => code === 0 && signal === null ? done() : reject(new Error(`NSIS probe child exited ${code}/${signal}`)))
})
try {
  await setVersion(nightly)
  await run(['scripts/desktop/dist.mjs', '--win', '--x64', ...(edition === 'client' ? ['--client'] : []), '--channel', 'nightly', '-c.directories.output=release/nightly-probe'])
  if (edition === 'full') await run(['scripts/desktop/dist.mjs', '--win', '--x64', '--client', '--channel', 'nightly', '-c.directories.output=release/nightly-probe'])
} finally {
  await writeFile(packageFile, original)
  assert(original.equals(await readFile(packageFile)), 'Disposable source version was not restored')
}
const nsis = resolve(`apps/desktop/release/nightly-probe/${edition === 'client' ? 'HexbotClient' : 'Hexbot'}-${nightly}-win-x64.exe`)
await run(['scripts/dev/run-one-rust-test.mjs', 'backend/hexbot-installer/Cargo.toml', 'windows_contract', 'real_nsis_install_repair_and_uninstall'], {
  ...process.env, HEXBOT_WINDOWS_NSIS: nsis, HEXBOT_WINDOWS_EDITION: edition,
  ...(edition === 'full' ? { HEXBOT_WINDOWS_CLIENT_NSIS: resolve(`apps/desktop/release/nightly-probe/HexbotClient-${nightly}-win-x64.exe`) } : {}),
  HEXBOT_WINDOWS_TRACK: 'nightly', HEXBOT_WINDOWS_PACKAGE_VERSION: nightly,
  HEXBOT_WINDOWS_GUI_PROBE: resolve('scripts/desktop/windows-installed-app-smoke.mjs'),
})
