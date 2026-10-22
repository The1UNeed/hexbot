// Windows accepts PNG-compressed ICO entries. Keep the existing installer art.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export function installerIco(png) {
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256)
    throw new Error('Expected the existing 256 x 256 installer PNG')
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2) // ICO
  header.writeUInt16LE(1, 4) // one 256 x 256 image, width/height encoded as zero
  header.writeUInt16LE(1, 10) // planes
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(header.length, 18)
  return Buffer.concat([header, png])
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const icons = new URL('../../apps/installer/src-tauri/icons/', import.meta.url)
  await writeFile(new URL('icon.ico', icons), installerIco(await readFile(new URL('128x128@2x.png', icons))))
}
