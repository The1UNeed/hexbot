// Node's main-script loader needs ordinary absolute DOS/UNC spelling. Call
// this only after canonical resolution and any containment/identity checks;
// keep the canonical spelling for those checks, as the Rust Pi boundary does.
export function nodePath(path: string, platform = process.platform): string {
  if (platform !== 'win32') return path
  if (path.startsWith('\\\\?\\UNC\\')) path = `\\\\${path.slice(8)}`
  else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4)
  else if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\'))
    throw new Error('Unsupported Node device path')
  if (!/^[a-z]:[\\/]/i.test(path) && !/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(path))
    throw new Error('Node path must be absolute DOS or UNC')
  return path
}
