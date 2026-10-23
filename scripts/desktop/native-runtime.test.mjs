import { strict as assert } from 'node:assert'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { archiveProgram, extractWindowsArchive, installTool, toolAsset } from '../../apps/desktop/src/main/backend/tools.ts'
import { inventoryNativeRuntime, copyNativeRuntime, publishWindowsRuntime, publishNativeRuntime, createNativeArchive, extractStandaloneNode, launchers, nativeTarget, stageNativeRuntime, rustTarget, pruneRuntimeDependencies, directoryBytes, standaloneNode, NODE_VERSION, NODE_SHA256 } from './native-runtime.mjs'
const exec = promisify(execFile)
async function captureArchiveCommand(program, argv, cwd) {
  const child = spawn(program, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const report = { program, argv, cwd, pid: child.pid }
  for (const name of ['stdout', 'stderr']) {
    const chunks = []; let retained = 0
    report[name] = { bytes: 0, text: '', truncated: false }
    child[name].on('data', bytes => {
      report[name].bytes += bytes.length
      const prefix = bytes.subarray(0, Math.max(0, 8192 - retained))
      if (prefix.length) chunks.push(prefix)
      retained += prefix.length
    })
    child[name].on('end', () => {
      report[name].text = Buffer.concat(chunks).toString('utf8')
      report[name].truncated = report[name].bytes > retained
    })
  }
  try { report.status = await closed } catch (error) {
    report.spawnError = { code: error.code, message: error.message.slice(0, 1024) }
    report.status = [null, null]
  }
  return report
}
test('archive diagnostics drain both streams while retaining bounded output and the original exit status', async () => {
  const report = await captureArchiveCommand(process.execPath, ['-e',
    "process.stdout.write('o'.repeat(131072));process.stderr.write('e'.repeat(131072));process.exitCode=7"], tmpdir())
  assert.deepEqual(report.status, [7, null])
  for (const name of ['stdout', 'stderr']) {
    assert.equal(report[name].bytes, 131072)
    assert.equal(report[name].text.length, 8192)
    assert.equal(report[name].truncated, true)
  }
})
test('Windows Node archive extraction keeps Unicode paths out of tar operands', { skip: process.platform === 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot extraction π 中文 '))
  try {
    const member = `node-v${NODE_VERSION}-win-x64/node.exe`
    const bundle = join(root, 'bundle'); await mkdir(join(bundle, member, '..'), { recursive: true })
    await writeFile(join(bundle, member), 'member bytes')
    // The native runner uses this same system tar for the actual pinned Node
    // publication test; the portable fixture exercises the full extraction.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/tar.exe') : 'tar'
    await exec(tar, ['--format', 'zip', '-cf', '../node.zip', member], { cwd: bundle })
    const calls = []
    await extractStandaloneNode(root, 'node.zip', member, true, async (program, args, options) => {
      calls.push({ program, args, cwd: options.cwd })
      assert.ok(args.every(arg => /^[\x20-\x7e]+$/.test(arg)), JSON.stringify(args))
      return exec(program, args, options)
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cwd, root)
    assert.equal(await readFile(join(root, member), 'utf8'), 'member bytes')
    await assert.rejects(extractStandaloneNode(root, '../node.zip', member, true), /Invalid/)
    await assert.rejects(extractStandaloneNode(root, 'node.zip', '../outside.exe', true), /Invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows tool archives use ASCII operands and forward their Unicode cwd for both rg and fd', { skip: process.platform === 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot tool archive π 中文 & '))
  try {
    for (const tool of ['rg', 'fd']) {
      const asset = toolAsset(tool, 'win32', 'x64')
      const source = join(root, tool, 'source'), archive = join(root, tool, 'fixture.zip')
      await mkdir(join(source, asset.member, '..'), { recursive: true })
      await writeFile(join(source, asset.member), `${tool} fixture bytes`)
      const tar = await archiveProgram()
      await exec(tar, ['--format', 'zip', '-cf', '../fixture.zip', asset.member], { cwd: source })
      const binDirectory = join(root, tool, 'bin'), stagingDirectory = join(root, tool, 'runtime')
      let extracted = 0
      const deps = { platform: 'win32', arch: 'x64', binDirectory, stagingDirectory, exists: existsSync,
        // Synthetic archive only: the real pinned download/hash runs natively.
        download: async (_url, destination) => { await cp(archive, destination); return asset.sha256 },
        run: (program, args, options) => {
          extracted++
          assert.equal(program, tar)
          assert.deepEqual(args, ['-xf', 'archive.zip', '-C', '.', asset.member])
          assert(args.every(arg => /^[\x20-\x7e]+$/.test(arg)))
          assert(options.cwd.startsWith(stagingDirectory))
          assert(options.cwd.includes('π 中文'))
          return exec(program, args, options)
        }
      }
      const installed = await installTool(tool, deps)
      assert.equal(await readFile(installed, 'utf8'), `${tool} fixture bytes`)
      assert.equal(await installTool(tool, deps), installed)
      assert.equal(extracted, 1)
      await writeFile(installed, 'damaged cached bytes')
      await assert.rejects(installTool(tool, { ...deps, download: async () => 'wrong digest' }), /checksum mismatch/)
      assert.equal(await readFile(installed, 'utf8'), 'damaged cached bytes')
      assert.equal(extracted, 1)
      assert.deepEqual(await readdir(stagingDirectory), [])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows archive members and tools reject unsupported or escaping operands before extraction', async () => {
  let ran = false
  for (const [filename, member] of [['../archive.zip', 'rg.exe'], ['archive.zip', '../rg.exe'], ['archive.zip', 'C:/rg.exe'], ['archive.zip', '-option'], ['archive.zip', 'nested\\rg.exe'], ['archive.zip', 'π.exe']])
    await assert.rejects(extractWindowsArchive('/unused', filename, member, async () => { ran = true }), /Invalid Windows archive/)
  assert.equal(ran, false)
  for (const name of ['other', '__proto__', 'toString']) assert.throws(() => toolAsset(name, 'win32', 'x64'), /Unknown code runtime tool/)
})

test('Windows archive host refuses missing, relative and nonordinary system tool paths', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot system archive control '))
  const previous = process.env.SystemRoot
  try {
    delete process.env.SystemRoot
    await assert.rejects(archiveProgram(), /SystemRoot must be absolute/)
    process.env.SystemRoot = 'relative'
    await assert.rejects(archiveProgram(), /SystemRoot must be absolute/)
    process.env.SystemRoot = root
    await mkdir(join(root, 'System32/tar.exe'), { recursive: true })
    await assert.rejects(archiveProgram(), /ordinary system executable/)
  } finally {
    if (previous === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = previous
    await rm(root, { recursive: true, force: true })
  }
})
test('target supports both desktop architectures and Linux arm64', () => {
  for (const os of ['darwin', 'linux']) for (const arch of ['x64', 'arm64']) assert.equal(nativeTarget(os, arch), `${os}-${arch}`)
  assert.equal(nativeTarget('win32', 'x64'), 'win32-x64')
  assert.equal(rustTarget('win32', 'x64'), 'x86_64-pc-windows-msvc')
  assert.throws(() => nativeTarget('win32', 'arm64'), /Unsupported/)
})
test('launchers preserve arguments and resolve paths containing spaces', { skip: process.platform === 'win32' }, async () => {
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
test('stage builds locked dependencies, validates Pi and emits artifact checksums', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-stage-'))
  try {
    for (const path of ['apps/desktop', 'apps/web/dist', 'skills', 'backend/pi-runtime', `backend/hexbot-core/target/${rustTarget(process.platform, process.arch)}/release`]) await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, 'skills/.history.json'), '{}\n')
    await writeFile(join(root, 'apps/web/dist/index.html'), '<html>Hexbot</html>')
    await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }))
    await writeFile(join(root, 'backend/pi-runtime/package.json'), JSON.stringify({ dependencies: { '@earendil-works/pi-coding-agent': '1.0.1' } }))
    await writeFile(join(root, 'backend/pi-runtime/package-lock.json'), '{}')
    await writeFile(join(root, `backend/hexbot-core/target/${rustTarget(process.platform, process.arch)}/release/hexbot`), 'daemon')
    const node = join(root, 'node'); await writeFile(node, 'node')
    const calls = []
    let failProbe = false
    const options = { repository: root, nodeExecutable: node, download: async url => ['rg', 'fd'].map(tool => toolAsset(tool, process.platform, process.arch)).find(asset => asset.url === url).sha256, run: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd })
      if (failProbe && args.at(-1) === '--version') throw new Error('Deliberately failing staged Node/Pi probe')
      if (command === 'tar') {
        const file = join(args[args.indexOf('-C') + 1], args.at(-1))
        await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'verified tool')
      }
      if (command === 'npm') {
        const cli = join(options.cwd, 'node_modules/@earendil-works/pi-coding-agent/dist')
        await mkdir(cli, { recursive: true }); await writeFile(join(cli, 'cli.js'), '// pi')
      }
      return { stdout: args.at(-1) === '--version' ? '1.0.1' : '22.20.0' }
    } }
    const result = await stageNativeRuntime(options)
    assert.equal(await readFile(join(result.destination, 'skills/.history.json'), 'utf8'), '{}\n')
    const manifest = JSON.parse(await readFile(join(result.destination, 'manifest.json'), 'utf8'))
    assert.equal(manifest.piVersion, '1.0.1'); assert.equal(manifest.version, '1.2.3')
    assert.match(manifest.files['hexbot-core'], /^[a-f0-9]{64}$/)
    for (const file of ['bin/rg', 'bin/fd', 'pi/search-tools.mjs']) assert.match(manifest.files[file], /^[a-f0-9]{64}$/)
    assert(Number.isSafeInteger(manifest.builtAt) && manifest.builtAt > 0)
    const cargo = calls.find(c => c.command === 'cargo').args
    assert(cargo.includes('--locked'))
    assert.equal(cargo[cargo.indexOf('--target') + 1], rustTarget(process.platform, process.arch))
    assert(calls.find(c => c.command === 'npm').args.includes(`--cpu=${process.arch}`))
    assert(calls.find(c => c.command === 'npm').args.includes(`--os=${process.platform}`))
    assert(calls.find(c => c.command === 'npm').args.includes('--ignore-scripts'))
    assert.deepEqual(calls.at(-1).args.slice(-1), ['--version'])
    const probe = calls.at(-1)
    assert.equal(probe.command, join(probe.cwd, 'node'))
    assert.equal(probe.args[0], join(probe.cwd, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'))
    assert(probe.cwd.startsWith(`${result.destination}.staging-`))
    const committed = await readFile(join(result.destination, 'manifest.json'), 'utf8')
    failProbe = true
    await assert.rejects(stageNativeRuntime(options), /Deliberately failing staged/)
    assert.equal(await readFile(join(result.destination, 'manifest.json'), 'utf8'), committed)
    assert.deepEqual(await readdir(join(root, 'apps/desktop/resources')), ['hexbot-native'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function publicationFixture(root) {
  const staging = join(root, 'executed'), destination = join(root, 'published')
  await mkdir(join(staging, 'pi/node_modules/native'), { recursive: true })
  await mkdir(join(staging, 'pi/theme/empty'), { recursive: true })
  await mkdir(join(staging, 'pi/node_modules/@earendil-works/pi-coding-agent/dist'), { recursive: true })
  for (const [path, bytes] of Object.entries({
    'node.exe': 'node bytes', 'manifest.json': '{"verified":true}',
    'pi/node_modules/native/binding.node': 'native module', 'pi/theme/default.json': 'relative asset',
    'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js': 'real entrypoint location'
  })) await writeFile(join(staging, path), bytes)
  await mkdir(destination)
  await writeFile(join(destination, 'manifest.json'), 'old destination')
  return { staging, destination }
}

test('complete runtime inventory includes sorted layout, empty directories and exact ordinary file hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot inventory π '))
  try {
    const { staging } = await publicationFixture(root)
    const inventory = await inventoryNativeRuntime(staging)
    assert.deepEqual(inventory.map(entry => entry.path), inventory.map(entry => entry.path).sort())
    assert.deepEqual(inventory[0], { path: '', type: 'directory' })
    assert(inventory.some(entry => entry.path === 'pi/theme/empty' && entry.type === 'directory'))
    assert.deepEqual(inventory.find(entry => entry.path === 'pi/node_modules/native/binding.node'), {
      path: 'pi/node_modules/native/binding.node', type: 'file', size: 13,
      sha256: createHash('sha256').update('native module').digest('hex')
    })
    const copied = join(root, 'copy')
    await cp(staging, copied, { recursive: true })
    assert.deepEqual(await inventoryNativeRuntime(copied), inventory)
    for (const linked of [join(root, 'root-link'), join(staging, 'nested-link')]) {
      await symlink(join(staging, 'pi/theme'), linked, process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(inventoryNativeRuntime(linked === join(root, 'root-link') ? linked : staging), /Linked native runtime entry/)
      await rm(linked, { recursive: true, force: true })
    }
    await assert.rejects(inventoryNativeRuntime(join(staging, 'node.exe')), /Nonordinary native runtime entry/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows finalization probes the original tree then publishes only an identical fresh sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot fresh publication π '))
  try {
    const { staging, destination } = await publicationFixture(root)
    const expected = await inventoryNativeRuntime(staging)
    let probed = false, fresh
    const result = await publishWindowsRuntime(staging, destination, '1.0.1', {
      run: async (program, args, options) => {
        assert.equal(program, join(staging, 'node.exe'))
        assert.deepEqual(args, [join(staging, 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--version'])
        assert.equal(options.cwd, staging)
        assert.equal(await readFile(join(options.cwd, 'pi/theme/default.json'), 'utf8'), 'relative asset')
        probed = true
        return { stdout: '1.0.1\r\n' }
      },
      copy: async (source, target, options) => {
        assert(probed)
        assert.equal(source, staging)
        assert(target.startsWith(`${destination}.staging-`))
        assert.notEqual(target, staging)
        assert.deepEqual(options, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true })
        fresh = target
        await copyNativeRuntime(source, target, options)
      }
    })
    assert.deepEqual(result.inventory, expected)
    assert.deepEqual(await inventoryNativeRuntime(destination), expected)
    for (const path of [staging, fresh]) await assert.rejects(stat(path), { code: 'ENOENT' })
    assert.deepEqual(await readdir(root), ['published'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('prepublication failures preserve the old destination and clean both owned staging trees', async t => {
  for (const fault of ['probe mutation', 'dropped native import', 'missing relative asset', 'missing empty directory', 'corrupt byte', 'copy error', 'preexisting copy file', 'wrong version']) {
    await t.test(fault, async () => {
      const root = await mkdtemp(join(tmpdir(), 'hexbot publication failure '))
      try {
        const { staging, destination } = await publicationFixture(root)
        const old = await inventoryNativeRuntime(destination)
        const copyError = new Error('injected copy error')
        let copies = 0
        await assert.rejects(publishWindowsRuntime(staging, destination, '1.0.1', {
          run: async () => {
            if (fault === 'probe mutation') await writeFile(join(staging, 'probe-added-file'), 'unexpected')
            return { stdout: fault === 'wrong version' ? '9.9.9' : '1.0.1' }
          },
          copy: async (source, target, options) => {
            copies++
            if (fault === 'copy error') throw copyError
            if (fault === 'preexisting copy file') await writeFile(join(target, 'node.exe'), 'must not overwrite')
            await copyNativeRuntime(source, target, options)
            if (fault === 'dropped native import') await rm(join(target, 'pi/node_modules/native/binding.node'))
            if (fault === 'missing relative asset') await rm(join(target, 'pi/theme/default.json'))
            if (fault === 'missing empty directory') await rm(join(target, 'pi/theme/empty'), { recursive: true })
            if (fault === 'corrupt byte') await writeFile(join(target, 'node.exe'), 'Node bytes')
          }
        }), error => fault === 'copy error' ? error === copyError
          : fault === 'preexisting copy file' ? error.code === 'ERR_FS_CP_EEXIST'
            : error.message.includes(fault === 'wrong version' ? 'pinned version' : 'pre-probe inventory'))
        assert.equal(copies, fault === 'wrong version' ? 0 : 1)
        assert.deepEqual(await inventoryNativeRuntime(destination), old)
        assert.deepEqual(await readdir(root), ['published'])
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }
})

test('pre-aborted runtime inventory and probe perform no filesystem or child work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot cancelled publication '))
  try {
    const { staging, destination } = await publicationFixture(root)
    const before = await inventoryNativeRuntime(root)
    const controller = new AbortController(), cancelled = new Error('test publication cancelled')
    controller.abort(cancelled)
    let calls = 0
    await assert.rejects(inventoryNativeRuntime(join(root, 'not-present'), controller.signal), error => error === cancelled)
    await assert.rejects(publishWindowsRuntime(staging, destination, '1.0.1', {
      signal: controller.signal,
      run: () => { calls++; throw new Error('pre-aborted probe ran') },
      copy: () => { calls++; throw new Error('pre-aborted copy ran') }
    }), error => error === cancelled)
    assert.equal(calls, 0)
    assert.deepEqual(await inventoryNativeRuntime(root), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('aborting an in-flight copy prevents publication and any later round or probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot copy cancelled '))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let completion
  try {
    const { staging, destination } = await publicationFixture(root)
    const before = await inventoryNativeRuntime(destination)
    const controller = new AbortController(), cancelled = new Error('deadline during copy')
    let probes = 0, copies = 0, successes = 0, probeSignal
    completion = (async () => {
      for (let round = 0; round < 3; round++) {
        controller.signal.throwIfAborted()
        await publishWindowsRuntime(staging, destination, '1.0.1', {
          signal: controller.signal,
          run: async (_program, _args, options) => {
            probeSignal = options.signal
            probes++
            return { stdout: '1.0.1' }
          },
          copy: async (source, target, options) => {
            copies++
            entered.resolve()
            await release.promise
            // fs.cp itself has no cancellation API. Finish that exact copy;
            // the production phase check must prevent the following rename.
            await copyNativeRuntime(source, target, options)
          }
        })
        controller.signal.throwIfAborted()
        successes++
      }
    })()
    const rejected = assert.rejects(completion, error => error === cancelled)
    await entered.promise
    controller.abort(cancelled)
    release.resolve()
    await rejected
    assert.deepEqual({ probes, copies, successes }, { probes: 1, copies: 1, successes: 0 })
    assert.deepEqual(await inventoryNativeRuntime(destination), before)
    assert.equal(probeSignal, controller.signal)
    assert.deepEqual(await readdir(root), ['published'])
  } finally {
    release.resolve()
    await completion?.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test('archive dereferences npm links and records the update format', { skip: process.platform === 'win32' }, async () => {
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
    assert.equal(manifest.size, (await stat(archive)).size)
    assert.equal(manifest.unpacked_size, await directoryBytes(unpacked))
    assert.notEqual((await stat(join(unpacked, 'hexbot'))).ino, (await stat(join(unpacked, 'alias'))).ino)
    await rm(join(unpacked, 'hexbot'))
    assert.equal(await readFile(join(unpacked, 'alias'), 'utf8'), 'executable')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('standalone Node rejects unpinned versions and tampered archives without fetching checksums', async t => {
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url)
    return new Response('tampered archive')
  })
  for (const os of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    assert.match(NODE_SHA256[`${os}-${arch}`], /^[a-f0-9]{64}$/)
    await assert.rejects(standaloneNode('/unused', os, arch), /checksum mismatch/)
  }
  assert.equal(urls.length, 4)
  assert.ok(urls.every(url => url.endsWith('.tar.gz') && url.includes(`/v${NODE_VERSION}/`)))
  await assert.rejects(standaloneNode('/unused', 'darwin', 'arm64', '99.0.0'), /not pinned/)
  assert.equal(urls.length, 4)
})

test('macOS update archives omit AppleDouble files and extended attributes', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-archive-xattr-'))
  try {
    const bundle = join(root, 'bundle'); await mkdir(bundle)
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.3', target: nativeTarget() }))
    await writeFile(join(bundle, 'hexbot'), 'executable')
    await exec('xattr', ['-w', 'com.apple.provenance', 'hexbot-regression', join(bundle, 'hexbot')])
    const archive = join(root, 'native.tar.gz')
    await createNativeArchive(bundle, archive)
    const { stdout } = await exec('python3', ['-c',
      'import tarfile,sys,json; t=tarfile.open(sys.argv[1]); print(json.dumps([(e.name,e.pax_headers) for e in t]))', archive])
    const entries = JSON.parse(stdout)
    assert.equal(entries.length, 3)
    assert.ok(entries.every(([name, headers]) => !name.split('/').some(part => part.startsWith('._')) &&
      !Object.keys(headers).some(key => /xattr/i.test(key))))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pruning removes foreign nested optional binaries and development files, preserving runtime assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-prune-'))
  try {
    const modules = join(root, 'node_modules')
    for (const [name, metadata] of [
      ['agent', {}], ['agent/node_modules/@esbuild/darwin-arm64', { os: ['darwin'], cpu: ['arm64'] }],
      ['agent/node_modules/@esbuild/darwin-x64', { os: ['darwin'], cpu: ['x64'] }],
      ['@img/linux', { os: ['linux'], cpu: ['arm64'] }], ['@types/node', {}]
    ]) {
      const directory = join(modules, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify(metadata))
      await writeFile(join(directory, 'runtime.js'), 'runtime')
    }
    for (const file of ['dist/main.js', 'dist/main.js.map', 'dist/main.d.ts', 'docs/guide.md', 'examples/demo.ts', 'dist/theme/dark.json']) {
      const path = join(modules, 'agent', file)
      await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, file)
    }
    for (const os of ['darwin', 'linux', 'win32']) for (const cpu of ['arm64', 'x64']) {
      const path = join(modules, 'agent/native', os, 'prebuilds', `${os}-${cpu}`)
      await mkdir(path, { recursive: true }); await writeFile(join(path, 'tui.node'), 'native')
    }
    await pruneRuntimeDependencies(modules, 'darwin', 'arm64')
    assert((await stat(join(modules, 'agent/native/darwin/prebuilds/darwin-arm64/tui.node'))).isFile())
    for (const path of ['darwin/prebuilds/darwin-x64', 'linux', 'win32'])
      await assert.rejects(stat(join(modules, 'agent/native', path)), { code: 'ENOENT' })
    for (const file of ['agent/runtime.js', 'agent/dist/main.js', 'agent/dist/theme/dark.json', 'agent/node_modules/@esbuild/darwin-arm64/runtime.js'])
      assert((await stat(join(modules, file))).isFile())
    for (const file of ['agent/dist/main.js.map', 'agent/dist/main.d.ts', 'agent/docs', 'agent/examples', '@types', '@img/linux', 'agent/node_modules/@esbuild/darwin-x64'])
      await assert.rejects(stat(join(modules, file)), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Windows ZIP advertises the actual daemon and contains the verified entrypoint', { skip: process.platform === 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot windows archive π 中文 '))
  try {
    const bundle = join(root, 'bundle'); await mkdir(bundle)
    await writeFile(join(bundle, 'hexbot.exe'), 'MZ fixture')
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.3', target: 'win32-x64', files: { 'hexbot.exe': 'pending' } }))
    const file = join(root, 'native π.zip')
    const manifest = await createNativeArchive(bundle, file)
    assert.equal(manifest.entrypoint, 'hexbot.exe'); assert.equal(manifest.format, 'zip')
    assert.equal(manifest.target, 'windows-x86_64')
    const archive = await readFile(file)
    const digest = createHash('sha256').update(archive).digest('hex')
    const header = archive.subarray(0, 32).toString('hex')
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/tar.exe') : 'tar'
    const version = await exec(tar, ['--version'], { windowsHide: true })
    const tool = { program: process.platform === 'win32' ? await realpath(tar) : tar, version: `${version.stdout}${version.stderr}`.trim().slice(0, 1024) }
    const evidence = { tool, file, size: archive.length, header, sha256: digest, manifest }
    console.log('ZIP roundtrip archive:', JSON.stringify(evidence))
    assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304')
    assert.equal(manifest.size, archive.length); assert.equal(manifest.sha256, digest)
    // A rename keeps the exact production-created Unicode archive bytes while
    // giving tar ASCII operands, as in the standalone Node extraction boundary.
    const named = join(root, 'native.zip'); await rename(file, named)
    assert.deepEqual(await readFile(named), archive)
    const out = join(root, 'out-file'); await mkdir(out)
    // Product ZIP consumers use seekable files. Native 5e985 controls proved
    // this same-byte mode succeeds with Unicode cwd on bsdtar 3.8.4 and 3.8.9;
    // their unexplained stdin ZIP failure is not a product requirement.
    const report = await captureArchiveCommand(tar, ['-xf', '../native.zip', '-C', '.'], out)
    console.log('ZIP roundtrip extraction:', JSON.stringify({ ...evidence, mode: 'filename', ...report }))
    assert.deepEqual(report.status, [0, null], JSON.stringify(report))
    assert.equal(await readFile(join(out, manifest.entrypoint), 'utf8'), 'MZ fixture')
    const unpacked = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
    assert.equal(unpacked.files['hexbot.exe'], createHash('sha256').update('MZ fixture').digest('hex'))
    assert.equal(manifest.unpacked_size, await directoryBytes(out))
    await rm(join(bundle, 'hexbot.exe'))
    await assert.rejects(createNativeArchive(bundle, file))
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed publication keeps the verified staging tree and never publishes partial bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot publish failure '))
  try {
    const staging = join(root, 'staging'); const destination = join(root, 'missing-parent', 'native')
    await mkdir(staging); await writeFile(join(staging, 'manifest.json'), 'verified')
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args))
    await assert.rejects(publishNativeRuntime(staging, destination), { code: 'ENOENT' })
    assert.equal(await readFile(join(staging, 'manifest.json'), 'utf8'), 'verified')
    await assert.rejects(stat(destination), { code: 'ENOENT' })
    const details = JSON.parse(errors[0][1]); assert.equal(details.staged.directory, true)
    assert.equal(details.target.error, 'ENOENT')
    await mkdir(join(root, 'missing-parent'))
    await publishNativeRuntime(staging, destination)
    assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), 'verified')
    await assert.rejects(stat(staging), { code: 'ENOENT' })
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('Windows publication refuses a live staging cwd and succeeds after its owned process exits', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot staging lock π '))
  const staging = join(root, 'staging'); const destination = join(root, 'native')
  await mkdir(staging); await writeFile(join(staging, 'manifest.json'), 'verified bytes')
  const child = spawn(process.execPath, ['-e', "process.send('ready');process.on('message',()=>process.exit(0))"], { cwd: staging, windowsHide: true, signal: t.signal, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const closed = once(child, 'close')
  try {
    const ready = await Promise.race([once(child, 'message'), closed.then(status => { throw new Error(`Lock fixture exited before readiness: ${status}`) })])
    assert.equal(ready[0], 'ready')
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args))
    await assert.rejects(publishNativeRuntime(staging, destination), error => ['EPERM', 'EBUSY'].includes(error.code))
    assert.equal(await readFile(join(staging, 'manifest.json'), 'utf8'), 'verified bytes')
    await assert.rejects(stat(destination), { code: 'ENOENT' })
    const diagnostic = JSON.parse(errors[0][1])
    assert.equal(diagnostic.staged.directory, true)
    assert.equal(diagnostic.windows.directoryDeleteAccess, 32, JSON.stringify(diagnostic))
    assert.ok(diagnostic.windows.related.some(p => p.pid === child.pid), JSON.stringify(diagnostic))
    console.log('Held-CWD publication evidence:', JSON.stringify(diagnostic))
    child.send('release')
    assert.deepEqual(await closed, [0, null])
    // A distinct operation after an explicit kernel/process event, no retry.
    await publishNativeRuntime(staging, destination)
    assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), 'verified bytes')
  } finally {
    if (child.exitCode === null) child.kill()
    await closed
    await rm(root, {recursive:true,force:true})
  }
})
