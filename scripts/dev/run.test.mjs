import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { derivePorts, printsSignInLink, validateDevArgs, ensurePiRuntime, prepareDevRuntime, pairingCode } from './run.mjs'
import { downloadTool, toolAsset } from '../../apps/desktop/src/main/backend/tools.ts'

test('dev ports derive from the checkout path and stay apart per worktree', () => {
  const a = derivePorts('/home/alex/hexbot')
  const b = derivePorts('/home/alex/hexbot-worktree')
  assert.deepEqual(a, derivePorts('/home/alex/hexbot'))
  assert.ok(a.daemon >= 9200 && a.daemon < 9900)
  assert.equal(a.web, a.daemon + 1000)
  assert.notEqual(a.daemon, b.daemon)
})

test('dev shares pinned search tool installs, refreshes receipts and puts them on Pi PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-dev-tools-'))
  const assets = ['rg', 'fd'].map(tool => toolAsset(tool, process.platform, process.arch))
  const downloads = []
  const deps = {
    download: async (url, destination) => {
      downloads.push(url)
      assert.equal(destination.endsWith('archive.tar.gz'), true)
      return assets.find(asset => asset.url === url).sha256
    },
    run: async (command, args) => {
      assert.equal(command, 'tar')
      assert.equal(args[0], '-xzf')
      const executable = join(args[3], args[4])
      await mkdir(join(executable, '..'), { recursive: true })
      await writeFile(executable, '#!/bin/sh\necho pinned search tool\n')
    }
  }
  try {
    const env = await prepareDevRuntime(root, '/dev/hexbot', '/dev/pi', deps)
    assert.equal(env.HEXBOT_HOME, root)
    assert.equal(env.HEXBOT_EXECUTABLE, '/dev/hexbot')
    assert.equal(env.HEXBOT_PI_EXECUTABLE, join(root, 'runtime/hexbot-pi'))
    assert.equal(env.PATH.split(delimiter)[0], join(root, 'bin'))
    assert.deepEqual(downloads, assets.map(asset => asset.url))
    await prepareDevRuntime(root, '/dev/hexbot', '/dev/pi', deps)
    assert.equal(downloads.length, 2)
    await writeFile(join(root, 'bin/rg'), 'tampered cached executable')
    await rm(join(root, 'bin/fd'))
    await prepareDevRuntime(root, '/dev/hexbot', '/dev/pi', deps)
    assert.deepEqual(downloads, [...assets, ...assets].map(asset => asset.url))
    for (const [index, tool] of ['rg', 'fd'].entries())
      assert.equal(JSON.parse(await readFile(join(root, 'bin', `${tool}-version`), 'utf8')).version, assets[index].version)
    const manager = new URL('../../backend/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js', import.meta.url)
    const pi = join(root, 'fake-pi.mjs')
    await writeFile(pi, `#!${process.execPath}
      globalThis.fetch = () => { throw new Error('Pi must not download search tools') };
      const { ensureTool } = await import(${JSON.stringify(manager.href)});
      console.log(await ensureTool('rg'), await ensureTool('fd'));
    `)
    await chmod(pi, 0o755)
    const agent = join(root, 'profile/pi')
    await mkdir(join(agent, 'bin'), { recursive: true })
    for (const tool of ['rg', 'fd']) await writeFile(join(agent, 'bin', tool), 'old unverified download')
    const managed = await prepareDevRuntime(root, '/dev/hexbot', pi, deps)
    const { stdout } = await promisify(execFile)(managed.HEXBOT_PI_EXECUTABLE, ['--mode', 'rpc'], {
      env: { ...process.env, ...managed, PI_CODING_AGENT_DIR: agent }
    })
    assert.equal(stdout.trim(), `${join(agent, 'bin/rg')} ${join(agent, 'bin/fd')}`)
    for (const tool of ['rg', 'fd'])
      assert.equal(await readFile(join(agent, 'bin', tool), 'utf8'), await readFile(join(root, 'bin', tool), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const badTool of ['rg', 'fd']) test(`dev rejects an unverified ${badTool} before extraction`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-dev-bad-tool-'))
  const extracted = []
  try {
    await assert.rejects(prepareDevRuntime(root, '/dev/hexbot', '/dev/pi', {
      download: async url => url === toolAsset(badTool, process.platform, process.arch).url
        ? 'wrong' : toolAsset('rg', process.platform, process.arch).sha256,
      run: async (_command, args) => {
        const executable = join(args[3], args[4])
        extracted.push(args[4].split('/').pop())
        await mkdir(join(executable, '..'), { recursive: true })
        await writeFile(executable, 'verified')
      }
    }), /checksum mismatch/)
    assert.equal(extracted.includes(badTool), false)
    await assert.rejects(readFile(join(root, 'bin', `${badTool}-version`)), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('shared tool downloader hashes the bytes written to disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-tool-download-'))
  try {
    const archive = join(root, 'download/archive.tar.gz')
    const digest = await downloadTool('data:application/octet-stream;base64,cGlubmVkIGFyY2hpdmU=', archive)
    assert.equal(await readFile(archive, 'utf8'), 'pinned archive')
    assert.equal(digest, createHash('sha256').update(await readFile(archive)).digest('hex'))
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('dev picks the pairing code out of hexbot pair output', () => {
  assert.equal(pairingCode('Pairing code: ABCD-EFGH\nExpires in: 10 minutes\nAddresses: 127.0.0.1:9321\n'), 'ABCD-EFGH')
  assert.equal(pairingCode('HERMES_BACKEND_READY port=9321'), undefined)
})

test('dev rejects removed backend selection', () => {
  validateDevArgs([])
  assert.throws(() => validateDevArgs(['--backend', 'python']), /removed/)
  assert.throws(() => validateDevArgs(['--backend=rust']), /removed/)
})

test('dev installs Pi on first run, lockfile changes and missing executables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-dev-pi-'))
  try {
    const lock = join(root, 'package-lock.json')
    const marker = join(root, 'node_modules/.hexbot-lock-sha256')
    const pi = join(root, 'node_modules/.bin/pi')
    let installs = 0
    const run = async (command, args, options) => {
      assert.equal(command, 'npm'); assert.ok(args.includes('ci')); assert.ok(args.includes('--ignore-scripts'))
      assert.equal(options.cwd, root)
      installs++
      await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
      await writeFile(pi, 'pi')
    }
    await writeFile(lock, 'first lock')
    await ensurePiRuntime(root, run)
    const first = await readFile(marker, 'utf8')
    await ensurePiRuntime(root, run)
    assert.equal(installs, 1)
    await writeFile(lock, 'changed lock')
    await assert.rejects(ensurePiRuntime(root, async () => { throw new Error('npm failed') }), /npm failed/)
    assert.equal(await readFile(marker, 'utf8'), first)
    await ensurePiRuntime(root, run)
    assert.equal(installs, 2)
    assert.notEqual(await readFile(marker, 'utf8'), first)
    await rm(pi)
    await ensurePiRuntime(root, run)
    assert.equal(installs, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dev prints a sign-in link only to an unsupervised terminal', () => {
  assert.equal(printsSignInLink(true, {}), true)
  assert.equal(printsSignInLink(true, {XPC_SERVICE_NAME:'0'}), true)
  assert.equal(printsSignInLink(false, {}), false)
  for (const env of [{HEXBOT_SUPERVISOR:'dev'}, {INVOCATION_ID:'systemd'}, {XPC_SERVICE_NAME:'app.hexbot.daemon'}]) assert.equal(printsSignInLink(true, env), false)
})
