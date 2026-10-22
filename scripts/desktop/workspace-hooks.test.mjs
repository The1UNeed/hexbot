import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { productName } from './release-version.mjs'
import { pnpmCommand, windowsPnpmCommand } from './pnpm-command.mjs'

const exec = promisify(execFile)
const desktop = resolve('apps/desktop')
const desktopRequire = createRequire(join(desktop, 'package.json'))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
const packager = builderRequire.resolve('app-builder-lib/out/packager.js')
const packagerRequire = createRequire(packager)
const collector = packagerRequire.resolve('./node-module-collector')
const hooks = builderRequire.resolve('app-builder-lib/out/util/resolve.js')

for (const corepack of [false, ...(process.env.HEXBOT_TEST_COREPACK_ROOT ? [true] : [])]) for (const client of [false, true]) {
  test(`${client ? 'Client' : 'Full'} ${corepack ? 'Corepack' : 'native'} real pnpm/builder CLI loads and executes project-contained hooks`, async t => {
    const root = await mkdtemp(join(desktop, '.hook-probe-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const config = join(root, 'builder.cjs')
    const edition = client ? 'electron-builder.client.yml' : 'electron-builder.yml'
    // An intentional beforePack error stops this startup test before downloads
    // or packaging. The required native CI steps still build the real NSIS.
    await writeFile(config, `
      const assert = require('node:assert/strict')
      const { createRequire } = require('node:module')
      const { mkdir, readFile, realpath } = require('node:fs/promises')
      const { isAbsolute, relative, resolve } = require('node:path')
      const fromPackager = createRequire(${JSON.stringify(packager)})
      const { resolveFunction } = require(${JSON.stringify(hooks)})
      module.exports = {
        extends: ${JSON.stringify(join(desktop, edition))},
        directories: { output: ${JSON.stringify(join(root, 'output'))} },
        beforePack: async context => {
          const info = context.packager.info
          const collector = fromPackager.resolve('./node-module-collector')
          assert.equal(collector, ${JSON.stringify(collector)})
          const probe = await fromPackager('builder-util').spawn('pnpm', ['--workspace-root', 'exec', 'pwd'], { cwd: process.cwd(), stdio:['ignore','pipe','pipe'] })
            .then(stdout => ({ stdout })).catch(error => ({ exitCode:error.exitCode, code:error.code }))
          console.log('HEXBOT_BUILDER_CONTEXT ' + JSON.stringify({
            cwd: process.cwd(), argv: process.argv, execPath: process.execPath,
            packager: ${JSON.stringify(packager)}, collector, workspaceRoot: await info.getWorkspaceRoot(), pnpmWorkspaceProbe: probe,
            npm_config_user_agent: process.env.npm_config_user_agent, npm_execpath: process.env.npm_execpath,
            npm_package_json: process.env.npm_package_json, INIT_CWD: process.env.INIT_CWD
          }))
          for (const [name, path] of [['afterPack',info.config.afterPack], ['sign',info.config.mac.sign]]) {
            // A missing package-manager root narrows containment to projectDir.
            // Both entrypoints must remain inside it with real paths too.
            const rel = relative(await realpath(info.projectDir), await realpath(resolve(path)))
            assert(!rel.startsWith('..') && !isAbsolute(rel), 'Hook leaves the desktop project: ' + path)
            const hook = await resolveFunction(info.appInfo.type, path, 'default', info.projectDir)
            assert.equal(typeof hook, 'function')
            if (name === 'afterPack') {
              await mkdir(context.appOutDir, { recursive:true })
              await hook(context)
              const marker = JSON.parse(await readFile(resolve(context.appOutDir,'.hexbot-app.json'),'utf8'))
              assert.equal(marker.appId, ${JSON.stringify(client ? 'app.hexbot.client' : 'app.hexbot.desktop')})
            }
          }
          await assert.rejects(resolveFunction(info.appInfo.type, '../installer/package.json', 'default', info.projectDir), /outside the workspace root/)
          throw new Error('HEXBOT_PROJECT_HOOKS_EXECUTED')
        }
      }
    `)
    const { command, prefix } = corepack ? windowsPnpmCommand([join(process.env.HEXBOT_TEST_COREPACK_ROOT, 'pnpm.cmd')]) : await pnpmCommand()
    // Same pnpm executable/JS entrypoint, exec argv, cwd and inherited process
    // environment as dist.mjs. No artificial PATH or forced workspace root.
    const version = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version
    const name = productName('stable', version, client)
    const args = [...prefix, 'exec', 'electron-builder', '--win', '--x64', `-c.productName=${name}`, `-c.extraMetadata.productName=${name}`, '--config', config, '--publish', 'never']
    const env = { ...process.env, HEXBOT_EDITION: client ? 'client' : 'full', HEXBOT_CHANNEL: 'stable' }
    if (!client && process.platform === 'win32') Object.assign(env, { HEXBOT_BUILD_PLATFORM: 'win32', HEXBOT_BUILD_ARCH: 'x64' })
    if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    const result = await exec(command, args, { cwd: desktop, env, timeout: 60_000 }).catch(error => error)
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.match(output, /HEXBOT_PROJECT_HOOKS_EXECUTED/, output)
    assert.doesNotMatch(output, /Hook leaves the desktop project|Hook module path/, output)
    const context = JSON.parse(output.match(/HEXBOT_BUILDER_CONTEXT (.+)/)[1])
    assert.equal(context.cwd, desktop)
    assert.equal(context.collector, collector)
    t.diagnostic(JSON.stringify(context))
  })
}
