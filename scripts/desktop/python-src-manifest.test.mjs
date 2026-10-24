import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { handoffFiles, stagePythonSource } from './python-src-manifest.mjs'

test('service source contains only the handoff package and a validated transition marker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-source-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repo')
  const destination = join(root, 'staged')
  for (const file of [...handoffFiles, 'tests/test_cli.py', 'hexbot/__pycache__/cli.pyc']) {
    const source = join(repository, 'backend/python-handoff', file)
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, file)
  }
  // The repository's own license files, byte for byte.
  const notices = {}
  for (const file of ['LICENSE', 'NOTICE']) {
    notices[file] = await readFile(new URL(`../../${file}`, import.meta.url))
    await writeFile(join(repository, file), notices[file])
  }
  for (const file of ['apps/web/dist/index.html', 'agent/legacy.py', '.env']) {
    const source = join(repository, file)
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, 'must not ship')
  }
  await mkdir(destination)
  await writeFile(join(destination, 'stale.py'), 'old archive')
  await stagePythonSource(repository, destination, { nativeTransitionVersion: '1.2.3-nightly.20261002.1' })
  assert.deepEqual((await readdir(destination)).sort(), ['HEXBOT_NATIVE_TRANSITION.json', 'LICENSE', 'NOTICE', 'hexbot', 'pyproject.toml', 'uv.lock'])
  for (const [file, bytes] of Object.entries(notices)) assert.deepEqual(await readFile(join(destination, file)), bytes)
  assert.deepEqual((await readdir(join(destination, 'hexbot'))).sort(), ['__init__.py', 'cli.py', 'native_transition.py', 'update_signature.py'])
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'HEXBOT_NATIVE_TRANSITION.json'))), { version: '1.2.3-nightly.20261002.1' })
  for (const file of handoffFiles) assert.equal(await readFile(join(destination, file), 'utf8'), file)
  for (const version of [undefined, '../invalid', '1.2.3\n', 123]) {
    await assert.rejects(stagePythonSource(repository, destination, { nativeTransitionVersion: version }), /Invalid native transition/)
  }
  await access(join(destination, 'pyproject.toml')) // invalid input never removes an existing archive
})

// Archive the real staged source the way release.yml does, then unpack it.
test('the published source archive carries the repository LICENSE and NOTICE', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-source-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  await stagePythonSource(repository, join(root, 'resources/hexbot-src'), { nativeTransitionVersion: '1.2.3' })
  const archive = join(root, 'hexbot-src-1.2.3.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'resources'), 'hexbot-src'])
  const unpacked = join(root, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  for (const file of ['LICENSE', 'NOTICE'])
    assert.deepEqual(await readFile(join(unpacked, 'hexbot-src', file)), await readFile(join(repository, file)))
})

// Import the release payload, isolated from the checkout and installed packages.
test('the actually staged handoff package imports with its signature verifier', async t => {
  const destination = await mkdtemp(join(tmpdir(), 'hexbot-handoff-import-'))
  t.after(() => rm(destination, { recursive: true, force: true }))
  await stagePythonSource(fileURLToPath(new URL('../../', import.meta.url)), destination, { nativeTransitionVersion: '1.2.3' })
  execFileSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import hexbot.cli; from hexbot import native_transition, update_signature; assert native_transition.update_signature is update_signature', destination], { cwd: destination })
})
