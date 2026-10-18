import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { crc32, deflateRawSync } from 'node:zlib'
import test from 'node:test'
import { createNativeArchive } from './native-runtime.mjs'
import {
  MICROSOFT_MXC_LICENSE,
  WINDOWS_SANDBOX_FILES,
  WINDOWS_SANDBOX_RUNTIME,
  readSandboxExecutable,
  stageWindowsSandboxRuntime,
  verifyMicrosoftSandboxSignature
} from './windows-sandbox-runtime.mjs'

const member = WINDOWS_SANDBOX_RUNTIME.member
function zip(entries) {
  const locals = [],
    central = []
  let offset = 0
  for (const { name, bytes = Buffer.from('executor'), method = 8, mode = 0x8000 } of entries) {
    const filename = Buffer.from(name),
      packed = method === 8 ? deflateRawSync(bytes) : bytes
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(0x314, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc32(bytes), 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(bytes.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE((mode << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, filename, packed)
    central.push(entry, filename)
    offset += local.length + filename.length + packed.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'Hexbot MXC Ω '))
  try {
    await run(root, join(root, 'fixture.zip'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('reads only the selected regular executable and never extracts other package tools', async () => {
  await fixture(async (root, archive) => {
    const bytes = Buffer.from('selected executor')
    for (const method of [0, 8]) {
      await writeFile(
        archive,
        zip([
          { name: 'x64/wxc-host-prep.exe' },
          { name: member, bytes, method },
          { name: 'arm64/wxc-exec.exe' }
        ])
      )
      assert.deepEqual(await readSandboxExecutable(archive), bytes)
      assert.deepEqual(await readdir(root), ['fixture.zip'])
    }
    await assert.rejects(readSandboxExecutable(archive, '../wxc-exec.exe'), /Unsupported/)
  })
})

test('rejects ambiguous, linked, encrypted, truncated and oversized ZIP entries', async () => {
  await fixture(async (_root, archive) => {
    for (const entries of [
      [{ name: member }, { name: member }],
      [{ name: 'arm64/wxc-exec.exe' }],
      [{ name: member, mode: 0xa000 }],
      [{ name: '../outside.exe' }, { name: member }]
    ]) {
      await writeFile(archive, zip(entries))
      await assert.rejects(readSandboxExecutable(archive), /Invalid/)
    }
    const original = zip([{ name: member }])
    const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    for (const mutate of [
      bytes => bytes.writeUInt16LE(1, central + 8),
      bytes => bytes.writeUInt32LE(17 * 1024 * 1024, central + 24),
      bytes => bytes.writeUInt32LE(17 * 1024 * 1024, central + 20),
      bytes => bytes.writeUInt32LE(0xffffffff, central + 42),
      bytes => bytes.writeUInt16LE(4096, bytes.length - 22 + 10),
      bytes => bytes.writeUInt32LE(2 * 1024 * 1024, bytes.length - 22 + 12),
      bytes => bytes.writeUInt32LE(0, 14),
      bytes => {
        bytes[30] ^= 1
      }
    ]) {
      const bytes = Buffer.from(original)
      mutate(bytes)
      await writeFile(archive, bytes)
      await assert.rejects(readSandboxExecutable(archive), /Invalid/)
    }
    await writeFile(archive, original.subarray(0, original.length - 1))
    await assert.rejects(readSandboxExecutable(archive), /Invalid/)
    const corrupt = Buffer.from(original)
    corrupt.writeUInt32LE(0, 14)
    corrupt.writeUInt32LE(0, central + 16)
    await writeFile(archive, corrupt)
    await assert.rejects(readSandboxExecutable(archive), /Invalid/)
  })
})

test('rejects oversized decompression even when a ZIP advertises a small result', async () => {
  await fixture(async (_root, archive) => {
    const bytes = zip([{ name: member, bytes: Buffer.alloc(17 * 1024 * 1024) }])
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(1, 22)
    bytes.writeUInt32LE(1, central + 24)
    await writeFile(archive, bytes)
    await assert.rejects(readSandboxExecutable(archive), /larger than|too large|length|Invalid/i)
  })
})

test('target validation and archive verification happen before executable publication', async () => {
  await fixture(async root => {
    let downloads = 0,
      commands = 0
    const options = {
      destination: join(root, 'runtime'),
      cacheDirectory: join(root, 'cache'),
      download: async (_url, path) => {
        downloads++
        await writeFile(path, 'tampered archive')
      },
      run: async () => {
        commands++
        throw new Error('must not execute anything')
      }
    }
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['win32', 'arm64']
    ])
      await assert.rejects(
        stageWindowsSandboxRuntime({ ...options, platform, arch }),
        /Unsupported/
      )
    assert.equal(downloads, 0)
    await assert.rejects(stageWindowsSandboxRuntime(options), /invalid type or size/)
    assert.equal(downloads, 1)
    assert.equal(commands, 0)
    assert.deepEqual(await readdir(options.cacheDirectory), [])
    await assert.rejects(lstat(options.destination), { code: 'ENOENT' })
  })
})

test('cached archive bytes are hashed again before ZIP parsing or execution', async () => {
  await fixture(async root => {
    const cacheDirectory = join(root, 'cache')
    await mkdir(cacheDirectory)
    const archive = join(cacheDirectory, basename(WINDOWS_SANDBOX_RUNTIME.url))
    const file = await open(archive, 'wx')
    await file.truncate(WINDOWS_SANDBOX_RUNTIME.bytes)
    await file.close()
    await assert.rejects(
      stageWindowsSandboxRuntime({
        destination: join(root, 'runtime'),
        cacheDirectory,
        download: async () => {
          throw new Error('no new download should be trusted')
        },
        run: async () => {
          throw new Error('no execution before verification')
        }
      }),
      /checksum mismatch/
    )
    await assert.rejects(lstat(join(root, 'runtime')), { code: 'ENOENT' })
  })
})

test('Authenticode requires a valid Microsoft publisher and keeps PowerShell module lookup isolated', async () => {
  const executable = 'C:\\Build Ω \\wxc-exec.exe'
  let inspected = false
  await verifyMicrosoftSandboxSignature(executable, async (command, args, options) => {
    inspected = true
    assert(command.endsWith(join('WindowsPowerShell', 'v1.0', 'powershell.exe')))
    assert(args.includes('-NoProfile') && args.includes('-NonInteractive'))
    assert.equal(options.env.HEXBOT_MXC_EXECUTABLE, executable)
    assert.equal(options.env.PSModulePath, undefined)
    assert.equal(options.windowsHide, true)
    return {
      stdout:
        '{"status":"Valid","subject":"CN=Microsoft Corporation, O=Microsoft Corporation, C=US"}'
    }
  })
  assert(inspected)
  for (const signature of [
    { status: 'HashMismatch', subject: 'O=Microsoft Corporation' },
    { status: 'Valid', subject: 'O=Another publisher' }
  ])
    await assert.rejects(
      verifyMicrosoftSandboxSignature(executable, async () => ({
        stdout: JSON.stringify(signature)
      })),
      /Authenticode signature is invalid/
    )
})

test(
  'actual pinned Microsoft executor and MIT notice survive a native archive unchanged',
  {
    skip: !process.env.HEXBOT_TEST_MXC_ARCHIVE
  },
  async () => {
    await fixture(async root => {
      const archive = process.env.HEXBOT_TEST_MXC_ARCHIVE
      assert.equal(basename(archive), basename(WINDOWS_SANDBOX_RUNTIME.url))
      const destination = join(root, 'runtime')
      const files = await stageWindowsSandboxRuntime({
        destination,
        cacheDirectory: dirname(archive),
        download: async () => {
          throw new Error('Use the supplied pinned archive')
        }
      })
      assert.deepEqual(files, WINDOWS_SANDBOX_FILES)
      const hashes = {}
      for (const file of files)
        hashes[file] = createHash('sha256')
          .update(await readFile(join(destination, file)))
          .digest('hex')
      assert.equal(hashes['wxc-exec.exe'], WINDOWS_SANDBOX_RUNTIME.executableSha256)
      assert.equal(await readFile(join(destination, files[1]), 'utf8'), MICROSOFT_MXC_LICENSE)
      await writeFile(
        join(destination, 'manifest.json'),
        JSON.stringify({ version: '1.2.3', target: 'win32-x64', files: hashes })
      )
      const native = join(root, 'native.tar.gz')
      await createNativeArchive(destination, native)
      const unpacked = join(root, 'unpacked')
      await mkdir(unpacked)
      const tar =
        process.platform === 'win32'
          ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe')
          : 'tar'
      await promisify(execFile)(tar, ['-xzf', native, '-C', unpacked])
      for (const file of files)
        assert.equal(
          createHash('sha256')
            .update(await readFile(join(unpacked, file)))
            .digest('hex'),
          hashes[file]
        )
    })
  }
)
