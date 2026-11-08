import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { pdfFixture } from './fixtures/pdf-runtime.mjs'
import { PDF_RUNTIME_FILES, pdfSourceArchiveRecord, stagePdfRuntime, validatePdfRelease, validatePdfRuntime } from './pdf-runtime.mjs'


async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pdf-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('PDF payload checks fixed files, architecture, hashes and executable helper', async t => {
  const root = await fixture(t)
  for (const arch of ['arm64', 'x64']) {
    const directory = join(root, arch)
    await pdfFixture(directory, { arch })
    const checked = await validatePdfRuntime(directory, arch)
    assert.deepEqual(Object.keys(checked.files).sort(), PDF_RUNTIME_FILES.map(name => `pdf/${name}`).sort())
    await assert.rejects(validatePdfRuntime(directory, arch === 'arm64' ? 'x64' : 'arm64'), /architecture/)
    await writeFile(join(directory, 'rootfs'), 'damaged')
    await assert.rejects(validatePdfRuntime(directory, arch), /checksum/)
  }
})

test('PDF payload rejects missing, linked and unexpected files', async t => {
  const root = await fixture(t)
  await pdfFixture(root)
  await rm(join(root, 'kernel'))
  await assert.rejects(validatePdfRuntime(root, 'arm64'), /Unexpected PDF runtime files/)
  await writeFile(join(root, 'kernel'), 'kernel')
  await rm(join(root, 'rootfs'))
  await symlink('kernel', join(root, 'rootfs'))
  await assert.rejects(validatePdfRuntime(root, 'arm64'), /Invalid file/)
  await rm(join(root, 'rootfs'))
  await writeFile(join(root, 'rootfs'), 'rootfs')
  await writeFile(join(root, 'extra'), 'unexpected')
  await assert.rejects(validatePdfRuntime(root, 'arm64'), /Unexpected PDF runtime files/)
})

test('an owned 0401 helper is refused when its owner cannot execute it', {
  skip: process.platform === 'win32' || process.geteuid?.() === 0
}, async t => {
  const root = await fixture(t)
  await pdfFixture(root)
  await chmod(join(root, 'hexbot-pdf-vm'), 0o401)
  await assert.rejects(validatePdfRuntime(root, 'arm64'), /PDF VM runtime is missing or damaged/)
  await chmod(join(root, 'hexbot-pdf-vm'), 0o755)
  await validatePdfRuntime(root, 'arm64')
})

test('release requires real companion bytes and a content verifier, never prototype flags', async t => {
  const root = await fixture(t)
  const directory = join(root, 'pdf')
  await pdfFixture(directory)
  await assert.rejects(validatePdfRelease(await validatePdfRuntime(directory, 'arm64'), { version: '1.2.3' }), /prototype/)
  const input = await pdfFixture(directory, { release: true })
  const checked = await validatePdfRuntime(directory, 'arm64')
  await assert.rejects(validatePdfRelease(checked, { version: '1.2.3' }), /must be present/)
  const sourceArchivePath = join(root, input.archive.file)
  await writeFile(sourceArchivePath, input.archiveBytes)
  await assert.rejects(validatePdfRelease(checked, { version: '1.2.3', sourceArchivePath }), /content verifier/)
  let verified = 0
  const verifySources = async (path, sources) => {
    assert.equal(basename(path), sources.archive.file)
    verified++
  }
  assert.deepEqual(await validatePdfRelease(checked, { version: '1.2.3', sourceArchivePath, verifySources }), input.archive)
  assert.equal(verified, 1)
  await writeFile(sourceArchivePath, Buffer.alloc(input.archiveBytes.length))
  await assert.rejects(validatePdfRelease(checked, { version: '1.2.3', sourceArchivePath, verifySources }), /must be present/)
  assert.equal(verified, 1)
})

test('source inventories and full notices get their reviewed 8 MiB allowance', async t => {
  const root = await fixture(t)
  for (const name of ['SOURCES.json', 'THIRD_PARTY_NOTICES']) {
    const directory = join(root, name)
    const { sources } = await pdfFixture(directory)
    const content = bytes => name === 'SOURCES.json'
      ? JSON.stringify({ ...sources, inventory: 'x'.repeat(bytes) }) : `INCOMPLETE\n${'x'.repeat(bytes)}`
    await writeFile(join(directory, name), content(2 * 1024 * 1024))
    await validatePdfRuntime(directory, 'arm64')
    await writeFile(join(directory, name), content(8 * 1024 * 1024))
    await assert.rejects(validatePdfRuntime(directory, 'arm64'), /Invalid file/)
  }
})

test('release source records require matching immutable HTTPS identity', async t => {
  const root = await fixture(t)
  const { provenance, sources } = await pdfFixture(root, { release: true })
  for (const url of ['http://updates.hexbot.app/1.2.3/pdf-sources-1.2.3.tar.gz',
    'https://updates.hexbot.app/1.2.3/other.tar.gz', 'https://updates.hexbot.app/latest/sources.tar.gz']) {
    await assert.rejects(validatePdfRelease({ provenance, sources: { ...sources, archive: { ...sources.archive, url } } },
      { version: '1.2.3' }), /immutable versioned HTTPS/)
  }
  await assert.rejects(validatePdfRelease({ provenance: { ...provenance, sourceArchive: { ...sources.archive, bytes: 1 } }, sources },
    { version: '1.2.3' }), /records disagree/)
})

test('source archive records enforce the verifier byte bound before file or network reads', () => {
  const limit = 8 * 1024 ** 3
  const record = { file: 'pdf-sources-1.2.3.tar.gz', sha256: 'a'.repeat(64), bytes: limit,
    url: 'https://updates.hexbot.app/1.2.3/pdf-sources-1.2.3.tar.gz' }
  assert.deepEqual(pdfSourceArchiveRecord(record, '1.2.3'), record)
  assert.throws(() => pdfSourceArchiveRecord({ ...record, bytes: limit + 1 }, '1.2.3'), /archive record/)
})

test('explicit Dev staging builds a matching helper without fetching guest assets', async t => {
  const root = await fixture(t)
  const assetsDirectory = join(root, 'assets')
  await pdfFixture(assetsDirectory, { helper: false })
  let builds = 0
  const destination = join(root, 'pdf')
  const result = await stagePdfRuntime({ repository: root, destination, arch: 'arm64', assetsDirectory, run: async (command, args) => {
    assert.equal(command, join(root, 'backend/pdf-runtime/macos/build.sh'))
    assert.equal(args[1], 'arm64')
    const binary = Buffer.alloc(16)
    binary.writeUInt32LE(0xfeedfacf)
    binary.writeUInt32LE(0x100000c, 4)
    await writeFile(args[0], binary)
    builds++
  } })
  assert.equal(builds, 1)
  assert.equal(Object.keys(result.files).length, 9)
  assert.equal(await readFile(join(destination, 'THIRD_PARTY_NOTICES'), 'utf8'), 'INCOMPLETE development prototype notices')
  await assert.rejects(stagePdfRuntime({ repository: root, destination: join(root, 'absent'), arch: 'arm64', run: async () => {} }), /HEXBOT_PDF_ASSETS_DIRECTORY/)
})
