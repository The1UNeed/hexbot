import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { performBootstrap, type BootstrapDeps } from './bootstrap'
import ties from '../../../../../backend/hexbot-core/assets/native-setup-ties.json'

const files = ['hexbot.exe', 'hexbot-cli.exe', 'node.exe', 'pi/launch.mjs', 'pi/search-tools.mjs', 'bin/rg.exe', 'bin/fd.exe', 'web/index.html', 'pi/package-lock.json', 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js']
it('Windows packaged setup shares the canonical Nightly tie decisions with Rust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-setup-order-'))
  const previous = process.env.HEXBOT_HOME
  try {
    for (const [index, row] of ties.entries()) {
      const home = join(root, String(index)); process.env.HEXBOT_HOME = home
      const bundle = async (directory: string, version: string, builtAt = 100) => {
        const hashes: Record<string, string> = {}
        for (const file of files) {
          await mkdir(dirname(join(directory, file)), { recursive: true })
          const bytes = `${version}/${file}`
          await writeFile(join(directory, file), bytes)
          hashes[file] = createHash('sha256').update(bytes).digest('hex')
        }
        const manifest = { version, builtAt, target: 'win32-x64', files: hashes }
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
        return { ...manifest, executable: await realpath(join(directory, 'hexbot.exe')) }
      }
      const selected = await bundle(join(home, 'runtime/native/selected'), row.selected)
      await bundle(join(home, 'resources/hexbot-native'), row.candidate)
      const record = join(home, 'runtime/native-current.json')
      await writeFile(record, JSON.stringify(selected))
      const calls: Array<{ command: string; args: string[] }> = []
      const run: BootstrapDeps['run'] = async (command, args) => {
        if (args[0] !== 'setup') return
        calls.push({ command, args })
        if (args.includes('--activate')) {
          // This stub records only selection intent. Rust's real locked publisher
          // separately covers filesystem verification, races and durable floors.
          const installed = await bundle(join(home, 'runtime/native/new'), row.candidate)
          await writeFile(record, JSON.stringify(installed))
        }
      }
      const activation = await performBootstrap({ appIsPackaged: true, appVersion: row.candidate, resourcesPath: join(home, 'resources'), platform: 'win32', arch: 'x64', run, emit: () => {} })
      expect(calls, row.name).toEqual([{ command: row.advance ? join(home, 'resources/hexbot-native/hexbot.exe') : selected.executable, args: ['setup', ...(row.advance ? ['--activate'] : []), '--json'] }])
      expect(activation?.executable).toBe(JSON.parse(await readFile(record, 'utf8')).executable)
    }
  } finally {
    if (previous === undefined) delete process.env.HEXBOT_HOME; else process.env.HEXBOT_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
