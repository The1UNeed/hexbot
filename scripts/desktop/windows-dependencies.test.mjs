import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkWindowsDependencies, inspectPE, isWindowsSystemLibrary } from './windows-dependencies.mjs'

// A PE with one .idata section. Descriptor/name offsets follow the Microsoft
// PE specification; the fixture is data for the parser, not executable code.
function pe({ imports = [], delay = [], plus = true, legacyDelay = false } = {}) {
  const bytes = Buffer.alloc(0x1200)
  const optional = 0x98, size = plus ? 0xf0 : 0xe0, directories = optional + (plus ? 112 : 96)
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80)
  bytes.writeUInt16LE(plus ? 0x8664 : 0x14c, 0x84)
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(size, 0x94)
  bytes.writeUInt16LE(plus ? 0x20b : 0x10b, optional)
  if (plus) bytes.writeBigUInt64LE(0x140000000n, optional + 24)
  else bytes.writeUInt32LE(0x400000, optional + 28)
  bytes.writeUInt32LE(0x200, optional + 60)
  bytes.writeUInt32LE(16, directories - 4)
  const section = optional + size
  bytes.write('.idata', section)
  for (const [offset, value] of [[8, 0x1000], [12, 0x1000], [16, 0x1000], [20, 0x200]]) bytes.writeUInt32LE(value, section + offset)
  let nameOffset = 0x800
  for (const [names, index, stride, table] of [[imports, 1, 20, 0x200], [delay, 13, 32, 0x400]]) {
    if (!names.length) continue
    bytes.writeUInt32LE(table + 0xe00, directories + index * 8)
    bytes.writeUInt32LE((names.length + 1) * stride, directories + index * 8 + 4)
    names.forEach((name, number) => {
      const descriptor = table + number * stride
      if (index === 13) bytes.writeUInt32LE(legacyDelay ? 0 : 1, descriptor)
      bytes.writeUInt32LE(nameOffset + 0xe00 + (index === 13 && legacyDelay ? 0x400000 : 0), descriptor + (index === 13 ? 4 : 12))
      bytes.write(`${name}\0`, nameOffset, 'latin1')
      nameOffset += Buffer.byteLength(name) + 1
    })
  }
  return bytes
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hexbot PE 中文 & spaces '))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('PE32/PE32+ ordinary and delay descriptors are read, including legacy VA names', () => {
  for (const plus of [false, true]) {
    const result = inspectPE(pe({ plus, imports: ['KERNEL32.dll'], delay: ['VCRUNTIME140_1.dll'] }))
    assert.equal(result.machine, plus ? 0x8664 : 0x14c)
    assert.deepEqual(result.imports, [{ name: 'kernel32.dll', delay: false }, { name: 'vcruntime140_1.dll', delay: true }])
  }
  assert.deepEqual(inspectPE(pe({ plus: false, legacyDelay: true, delay: ['MSVCP140.dll'] })).imports,
    [{ name: 'msvcp140.dll', delay: true }])
})

test('malformed offsets, truncated sections, missing terminators and unsafe names fail closed', () => {
  const bad = []
  bad.push(Buffer.from('not a PE'), pe().subarray(0, 0x200))
  let bytes = pe(); bytes.writeUInt32LE(0xfffffff0, 0x3c); bad.push(bytes)
  bytes = pe(); bytes.writeUInt16LE(0xaa64, 0x84); bad.push(bytes)
  bytes = pe(); bytes.writeUInt16LE(97, 0x86); bad.push(bytes)
  bytes = pe(); bytes.writeUInt32LE(0x1_0000, 0x98 + 60); bad.push(bytes)
  bytes = pe({ imports: ['kernel32.dll'] }); bytes.writeUInt32LE(0x77777777, 0x20c); bad.push(bytes)
  bytes = pe({ imports: ['kernel32.dll'] }); bytes.writeUInt32LE(20, 0x98 + 112 + 12); bad.push(bytes)
  bytes = pe({ imports: ['kernel32.dll'] }); bytes.fill(65, 0x800, 0x800 + 261); bad.push(bytes)
  bytes = pe({ delay: ['kernel32.dll'] }); bytes.writeUInt32LE(2, 0x400); bad.push(bytes)
  bytes = pe({ delay: ['kernel32.dll'] }); bytes.writeUInt32LE(0, 0x400); bad.push(bytes)
  bad.push(pe({ imports: ['..\\vcruntime140.dll'] }), pe({ imports: ['bad/name.dll'] }))
  for (const bytes of bad) assert.throws(() => inspectPE(bytes), /invalid PE image/)
})

test('only OS components and API contracts are exempt, never developer-installed CRTs', () => {
  for (const name of ['KERNEL32.DLL', 'ucrtbase.dll', 'msvcrt.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']) assert.equal(isWindowsSystemLibrary(name), true, name)
  for (const name of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcr120.dll', 'concrt140.dll', 'vcomp140.dll', 'ucrtbased.dll', 'libvips-42.dll']) assert.equal(isWindowsSystemLibrary(name), false, name)
})

test('all shipped addons and DLLs are inspected for missing transitive and delay dependencies', async t => {
  const root = await fixture(t)
  const lib = join(root, 'pi/node_modules/@img/sharp-win32-x64/lib')
  await mkdir(lib, { recursive: true })
  await writeFile(join(root, 'node.exe'), pe({ imports: ['KERNEL32.dll'] }))
  await writeFile(join(lib, 'sharp.node'), pe({ imports: ['libvips-42.dll'], delay: ['node.exe'] }))
  await writeFile(join(lib, 'libvips-42.dll'), pe({ imports: ['VCRUNTIME140.dll'], delay: ['MSVCP140.dll'] }))
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), error => {
    assert.match(error.message, /libvips-42.dll: missing vcruntime140.dll/)
    assert.match(error.message, /missing delay-loaded msvcp140.dll/)
    return true
  })
  await writeFile(join(lib, 'vcruntime140.dll'), pe({ imports: ['ucrtbase.dll'] }))
  await writeFile(join(lib, 'msvcp140.dll'), pe({ imports: ['vcruntime140.dll'] }))
  const report = await checkWindowsDependencies({ roots: [root] })
  assert.equal(report.files, 5)
  assert.equal(report.scopes.length, 1)
})

test('another runtime, wrong architecture or standalone build neighbor cannot satisfy a dependency', async t => {
  const root = await fixture(t), nested = join(root, 'resources/hexbot-native')
  await mkdir(nested, { recursive: true })
  const app = join(root, 'Hexbot.exe'), runtime = join(nested, 'node.exe')
  await writeFile(app, pe({ imports: ['VCRUNTIME140.dll'] }))
  await writeFile(runtime, pe())
  await writeFile(join(nested, 'vcruntime140.dll'), pe())
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), /Hexbot.exe: missing vcruntime140.dll/)
  await writeFile(join(root, 'vcruntime140.dll'), pe({ plus: false }))
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), /Hexbot.exe: missing vcruntime140.dll/)
  await writeFile(join(root, 'vcruntime140.dll'), pe())
  await checkWindowsDependencies({ roots: [root] })
  await assert.rejects(checkWindowsDependencies({ files: [app] }), /missing vcruntime140.dll/)
  await rm(join(nested, 'vcruntime140.dll'))
  await writeFile(runtime, pe({ imports: ['VCRUNTIME140.dll'] }))
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), /node.exe: missing vcruntime140.dll/)
})

test('distribution roots cannot share an absent dependency', async t => {
  const root = await fixture(t), first = join(root, 'full'), second = join(root, 'client')
  await mkdir(first); await mkdir(second)
  await writeFile(join(first, 'app.exe'), pe({ imports: ['helper.dll'] }))
  await writeFile(join(second, 'helper.dll'), pe())
  await assert.rejects(checkWindowsDependencies({ roots: [first, second] }), /missing helper.dll/)
})

test('empty roots, links and exhausted traversal/byte budgets are errors', async t => {
  const root = await fixture(t)
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), /no Windows PE files/)
  await writeFile(join(root, 'app.exe'), pe())
  await writeFile(join(root, 'helper.dll'), pe())
  await assert.rejects(checkWindowsDependencies({ roots: [root] }, { files: 1 }), /limit/)
  await assert.rejects(checkWindowsDependencies({ roots: [root] }, { fileBytes: 1 }), /limit/)
  await assert.rejects(checkWindowsDependencies({ roots: [root] }, { totalBytes: 1 }), /limit/)
  await assert.rejects(checkWindowsDependencies({ roots: [root] }, { entries: 1 }), /limit/)
  const nested = join(root, 'nested'); await mkdir(nested)
  await assert.rejects(checkWindowsDependencies({ roots: [root] }, { depth: 0 }), /depth limit/)
  await symlink(nested, join(root, 'link'), 'junction')
  await assert.rejects(checkWindowsDependencies({ roots: [root] }), /links are not supported/)
})

test('CLI checks actual inputs and exits unsuccessfully for malformed or missing runtimes', async t => {
  const root = await fixture(t), app = join(root, 'installer.exe')
  const run = promisify(execFile), script = fileURLToPath(new URL('./windows-dependencies.mjs', import.meta.url))
  await writeFile(app, pe({ imports: ['kernel32.dll'], plus: false }))
  const result = await run(process.execPath, [script, '--file', app])
  assert.match(result.stdout, /1 PE files/)
  await writeFile(app, pe({ delay: ['vcruntime140.dll'] }))
  await assert.rejects(run(process.execPath, [script, '--file', app]), /missing delay-loaded vcruntime140.dll/)
  await assert.rejects(run(process.execPath, [script, '--unknown', app]), /Usage:/)
})

test('the Windows VM also parses a real Node executable', { skip: process.platform !== 'win32' }, async () => {
  const result = inspectPE(await readFile(process.execPath), process.execPath)
  assert.equal(result.machine, 0x8664)
  assert.ok(result.imports.some(item => item.name === 'kernel32.dll'))
})
