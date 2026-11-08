import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildPdfGuest } from './build-pdf-guest.mjs'
import { pdfFixture } from './fixtures/pdf-runtime.mjs'

test('guest producer uses one bounded owned native container, with no host mounts or privileges', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pdf-builder-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guest = join(root, 'backend/pdf-runtime/guest')
  await mkdir(guest, { recursive: true })
  await mkdir(join(root, 'backend/pdf-runtime/macos'))
  await writeFile(join(root, 'backend/pdf-runtime/macos/Package.swift'), 'reviewed helper source')
  for (const name of ['LICENSE', 'NOTICE']) await writeFile(join(root, name), `actual ${name}`)
  await writeFile(join(guest, 'assets.lock.json'), JSON.stringify({ status: 'release-ready', architectures: { aarch64: { packages: [{}] } } }))
  const calls = []
  const run = async (command, args) => {
    assert.equal(command, 'docker')
    calls.push(args)
    if (args[0] === 'cp' && args[2].endsWith(':/work')) {
      assert.equal(await readFile(join(args[1], 'backend/pdf-runtime/macos/Package.swift'), 'utf8'), 'reviewed helper source')
      for (const name of ['LICENSE', 'NOTICE']) assert.equal(await readFile(join(args[1], name), 'utf8'), `actual ${name}`)
    }
    if (args[0] === 'cp' && args[1].endsWith(':/pdf-assets')) await pdfFixture(args[2], { helper: false })
    return { stdout: args[0] === 'inspect' ? '0\n' : '' }
  }
  const result = await buildPdfGuest({ repository: root, architecture: 'aarch64', output: join(root, 'output'),
    platform: 'linux', hostArch: 'arm64', run })
  assert.equal(result.status, 'prototype-not-release-ready')
  const create = calls.find(args => args[0] === 'create')
  const name = create[create.indexOf('--name') + 1]
  assert.match(name, /^hexbot-pdf-build-[a-f0-9-]+$/)
  for (const [flag, value] of [['--memory', '6g'], ['--memory-swap', '6g'], ['--cpus', '2'], ['--pids-limit', '256'], ['--ulimit', 'core=0'], ['--security-opt', 'no-new-privileges']])
    assert.equal(create[create.indexOf(flag) + 1], value)
  for (const flag of ['--privileged', '--volume', '-v', '--mount', '--cap-add']) assert(!create.includes(flag))
  assert(create.some(value => /^rust@sha256:[a-f0-9]{64}$/.test(value)))
  const script = create.at(-1)
  assert.match(script, /--kernel-config-out \/pdf-kernel.config/)
  assert.match(script, /collect-sources.py.*--require-rust-signatures/)
  assert.match(script, /--url-base "https:\/\/updates.hexbot.app\/daemon\/native\/\$HEXBOT_PDF_VERSION\/macos-\$HEXBOT_PDF_ARCH"/)
  assert.match(script, /finalize-assets.py.*--notices \/pdf-sources\/THIRD_PARTY_NOTICES.*--out \/pdf-assets/)
  assert.deepEqual(calls.at(-1), ['rm', '--force', name])
  await assert.rejects(buildPdfGuest({ repository: root, architecture: 'x86_64', output: join(root, 'intel'),
    platform: 'linux', hostArch: 'x64', run }), /no complete reviewed/)
})

test('a failed or incomplete release guest build cleans only its own container', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pdf-builder-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guest = join(root, 'backend/pdf-runtime/guest')
  await mkdir(guest, { recursive: true })
  for (const name of ['LICENSE', 'NOTICE']) await writeFile(join(root, name), name)
  await writeFile(join(guest, 'assets.lock.json'), JSON.stringify({ status: 'release-ready', architectures: { aarch64: { packages: [{}] } } }))
  for (const exitCode of ['1', '0']) {
    const calls = []
    const run = async (_command, args) => {
      calls.push(args)
      if (args[0] === 'cp' && args[1].endsWith(':/pdf-assets')) await pdfFixture(args[2], { helper: false })
      return { stdout: args[0] === 'inspect' ? exitCode : '' }
    }
    await assert.rejects(buildPdfGuest({ repository: root, architecture: 'aarch64', output: join(root, exitCode),
      platform: 'linux', hostArch: 'arm64', channel: 'stable', version: '1.2.3', run }), exitCode === '0' ? /prototype/ : /builder failed/)
    const create = calls.find(args => args[0] === 'create')
    assert.deepEqual(calls.at(-1), ['rm', '--force', create[create.indexOf('--name') + 1]])
  }
})

test('native x86 Dev producer selects the authenticated AMD64 image and keeps prototype release gates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pdf-amd64-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guest = join(root, 'backend/pdf-runtime/guest')
  await mkdir(guest, { recursive: true })
  for (const name of ['LICENSE', 'NOTICE']) await writeFile(join(root, name), name)
  await writeFile(join(guest, 'assets.lock.json'), JSON.stringify({ status: 'prototype-not-release-ready',
    architectures: { x86_64: { packages: [{}] } } }))
  const calls = []
  const run = async (_command, args) => {
    calls.push(args)
    if (args[0] === 'cp' && args[1].endsWith(':/pdf-assets')) await pdfFixture(args[2], { arch: 'x64', helper: false })
    return { stdout: args[0] === 'inspect' ? '0\n' : '' }
  }
  const options = { repository: root, architecture: 'x86_64', output: join(root, 'output'), platform: 'linux', hostArch: 'x64', run }
  const result = await buildPdfGuest(options)
  assert.equal(result.status, 'prototype-not-release-ready')
  const create = calls.find(args => args[0] === 'create')
  assert.deepEqual(create.filter(value => value.startsWith('rust@')), [
    'rust@sha256:4277ce860337f6cfa1b679891bbf689a447f4b3f4f55701742614ad31321cee7'
  ])
  assert(create.includes('HEXBOT_PDF_ARCH=x86_64'))
  const count = calls.length
  for (const channel of ['stable', 'nightly'])
    await assert.rejects(buildPdfGuest({ ...options, channel, version: '1.2.3' }), /prototype/)
  await assert.rejects(buildPdfGuest({ ...options, hostArch: 'arm64' }), /matching native Linux builder/)
  assert.equal(calls.length, count)
})

test('release producer rejects missing versions before reading inputs or creating a container', async () => {
  let calls = 0
  for (const channel of ['stable', 'nightly']) for (const version of [undefined, '', '1.2.3;invalid'])
    await assert.rejects(buildPdfGuest({ repository: '/missing-inputs', architecture: 'aarch64', output: '/unused-output',
      platform: 'linux', hostArch: 'arm64', channel, version, run: async () => { calls++ } }), /release version is required/)
  assert.equal(calls, 0)
})

test('producer finalizer and verifier arguments satisfy the real Python CLI contract', async t => {
  const python = ['python3', 'python3.14', 'python3.13', 'python3.12'].map(command =>
    spawnSync(command, ['-c', 'import sys, tomllib; assert sys.version_info >= (3,12); print(sys.executable)'], { encoding: 'utf8' })
  ).find(result => result.status === 0)?.stdout.trim()
  assert(python, 'PDF source CLI contract checks require Python 3.12 or newer')
  const realGuest = fileURLToPath(new URL('../../backend/pdf-runtime/guest', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pdf-cli-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guest = join(root, 'backend/pdf-runtime/guest')
  await mkdir(guest, { recursive: true })
  for (const file of ['LICENSE', 'NOTICE']) await writeFile(join(root, file), file)
  await writeFile(join(guest, 'assets.lock.json'), JSON.stringify({ status: 'release-ready', architectures: {
    aarch64: { packages: [{ name: 'fixture', version: '1', repository: 'main', origin: ['fixture'], sourceCommit: ['0'.repeat(40)] }] }
  } }))
  const version = '1.2.3-nightly.20261106.7'
  let sourceArchivePath, finalizerParsed = false, verifierParsed = false
  const run = async (command, args) => {
    if (command === 'python3') {
      assert.equal(args[args.indexOf('--version') + 1], version)
      const result = spawnSync(python, [join(realGuest, 'verify-sources.py'), ...args.slice(1)], { encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /supplied lock differs from the accepted build\/source lock/)
      verifierParsed = true
      throw new Error('Actual verifier refused the deliberately incomplete fixture materials')
    }
    assert.equal(command, 'docker')
    if (args[0] === 'create') {
      assert(args.includes(`HEXBOT_PDF_VERSION=${version}`))
      const line = args.at(-1).split('\n').find(line => line.includes('"$guest/finalize-assets.py"'))
      assert(line, 'The producer must invoke the actual finalizer')
      const script = line.replace('python3 ', '"$PDF_TEST_PYTHON" ').replaceAll('/pdf-', '"$PDF_TEST_ROOT"/pdf-')
      const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env,
        guest: realGuest, archive: join(root, 'absent.tar.gz'), HEXBOT_PDF_ARCH: 'aarch64', HEXBOT_PDF_VERSION: version,
        PDF_TEST_PYTHON: python, PDF_TEST_ROOT: root } })
      // Missing fixture data is intentional. Exit 2 would mean argument drift.
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /PDF runtime finalization failed:.*No such file/)
      finalizerParsed = true
    }
    if (args[0] === 'cp' && args[1].endsWith(':/pdf-assets')) {
      const fixture = await pdfFixture(args[2], { helper: false, release: true })
      fixture.archive.file = `hexbot-pdf-sources-${version}-aarch64-${fixture.archive.sha256}.tar.gz`
      fixture.archive.url = `https://updates.hexbot.app/daemon/native/${version}/macos-aarch64/${fixture.archive.file}`
      sourceArchivePath = join(root, fixture.archive.file)
      await writeFile(sourceArchivePath, fixture.archiveBytes)
      for (const [name, value] of [['SOURCES.json', fixture.sources], ['PROVENANCE.json', fixture.provenance]])
        await writeFile(join(args[2], name), JSON.stringify(value))
    }
    if (args[0] === 'cp' && args[1].includes(':/pdf-sources/')) await writeFile(args[2], await readFile(sourceArchivePath))
    return { stdout: args[0] === 'inspect' ? '0\n' : '' }
  }
  await assert.rejects(buildPdfGuest({ repository: root, architecture: 'aarch64', output: join(root, 'output'),
    platform: 'linux', hostArch: 'arm64', channel: 'nightly', version, run }), /Actual verifier refused/)
  assert(finalizerParsed)
  assert(verifierParsed)
})
