// Run the actual NSIS-installed app before the engine repairs/uninstalls it.
import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { _electron: electron } = require('@playwright/test')
const [executable, edition, root] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert(isAbsolute(executable) && isAbsolute(root))
assert(['client', 'full'].includes(edition))
const home = join(root, 'state')
for (const directory of [home, join(root, 'roaming'), join(root, 'local')]) await mkdir(directory, { recursive: true })
async function state() {
  const path = join(home, 'serve-state.json')
  return new Promise((done, reject) => {
    const watcher = watch(dirname(path), check)
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Installed Full app did not start its daemon')) }, 300_000)
    async function check() {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'))
        if (value.port) { clearTimeout(timer); watcher.close(); done(value) }
      } catch {}
    }
    void check()
  })
}
let app
try {
  app = await electron.launch({ executablePath: executable, timeout: 300_000, env: {
    ...process.env, HOME: root, USERPROFILE: root, HEXBOT_HOME: home, HERMES_HOME: home,
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), HEXBOT_SERVICE_ROOT: root, HEXBOT_CLI_NO_PATH: '1',
  } })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  const window = await app.firstWindow({ timeout: 300_000 })
  await window.waitForLoadState('domcontentloaded')
  assert(await window.locator('body').isVisible())
  if (edition === 'full') {
    const running = await state()
    const selected = JSON.parse(await readFile(join(home, 'runtime/native-current.json'), 'utf8')).executable
    const path = relative(await realpath(join(home, 'runtime/native')), await realpath(selected))
    assert(path && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    assert(selected.endsWith('hexbot.exe'))
    const response = await fetch(`http://127.0.0.1:${running.port}/`, { signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200)
  } else {
    await assert.rejects(readFile(join(home, 'runtime/native-current.json')), { code: 'ENOENT' })
  }
  console.log(`Installed ${edition} app opened its real packaged window${edition === 'full' ? ' and activated its verified native daemon' : ''}`)
} finally {
  if (app) await app.close()
}
