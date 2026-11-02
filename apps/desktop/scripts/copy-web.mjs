import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktopRoot, '../web/dist')
const destination = resolve(desktopRoot, 'out/renderer')

await rm(destination, { force: true, recursive: true })
await mkdir(dirname(destination), { recursive: true })
// The `.gz` files are for browsers the daemon serves; the app reads plain files.
await cp(source, destination, { filter: file => !file.endsWith('.gz'), recursive: true })
