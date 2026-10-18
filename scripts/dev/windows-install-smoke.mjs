// Real NSIS packages and native archives, installed under an isolated Windows home.
// The debug installer alone trusts the public fixture signing key used here.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { makeInstallManifest } from '../desktop/make-install-manifest.mjs'
import { signUpdates, testKey, testPublicKey } from '../desktop/update-signing.mjs'

assert.equal(process.platform, 'win32', 'This smoke runs in a Windows VM')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packages = resolve(process.argv[2] || 'windows-packages')
const updates = join(packages, 'updates')
const installer = join(root, 'backend/hexbot-installer/target/debug/hexbot-install.exe')
const run = promisify(execFile)
const temporary = await mkdtemp(join(tmpdir(), 'hexbot Windows install '))
const home = join(temporary, 'user')
const hexbotHome = join(home, '.hexbot')
const apps = join(home, 'AppData/Local/Programs')
const serviceRoot = join(temporary, 'services')
const artifacts = process.env.HEXBOT_SMOKE_ARTIFACTS || join(packages, 'evidence')
await Promise.all([mkdir(home, { recursive: true }), mkdir(hexbotHome, { recursive: true }), mkdir(apps, { recursive: true }), mkdir(artifacts, { recursive: true })])
const log = []
const requests = []
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const file = resolve(updates, `.${pathname}`)
    const child = relative(updates, file)
    if (child === '..' || child.startsWith(`..${sep}`) || resolve(file) === resolve(updates)) {
      response.writeHead(404).end()
      return
    }
    await access(file)
    requests.push(pathname)
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    createReadStream(file).on('error', () => response.destroy()).pipe(response)
  } catch { response.writeHead(404).end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
  HEXBOT_HOME: hexbotHome, HEXBOT_INSTALL_APPS_DIR: apps, HEXBOT_SERVICE_ROOT: serviceRoot, HEXBOT_SERVICE_NO_LOAD: '0', HEXBOT_UPDATE_URL: baseUrl }
delete env.HEXBOT_PI_EXECUTABLE
delete env.HEXBOT_PI_SCRIPT
let installed = false
const receipt = () => readFile(join(hexbotHome, 'install.json'), 'utf8').then(JSON.parse)
async function command(executable, args, timeout = 180_000) {
  try {
    const result = await run(executable, args, { env, timeout, maxBuffer: 32 * 1024 * 1024 })
    log.push({ executable, args, ...result })
    return result
  } catch (error) {
    log.push({ executable, args, error: error.message, stdout: error.stdout, stderr: error.stderr })
    throw error
  }
}
async function install(args) {
  if (!args.includes('--uninstall')) installed = true
  const result = await command(installer, [...args, '--yes', '--json'])
  assert(!result.stdout.split(/\r?\n/).some(line => line && JSON.parse(line).stage === 'error'), result.stdout)
  installed = !args.includes('--uninstall')
  return result
}
try {
  await access(installer)
  const version = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version
  const target = 'windows-x86_64'
  for (const [edition, flag] of [['full', []], ['client', ['--client']]]) {
    await command(process.execPath, [join(root, 'scripts/desktop/make-update-feed.mjs'), '--channel', 'stable', '--version', version, ...flag, join(packages, edition), updates])
  }
  const installDir = join(updates, 'install', version)
  await mkdir(installDir, { recursive: true })
  await copyFile(installer, join(installDir, `hexbot-install-${version}-${target}.exe`))
  await copyFile(join(packages, 'installers', `HexbotInstaller-${version}-${target}.exe`), join(installDir, `HexbotInstaller-${version}-${target}.exe`))
  await makeInstallManifest(updates, { channel: 'stable', version, baseUrl, allowMissing: true })
  signUpdates(updates, { channel: 'stable', version, key: testKey(), expected: testPublicKey() })
  const sentinel = join(hexbotHome, 'keep-user-data.txt')
  await writeFile(sentinel, 'User data survives repair, change and uninstall.')

  await install(['--full', '--stable'])
  assert.equal((await receipt()).option, 'full')
  const full = join(apps, 'app.hexbot.desktop')
  await access(join(full, 'Hexbot.exe'))
  await access(join(full, 'Uninstall Hexbot.exe'))
  // Repair restores a missing installed asset through the real NSIS package.
  const license = join(full, 'LICENSE.electron.txt')
  await rm(license)
  await install(['--repair'])
  await access(license)
  assert.equal(await readFile(sentinel, 'utf8'), 'User data survives repair, change and uninstall.')

  await install(['--client', '--stable'])
  assert.equal((await receipt()).option, 'client')
  await access(join(apps, 'app.hexbot.client/Hexbot.exe'))
  await assert.rejects(access(join(full, 'Hexbot.exe')))
  await install(['--uninstall'])
  await assert.rejects(access(join(apps, 'app.hexbot.client/Hexbot.exe')))
  assert.equal(await readFile(sentinel, 'utf8'), 'User data survives repair, change and uninstall.')

  await install(['--headless', '--stable'])
  const dispatcher = join(hexbotHome, 'runtime/native-executable.exe')
  await access(dispatcher)
  const selected = JSON.parse(await readFile(join(hexbotHome, 'runtime/native-current.json'), 'utf8'))
  assert(selected, 'Headless setup publishes the Windows runtime selection')
  let status
  const readyBy = Date.now() + 30_000
  do {
    status = JSON.parse((await command(dispatcher, ['status', '--json'])).stdout)
    if (status.running || Date.now() >= readyBy) break
    await new Promise(resolve => setTimeout(resolve, 250))
  } while (true)
  assert.equal(status.running, true, JSON.stringify(status))
  await command(dispatcher, ['pair'])
  await install(['--repair'])
  // Update the running service to another genuinely built runtime version.
  const next = JSON.parse(await readFile(join(packages, 'versions.json'), 'utf8')).next
  for (const [edition, flag] of [['full', []], ['client', ['--client']]])
    await command(process.execPath, [join(root, 'scripts/desktop/make-update-feed.mjs'), '--channel', 'stable', '--version', next, ...flag, join(packages, 'next', edition), updates])
  await makeInstallManifest(updates, { channel: 'stable', version: next, baseUrl, allowMissing: true })
  signUpdates(updates, { channel: 'stable', version: next, key: testKey(), expected: testPublicKey() })
  await install(['--headless', '--stable'])
  assert.equal((await receipt()).version, next)
  assert.match((await command(dispatcher, ['--version'])).stdout, new RegExp(next.replaceAll('.', '\\.')))
  await install(['--uninstall'])
  await assert.rejects(access(dispatcher))
  assert.equal(await readFile(sentinel, 'utf8'), 'User data survives repair, change and uninstall.')
  // Removal of data is a separate explicit action.
  await install(['--uninstall', '--remove-data'])
  await assert.rejects(access(sentinel))
  assert(requests.some(path => path.endsWith('.exe')), 'NSIS installer payloads were downloaded')
  assert(requests.some(path => path.endsWith('.tar.gz')), 'Native daemon archive was downloaded')
  console.log(JSON.stringify({ passed: true, scenarios: ['NSIS Full install', 'repair', 'change Full to Client', 'app uninstall', 'Headless activation', 'Task Scheduler service', 'pairing', 'Headless repair', 'running service update', 'service uninstall', 'preserve and remove data'], packages, artifacts }, null, 2))
} finally {
  if (installed) await install(['--uninstall']).catch(error => console.error(`Cleanup: ${error.message}`))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await writeFile(join(artifacts, 'install-lifecycle.json'), JSON.stringify({ log, requests, temporary }, null, 2))
  // Preserve a failed install for inspection; successful uninstalls have no running processes.
  if (!installed) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
