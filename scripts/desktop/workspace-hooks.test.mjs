import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const desktop = resolve('apps/desktop')
const desktopRequire = createRequire(join(desktop, 'package.json'))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
const collector = builderRequire.resolve('app-builder-lib/out/node-module-collector/index.js')
const config = builderRequire.resolve('app-builder-lib/out/util/config/config.js')
const hooks = builderRequire.resolve('app-builder-lib/out/util/resolve.js')

test('Full and Client resolve shared hooks inside the real workspace when pnpm pwd is unavailable', async t => {
  // Windows cannot run the Unix `pwd` child used by the pinned builder. Force
  // that command to fail on every host, exercising its real package fallback.
  const emptyPath = await mkdtemp(join(tmpdir(), 'hexbot empty tools '))
  t.after(() => rm(emptyPath, { recursive: true, force: true }))
  const { readFile } = await import('node:fs/promises')
  const packages = (await readFile('pnpm-workspace.yaml', 'utf8')).match(/^packages:\n((?:  .+\n)+)/)[1].trim().split('\n').map(line => line.trim().slice(2))
  assert.deepEqual(JSON.parse(await readFile('package.json', 'utf8')).workspaces, packages)
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { realpath } from 'node:fs/promises'
    const require = createRequire(import.meta.url)
    const { determinePackageManagerEnv } = require(${JSON.stringify(collector)})
    const { getConfig } = require(${JSON.stringify(config)})
    const { resolveFunction } = require(${JSON.stringify(hooks)})
    const pm = await determinePackageManagerEnv({ projectDir: process.cwd(), appDir: process.cwd() }).value
    const root = await pm.workspaceRoot || process.cwd()
    for (const edition of ['electron-builder.yml', 'electron-builder.client.yml']) {
      const config = await getConfig(process.cwd(), edition)
      const hook = await resolveFunction('afterPack', config.afterPack, 'default', root)
      assert.equal(typeof hook, 'function')
      // The sign hook uses the same containment check on macOS.
      assert.equal(typeof await resolveFunction('sign', config.mac.sign, 'default', root), 'function')
    }
    assert.equal(await realpath(root), await realpath(${JSON.stringify(resolve('.'))}))
    // The security check still refuses the same hook with a narrower root.
    await assert.rejects(resolveFunction('afterPack', '../../scripts/desktop/after-pack.cjs', 'default', process.cwd()), /outside the workspace root/)
    console.log('Both editions retain hook containment')
  `], { cwd: desktop, env: { ...process.env, PATH: emptyPath, npm_config_user_agent: 'pnpm/10.29.3', npm_execpath: join(emptyPath, 'pnpm.cjs') } })
  assert.match(stdout, /Both editions retain hook containment/)
})
