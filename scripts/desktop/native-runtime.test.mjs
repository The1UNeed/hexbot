import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { createNativeArchive, launchers, nativeTarget, stageNativeRuntime } from './native-runtime.mjs'
const exec = promisify(execFile)
test('target supports both desktop architectures and Linux arm64', () => {
  for (const os of ['darwin', 'linux']) for (const arch of ['x64', 'arm64']) assert.equal(nativeTarget(os, arch), `${os}-${arch}`)
  assert.throws(() => nativeTarget('win32', 'x64'), /Unsupported/)
})
test('launchers preserve arguments and resolve paths containing spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot native '))
  try {
    await mkdir(join(root, 'pi'))
    const scripts = launchers()
    await writeFile(join(root, 'hexbot'), scripts.hexbot)
    await writeFile(join(root, 'hexbot-core'), '#!/bin/sh\nprintf "%s\\n" "$HEXBOT_PI_EXECUTABLE" "$@"\n')
    for (const file of ['hexbot', 'hexbot-core']) await chmod(join(root, file), 0o755)
    const { stdout } = await exec(join(root, 'hexbot'), ['serve', '--home', '/some user/home'])
    assert.deepEqual(stdout.trim().split('\n'), [join(root, 'pi/hexbot-pi'), 'serve', '--home', '/some user/home'])
    await mkdir(join(root, 'service'))
    await symlink(join(root, 'hexbot'), join(root, 'service', 'native-executable'))
    await symlink('native-executable', join(root, 'service', 'alias'))
    const service = await exec(join(root, 'service', 'alias'), ['serve', '--home', '/some user/home'])
    assert.equal(service.stdout, stdout)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('stage builds locked dependencies, validates Pi and emits artifact checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-stage-'))
  try {
    for (const path of ['apps/desktop', 'apps/web/dist', 'skills', 'backend/pi-runtime', 'backend/hexbot-core/target/release']) await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, 'apps/web/dist/index.html'), '<html>Hexbot</html>')
    await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }))
    await writeFile(join(root, 'backend/pi-runtime/package.json'), JSON.stringify({ dependencies: { '@earendil-works/pi-coding-agent': '0.87.1' } }))
    await writeFile(join(root, 'backend/pi-runtime/package-lock.json'), '{}')
    await writeFile(join(root, 'backend/hexbot-core/target/release/hexbot'), 'daemon')
    const node = join(root, 'node'); await writeFile(node, 'node')
    const calls = []
    const result = await stageNativeRuntime({ repository: root, nodeExecutable: node, run: async (command, args, options) => {
      calls.push({ command, args })
      if (command === 'npm') {
        const cli = join(options.cwd, 'node_modules/@earendil-works/pi-coding-agent/dist')
        await mkdir(cli, { recursive: true }); await writeFile(join(cli, 'cli.js'), '// pi')
      }
      return { stdout: '22.20.0' }
    } })
    const manifest = JSON.parse(await readFile(join(result.destination, 'manifest.json'), 'utf8'))
    assert.equal(manifest.piVersion, '0.87.1'); assert.equal(manifest.version, '1.2.3')
    assert.match(manifest.files['hexbot-core'], /^[a-f0-9]{64}$/)
    assert(calls.find(c => c.command === 'cargo').args.includes('--locked'))
    assert(calls.find(c => c.command === 'npm').args.includes('--ignore-scripts'))
    assert.deepEqual(calls.at(-1).args.slice(-1), ['--version'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('archive dereferences npm links and records the update format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-archive-'))
  try {
    const bundle = join(root, 'bundle'); await mkdir(bundle)
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.3', target: nativeTarget() }))
    await writeFile(join(bundle, 'hexbot'), 'executable')
    await symlink('hexbot', join(bundle, 'alias'))
    const archive = join(root, 'native.tar.gz')
    const manifest = await createNativeArchive(bundle, archive)
    assert.equal(manifest.format, 'tar.gz'); assert.equal(manifest.entrypoint, 'hexbot')
    const unpacked = join(root, 'unpacked'); await mkdir(unpacked)
    await exec('tar', ['-xzf', archive, '-C', unpacked])
    assert.notEqual((await stat(join(unpacked, 'hexbot'))).ino, (await stat(join(unpacked, 'alias'))).ino)
    await rm(join(unpacked, 'hexbot'))
    assert.equal(await readFile(join(unpacked, 'alias'), 'utf8'), 'executable')
  } finally { await rm(root, { recursive: true, force: true }) }
})
