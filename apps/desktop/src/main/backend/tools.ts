import pins from '../../../../../backend/hexbot-core/assets/code-tools.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Release archives installed into the app or dev home's bin directory.
// Checksums come from GitHub releases: astral-sh/uv, BurntSushi/ripgrep and sharkdp/fd.
export type Tool = 'uv' | 'rg' | 'fd'
const releases: Record<Tool, { version: string; url: string; name: string; targets: Record<string, string[]> }> = pins

// The archive holds `<directory>/<tool>`.
export function toolAsset(tool: Tool, platform: string, arch: string): { version: string; directory: string; url: string; sha256: string } {
  const release = releases[tool]
  const asset = release.targets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported code runtime platform: ${platform}/${arch}`)
  const [target, sha256] = asset as [string, string]
  const directory = `${release.name}${target}`
  return { version: release.version, directory, sha256, url: `${release.url}/${directory}.tar.gz` }
}

export interface ToolInstallDeps {
  binDirectory: string
  stagingDirectory: string
  platform: string
  arch: string
  exists: (path: string) => boolean
  download: typeof downloadTool
  run: (command: string, args: string[]) => Promise<unknown>
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
  const executable = join(deps.binDirectory, tool)
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
    const archive = join(staging, 'archive.tar.gz')
    const digest = await deps.download(asset.url, archive)
    if (digest !== asset.sha256) throw new Error(`${basename(asset.url)} checksum mismatch`)
    await deps.run('tar', ['-xzf', archive, '-C', staging, `${asset.directory}/${tool}`])
    const extracted = join(staging, asset.directory, tool)
    await chmod(extracted, 0o755)
    await rename(extracted, executable)
    await writeFile(receipt, JSON.stringify({ version: asset.version, sha256: await hash(executable) }))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return executable
}
