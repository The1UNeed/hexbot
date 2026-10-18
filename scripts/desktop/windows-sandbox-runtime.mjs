// Package Microsoft's signed executor without preparing or enabling a host backend.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { crc32, inflateRawSync } from 'node:zlib'
import { inspectPE } from './windows-dependencies.mjs'

const execute = promisify(execFile)
export const WINDOWS_SANDBOX_RUNTIME = Object.freeze({
  version: '1.0.1',
  url: 'https://github.com/microsoft/mxc/releases/download/v1.0.1/mxc-release-binaries.zip',
  bytes: 542_051_775,
  sha256: '0e832239454ba7fcd338ff56218a287eef4c0a01c1484084b869f55feff8abe9',
  member: 'x64/wxc-exec.exe',
  executableSha256: '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a'
})
const maxExecutableBytes = 16 * 1024 * 1024
export const WINDOWS_SANDBOX_FILES = Object.freeze(['wxc-exec.exe', 'licenses/microsoft-mxc.txt'])
// https://github.com/microsoft/mxc/blob/v1.0.1/LICENSE.md
export const MICROSOFT_MXC_LICENSE = `Microsoft eXecution Container (MXC) v1.0.1
https://github.com/microsoft/mxc

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
`

async function archiveHash(path) {
  const metadata = await lstat(path)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== WINDOWS_SANDBOX_RUNTIME.bytes
  )
    throw new Error('Microsoft sandbox archive has an invalid type or size')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    if ((bytes += chunk.length) > WINDOWS_SANDBOX_RUNTIME.bytes)
      throw new Error('Microsoft sandbox archive exceeded its size limit')
    hash.update(chunk)
  }
  if (
    bytes !== WINDOWS_SANDBOX_RUNTIME.bytes ||
    hash.digest('hex') !== WINDOWS_SANDBOX_RUNTIME.sha256
  )
    throw new Error('Microsoft sandbox archive checksum mismatch')
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || !response.body)
    throw new Error(`Microsoft sandbox download failed: ${response.status}`)
  if (Number(response.headers.get('content-length')) > WINDOWS_SANDBOX_RUNTIME.bytes)
    throw new Error('Microsoft sandbox archive exceeded its size limit')
  let bytes = 0
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(
          bytes > WINDOWS_SANDBOX_RUNTIME.bytes
            ? new Error('Microsoft sandbox archive exceeded its size limit')
            : null,
          chunk
        )
      }
    }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  )
}

async function pinnedArchive(cacheDirectory, download) {
  await mkdir(cacheDirectory, { recursive: true })
  const archive = join(cacheDirectory, basename(WINDOWS_SANDBOX_RUNTIME.url))
  const cached = await lstat(archive).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (cached) {
    await archiveHash(archive)
    return archive
  }
  const staging = await mkdtemp(join(cacheDirectory, '.download-'))
  try {
    const candidate = join(staging, 'archive.zip')
    await download(WINDOWS_SANDBOX_RUNTIME.url, candidate)
    await archiveHash(candidate)
    await rename(candidate, archive)
    return archive
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Read one regular executable from a bounded ZIP; no archive paths are extracted. */
export async function readSandboxExecutable(archive, member = WINDOWS_SANDBOX_RUNTIME.member) {
  if (!/^(?:x64|arm64)\/wxc-exec\.exe$/.test(member))
    throw new Error('Unsupported Microsoft sandbox ZIP member')
  const metadata = await lstat(archive)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > WINDOWS_SANDBOX_RUNTIME.bytes
  )
    throw new Error('Microsoft sandbox ZIP has an invalid type or size')
  const file = await open(archive, 'r')
  const invalid = () => {
    throw new Error('Invalid Microsoft sandbox ZIP')
  }
  const read = async (offset, size) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > metadata.size
    )
      invalid()
    const bytes = Buffer.alloc(size)
    let position = 0
    while (position < size) {
      const result = await file.read(bytes, position, size - position, offset + position)
      if (!result.bytesRead) invalid()
      position += result.bytesRead
    }
    return bytes
  }
  try {
    const tail = await read(Math.max(0, metadata.size - 65_557), Math.min(metadata.size, 65_557))
    let end = tail.length - 22
    for (; end >= 0; end--)
      if (
        tail.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length
      )
        break
    if (end < 0) invalid()
    const entries = tail.readUInt16LE(end + 10),
      size = tail.readUInt32LE(end + 12),
      offset = tail.readUInt32LE(end + 16)
    const endOffset = metadata.size - tail.length + end
    if (
      tail.readUInt16LE(end + 4) ||
      tail.readUInt16LE(end + 6) ||
      tail.readUInt16LE(end + 8) !== entries ||
      !entries ||
      entries > 1024 ||
      size > 1024 * 1024 ||
      offset + size !== endOffset
    )
      invalid()
    const directory = await read(offset, size)
    let selected,
      position = 0
    for (let index = 0; index < entries; index++) {
      if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50)
        invalid()
      const nameLength = directory.readUInt16LE(position + 28),
        extraLength = directory.readUInt16LE(position + 30),
        commentLength = directory.readUInt16LE(position + 32)
      const next = position + 46 + nameLength + extraLength + commentLength
      if (next > directory.length) invalid()
      const name = directory.subarray(position + 46, position + 46 + nameLength)
      const pathname = name.toString('utf8'),
        parts = pathname.replace(/\/$/, '').split('/')
      if (
        !Buffer.from(pathname).equals(name) ||
        /[\\:\x00-\x1f]/.test(pathname) ||
        parts.some(part => !part || part === '.' || part === '..')
      )
        invalid()
      if (name.equals(Buffer.from(member))) {
        if (selected || directory.readUInt16LE(position + 34)) invalid()
        const attributes = directory.readUInt32LE(position + 38),
          type = (attributes >>> 16) & 0xf000
        selected = {
          flags: directory.readUInt16LE(position + 8),
          method: directory.readUInt16LE(position + 10),
          crc: directory.readUInt32LE(position + 16),
          compressed: directory.readUInt32LE(position + 20),
          bytes: directory.readUInt32LE(position + 24),
          local: directory.readUInt32LE(position + 42)
        }
        if (
          selected.flags & ~0x800 ||
          ![0, 8].includes(selected.method) ||
          ![0, 0x8000].includes(type) ||
          attributes & 0x10 ||
          !selected.bytes ||
          selected.bytes > maxExecutableBytes ||
          selected.compressed > maxExecutableBytes
        )
          invalid()
      }
      position = next
    }
    if (!selected || position !== directory.length) invalid()
    const local = await read(selected.local, 30)
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(6) !== selected.flags ||
      local.readUInt16LE(8) !== selected.method ||
      local.readUInt32LE(14) !== selected.crc ||
      local.readUInt32LE(18) !== selected.compressed ||
      local.readUInt32LE(22) !== selected.bytes
    )
      invalid()
    const nameLength = local.readUInt16LE(26),
      extraLength = local.readUInt16LE(28)
    if (!(await read(selected.local + 30, nameLength)).equals(Buffer.from(member))) invalid()
    const dataOffset = selected.local + 30 + nameLength + extraLength
    if (dataOffset + selected.compressed > offset) invalid()
    const compressed = await read(dataOffset, selected.compressed)
    const bytes =
      selected.method === 8
        ? inflateRawSync(compressed, { maxOutputLength: maxExecutableBytes })
        : compressed
    if (bytes.length !== selected.bytes || crc32(bytes) !== selected.crc) invalid()
    return bytes
  } finally {
    await file.close()
  }
}

export async function verifyMicrosoftSandboxSignature(executable, run = execute) {
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  )
  const result = await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:HEXBOT_MXC_EXECUTABLE; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress"
    ],
    {
      env: { ...process.env, PSModulePath: undefined, HEXBOT_MXC_EXECUTABLE: executable },
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 30_000
    }
  )
  const signature = JSON.parse(result.stdout.trim())
  if (
    signature.status !== 'Valid' ||
    typeof signature.subject !== 'string' ||
    !/(?:^|,)\s*O=Microsoft Corporation(?:,|$)/.test(signature.subject)
  )
    throw new Error('Microsoft sandbox Authenticode signature is invalid')
}

export async function stageWindowsSandboxRuntime({
  destination,
  platform = 'win32',
  arch = 'x64',
  cacheDirectory = join(
    tmpdir(),
    'hexbot-build-cache',
    `microsoft-mxc-${WINDOWS_SANDBOX_RUNTIME.version}`
  ),
  download = downloadArchive,
  run = execute
} = {}) {
  if (platform !== 'win32' || arch !== 'x64')
    throw new Error(`Unsupported Microsoft sandbox target: ${platform}/${arch}`)
  if (!destination) throw new Error('A Microsoft sandbox staging directory is required')
  const archive = await pinnedArchive(cacheDirectory, download)
  const bytes = await readSandboxExecutable(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_SANDBOX_RUNTIME.executableSha256)
    throw new Error('Microsoft sandbox executable checksum mismatch')
  if (inspectPE(bytes, 'Microsoft sandbox executable').machine !== 0x8664)
    throw new Error('Microsoft sandbox executable is not x64')
  await mkdir(destination, { recursive: true })
  const staging = await mkdtemp(join(destination, '.mxc-'))
  try {
    const executable = join(staging, 'wxc-exec.exe')
    await writeFile(executable, bytes, { flag: 'wx', mode: 0o755 })
    if (process.platform === 'win32') await verifyMicrosoftSandboxSignature(executable, run)
    await mkdir(join(destination, 'licenses'), { recursive: true })
    await writeFile(join(destination, WINDOWS_SANDBOX_FILES[1]), MICROSOFT_MXC_LICENSE)
    await rename(executable, join(destination, WINDOWS_SANDBOX_FILES[0]))
    return [...WINDOWS_SANDBOX_FILES]
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
