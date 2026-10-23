import pins from '../../../../../backend/hexbot-core/assets/code-tools.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Release archives installed into the app or dev home's bin directory.
// Checksums come from GitHub releases: astral-sh/uv, BurntSushi/ripgrep and sharkdp/fd.
export type Tool = 'uv' | 'rg' | 'fd'
const releases: Record<Tool, { version: string; url: string; name: string; targets: Record<string, string[]> }> = pins

// The archive holds `<directory>/<tool>`.
export function toolAsset(tool: Tool, platform: string, arch: string): { version: string; directory: string; url: string; sha256: string; member: string; format: string } {
  if (!Object.hasOwn(releases, tool)) throw new Error('Unknown code runtime tool')
  const release = releases[tool]
  const asset = release.targets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported code runtime platform: ${platform}/${arch}`)
  const [target, sha256] = asset as [string, string]
  const directory = `${release.name}${target}`
  const windows = platform === 'win32'
  const format = windows ? 'zip' : 'tar.gz'
  const member = windows && tool === 'uv' ? 'uv.exe' : `${directory}/${tool}${windows ? '.exe' : ''}`
  return { version: release.version, directory, sha256, member, format, url: `${release.url}/${directory}.${format}` }
}

export interface ToolInstallDeps {
  binDirectory: string
  stagingDirectory: string
  platform: string
  arch: string
  exists: (path: string) => boolean
  download: typeof downloadTool
  run: (command: string, args: string[], options?: { cwd?: string; windowsHide?: boolean }) => Promise<unknown>
}

export async function archiveProgram(): Promise<string> {
  if (process.platform !== 'win32') return 'tar'
  if (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error('Windows SystemRoot must be absolute')
  const program = join(process.env.SystemRoot, 'System32/tar.exe')
  const file = await lstat(program)
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Windows tar must be an ordinary system executable')
  return program
}

export async function extractWindowsArchive(directory: string, filename: string, member: string, run: ToolInstallDeps['run']): Promise<void> {
  // bsdtar can narrow Unicode argv. CreateProcess carries cwd separately, so
  // only ASCII relative operands cross the archive tool's argument boundary.
  if (!/^[\x20-\x7e]+$/.test(filename) || basename(filename) !== filename || filename === '.' || filename === '..' ||
      !/^[\x20-\x7e]+$/.test(member) || member.startsWith('-') || member.includes('\\') || member.includes(':') || member.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error('Invalid Windows archive member or filename')
  await run(await archiveProgram(), ['-xf', filename, '-C', '.', member], { cwd: directory, windowsHide: true })
}

export async function downloadTool(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${url}`)
  await mkdir(dirname(dest), { recursive: true })
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const hash = createHash('sha256')
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      hash.update(chunk)
      if (total) onProgress?.(Math.round((received / total) * 100))
      controller.enqueue(chunk)
    }
  })
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(stream) as never),
    createWriteStream(dest)
  )
  return hash.digest('hex')
}

export async function installTool(tool: Tool, deps: ToolInstallDeps, onInstall?: () => void): Promise<string> {
  const asset = toolAsset(tool, deps.platform, deps.arch)
  const executable = join(deps.binDirectory, `${tool}${deps.platform === 'win32' ? '.exe' : ''}`)
  const receipt = join(deps.binDirectory, `${tool}-version`)
  const hash = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex')
  const recorded = await readFile(receipt, 'utf8').then(JSON.parse).catch(() => undefined) as { version?: string; sha256?: string } | undefined
  if (deps.exists(executable) && recorded?.version === asset.version &&
      recorded.sha256 === await hash(executable)) return executable
  onInstall?.()
  await mkdir(deps.binDirectory, { recursive: true })
  await mkdir(deps.stagingDirectory, { recursive: true })
  const staging = await mkdtemp(join(deps.stagingDirectory, `.${tool}-`))
  try {
    const archive = join(staging, `archive.${asset.format}`)
    const digest = await deps.download(asset.url, archive)
    if (digest !== asset.sha256) throw new Error(`${basename(asset.url)} checksum mismatch`)
    if (deps.platform === 'win32') await extractWindowsArchive(staging, basename(archive), asset.member, deps.run)
    else await deps.run('tar', ['-xzf', archive, '-C', staging, asset.member])
    const extracted = join(staging, asset.member)
    if (deps.platform !== 'win32') await chmod(extracted, 0o755)
    await rename(extracted, executable)
    await writeFile(receipt, JSON.stringify({ version: asset.version, sha256: await hash(executable) }))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return executable
}
