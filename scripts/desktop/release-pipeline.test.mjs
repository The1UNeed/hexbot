import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '../../.github/workflows/release.yml'), 'utf8')
const desktop = createRequire(join(here, '../../apps/desktop/package.json'))
const builder = createRequire(desktop.resolve('electron-builder'))
const { load } = createRequire(builder.resolve('app-builder-lib/out/packager.js'))('js-yaml')
const { jobs } = load(source)

test('a release proves the Windows sandbox boundary before it builds', () => {
  const job = name => source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'))?.[1] ?? ''
  assert.match(job('windows'), /^    uses: \.\/\.github\/workflows\/windows-security\.yml$/m)
  for (const name of ['build', 'installer']) assert.match(job(name), /^    needs: \[preflight, check, windows\]$/m, name)
})

test('both release editions build Windows x64 with bash and per-user NSIS names', async () => {
  assert.deepEqual(jobs.build.strategy.matrix.edition, ['full', 'client'])
  assert.equal(jobs.build.strategy.matrix.build.length * jobs.build.strategy.matrix.edition.length, 8)
  assert.deepEqual(jobs.build.strategy.matrix.include.find(row => row.build === 'win-x64'), {
    build: 'win-x64', runner: 'windows-latest', target: '--win --x64'
  })
  for (const job of [jobs.build, jobs.installer]) assert.equal(job.defaults.run.shell, 'bash')
  const upload = jobs.build.steps.find(step => step.with?.name === '${{ matrix.edition }}-${{ matrix.build }}')
  for (const extension of ['exe', 'blockmap']) assert(upload.with.path.includes(`apps/desktop/release/*.${extension}`))
  const base = load(await readFile('apps/desktop/electron-builder.base.yml', 'utf8'))
  const client = load(await readFile('apps/desktop/electron-builder.client.yml', 'utf8'))
  assert.deepEqual(base.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(base.nsis.perMachine, false)
  assert.equal(base.nsis.allowElevation, false)
  assert.equal(base.appId, 'app.hexbot.desktop')
  assert.equal(client.appId, 'app.hexbot.client')
  for (const [config, prefix] of [[base, 'Hexbot'], [client, 'HexbotClient']]) {
    assert.equal(config.win.executableName, prefix)
    assert.equal(config.artifactName.replace('${version}', '1.2.3').replace('${os}', 'win').replace('${arch}', 'x64').replace('${ext}', 'exe'), `${prefix}-1.2.3-win-x64.exe`)
  }
})

test('publish collects Windows EXEs, blockmaps and native ZIPs before mutable feeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-release-collection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, content = path) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  for (const [edition, prefix] of [['full', 'Hexbot'], ['client', 'HexbotClient']]) {
    for (const ext of ['exe', 'exe.blockmap']) await put(`artifacts/${edition}-win-x64/${prefix}-1.2.3-win-x64.${ext}`)
  }
  const native = 'daemon/native/1.2.3/windows-x86_64/hexbot-native-1.2.3-windows-x86_64.zip'
  await put(`artifacts/daemon-native-win-x64/1.2.3/windows-x86_64/${native.split('/').at(-1)}`)
  await put('artifacts/daemon-native-win-x64/1.2.3/windows-x86_64/manifest.json', '{}')
  await put('artifacts/daemon-src/hexbot-src-1.2.3.tar.gz')
  await put('artifacts/installer-win-x64/hexbot-install-1.2.3-windows-x86_64.exe')
  const step = name => jobs.publish.steps.find(step => step.name === name).run
  await run('bash', ['-c', step('Collect the packages')], { cwd: root, env: { ...process.env, VERSION: '1.2.3' } })
  await readFile(join(root, `dist/updates/${native}`))
  await readFile(join(root, 'release/daemon', native.split('/').at(-1)))
  for (const [edition, prefix] of [['full', 'Hexbot'], ['client', 'HexbotClient']]) {
    for (const ext of ['exe', 'exe.blockmap']) await readFile(join(root, `release/${edition}/${prefix}-1.2.3-win-x64.${ext}`))
  }
  await readFile(join(root, 'dist/updates/install/1.2.3/hexbot-install-1.2.3-windows-x86_64.exe'))
  const publish = step('Publish the update feed to updates.hexbot.app')
  assert(publish.indexOf('aws s3 sync') < publish.indexOf('--include'))
  for (const track of ['stable', 'nightly']) for (const format of ['json', 'txt']) assert(publish.includes(`--exclude 'install/${track}.${format}'`))
  const checks = step('Check the feed the apps will read')
  for (const edition of ['full', 'client']) assert(checks.includes(`${edition}/win/x64/$feed.yml`))
  const github = step('Create the GitHub release')
  assert(github.includes('release/daemon/*.{tar.gz,zip}'))
  assert(github.includes('release/full/*.{exe,') && github.includes('release/client/*.{exe,'))
})
