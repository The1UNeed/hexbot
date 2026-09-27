// Release checksums from https://github.com/astral-sh/uv/releases/tag/0.12.18.
export const UV_VERSION = '0.12.18'
const assets: Record<string, [string, string]> = {
  'darwin-arm64': ['aarch64-apple-darwin', 'cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b'],
  'darwin-x64': ['x86_64-apple-darwin', '2e4108f5395397c8bc5d43bf83d3bdbb2d0e92b90d0efa607756be704905fa33'],
  'linux-x64': ['x86_64-unknown-linux-musl', 'e38d97460b98ebfd31b197de0fe9fa578add4bc8ba0179b203dd3f87b99f98e6'],
  'linux-arm64': ['aarch64-unknown-linux-musl', '0796973fb3eea8095078c3d0659bd17a5f6789a71b8dd85caff2483178f78ac3']
}
export function uvAsset(platform: string, arch: string): { directory: string; url: string; sha256: string } {
  const asset = assets[`${platform}-${arch}`]
  if (!asset) throw new Error(`Unsupported code runtime platform: ${platform}/${arch}`)
  const [target, sha256] = asset
  const directory = `uv-${target}`
  return { directory, sha256, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${directory}.tar.gz` }
}
