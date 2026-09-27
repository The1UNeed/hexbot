// What a build link downloads, read from its path on the update server:
// /<edition>/<os>/<arch>/<Hexbot|HexbotClient>-<version>-<os>-<file arch>.<format>.
// The file arch is the packager's word (x86_64, amd64); the directory's is ours.
// Stable and nightly builds share the layout. Null for any other link.
export type DownloadInfo = {
  edition: 'full' | 'client'
  os: 'mac' | 'linux'
  arch: 'arm64' | 'x64'
  format: string
  version: string
  channel: 'stable' | 'nightly'
}

export function describeDownload(href: string): DownloadInfo | null {
  const { pathname } = new URL(href, 'https://hexbot.app')
  const match = pathname.match(/^\/(full|client)\/(mac|linux)\/(arm64|x64)\/Hexbot(?:Client)?-(.+)-(?:mac|linux)-\w+\.(\w+)$/)
  if (!match) return null
  const [, edition, os, arch, version, format] = match
  return {
    edition: edition as DownloadInfo['edition'],
    os: os as DownloadInfo['os'],
    arch: arch as DownloadInfo['arch'],
    format,
    version,
    channel: version.includes('nightly') ? 'nightly' : 'stable',
  }
}
