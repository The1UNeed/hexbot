import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktopRoot, '../web/dist')
const destination = resolve(desktopRoot, 'out/renderer')

await rm(destination, { force: true, recursive: true })
await mkdir(dirname(destination), { recursive: true })
await cp(source, destination, { recursive: true })
