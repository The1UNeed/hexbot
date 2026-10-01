import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Release archives installed into the app or dev home's bin directory.
// Checksums come from GitHub releases: astral-sh/uv, BurntSushi/ripgrep and sharkdp/fd.
export type Tool = 'uv' | 'rg' | 'fd'
const releases: Record<Tool, { version: string; url: string; name: string; targets: Record<string, [string, string]> }> = {
  uv: {
    version: '0.12.18',
    url: 'https://github.com/astral-sh/uv/releases/download/0.12.18',
    name: 'uv-',
    targets: {
      'darwin-arm64': ['aarch64-apple-darwin', 'cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b'],
      'darwin-x64': ['x86_64-apple-darwin', '2e4108f5395397c8bc5d43bf83d3bdbb2d0e92b90d0efa607756be704905fa33'],
      'linux-x64': ['x86_64-unknown-linux-musl', 'e38d97460b98ebfd31b197de0fe9fa578add4bc8ba0179b203dd3f87b99f98e6'],
      'linux-arm64': ['aarch64-unknown-linux-musl', '0796973fb3eea8095078c3d0659bd17a5f6789a71b8dd85caff2483178f78ac3']
    }
  },
  rg: {
    version: '15.2.0',
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0',
    name: 'ripgrep-15.2.0-',
    targets: {
      'darwin-arm64': ['aarch64-apple-darwin', '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4'],
      'darwin-x64': ['x86_64-apple-darwin', 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1'],
      'linux-x64': ['x86_64-unknown-linux-musl', '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c'],
      'linux-arm64': ['aarch64-unknown-linux-musl', '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915']
    }
  },
  fd: {
    version: '10.5.0',
    url: 'https://github.com/sharkdp/fd/releases/download/v10.5.0',
    name: 'fd-v10.5.0-',
    targets: {
      'darwin-arm64': ['aarch64-apple-darwin', 'b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12'],
      'darwin-x64': ['x86_64-apple-darwin', '7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590'],
      'linux-x64': ['x86_64-unknown-linux-musl', '761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7'],
      'linux-arm64': ['aarch64-unknown-linux-musl', 'd76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4']
    }
  }
}

// The archive holds `<directory>/<tool>`.
export function toolAsset(tool: Tool, platform: string, arch: string): { version: string; directory: string; url: string; sha256: string } {
  const release = releases[tool]
  const asset = release.targets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported code runtime platform: ${platform}/${arch}`)
  const [target, sha256] = asset
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
