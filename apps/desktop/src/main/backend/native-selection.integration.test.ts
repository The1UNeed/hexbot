import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.5-nightly.20261022.59', on: vi.fn() }
}))
vi.mock('../service', () => ({ migrateLegacyService: async () => undefined }))
vi.mock('../updater', () => ({
  runRemoteUpdate: async () => ({ outcome: 'up-to-date', message: 'The app is already current.' })
}))

import { performBootstrap } from './bootstrap'
import { DaemonManager, findFreePort, runningDaemonPort } from './manager'
import { handleDaemonUpdateRequest } from '../remote-update'
import voiceRequirements from '../../../../../backend/hexbot-core/assets/edge-tts.requirements.txt?raw'

// Build the two real daemon binaries from a disposable source copy with these
// versions, and supply their paths. No production version or live home changes.
it.skipIf(!process.env.HEXBOT_TEST_RUNTIME_58 || !process.env.HEXBOT_TEST_RUNTIME_59)(
  'selects .59 through real Rust setup and waits for the real owned replacement',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hexbot-selection-live-'))
    const home = join(root, 'home')
    const previousHome = process.env.HEXBOT_HOME
    const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    process.env.HEXBOT_HOME = home
    const manager = new DaemonManager(await findFreePort())
    try {
      await mkdir(join(home, 'bin'), { recursive: true })
      await mkdir(join(home, 'runtime/tools'), { recursive: true })
      for (const file of ['python3.11', 'edge-tts'])
        await writeFile(join(home, 'bin', file), 'unused')
      await writeFile(join(home, 'runtime/tools/edge-tts.requirements.txt'), voiceRequirements)
      for (const run of ['58', '59']) {
        const source = join(root, run, 'hexbot-native')
        await mkdir(source, { recursive: true })
        await copyFile(
          process.env[run === '58' ? 'HEXBOT_TEST_RUNTIME_58' : 'HEXBOT_TEST_RUNTIME_59']!,
          join(source, 'hexbot-core')
        )
        await copyFile(process.execPath, join(source, 'node'))
        const contents: Record<string, string> = {
          hexbot:
            '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport HEXBOT_PI_EXECUTABLE="$root/pi/hexbot-pi"\nexec "$root/hexbot-core" "$@"\n',
          'pi/hexbot-pi': '#!/bin/sh\nprintf "1.0.1\\n"\n',
          'pi/package-lock.json': '{}',
          'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js':
            '// No agent turns in this fixture.'
        }
        for (const [file, text] of Object.entries(contents)) {
          await mkdir(dirname(join(source, file)), { recursive: true })
          await writeFile(join(source, file), text)
        }
        for (const file of ['hexbot', 'hexbot-core', 'node', 'pi/hexbot-pi'])
          await chmod(join(source, file), 0o755)
        const files: Record<string, string> = {}
        for (const file of [...Object.keys(contents), 'hexbot-core', 'node'])
          files[file] = createHash('sha256')
            .update(await readFile(join(source, file)))
            .digest('hex')
        // Exercise the existing macOS post-signing normalization boundary.
        if (process.platform === 'darwin') files['hexbot-core'] = '0'.repeat(64)
        await writeFile(
          join(source, 'manifest.json'),
          JSON.stringify({
            version: `0.1.5-nightly.20261022.${run}`,
            builtAt: 200,
            target: `${process.platform}-${process.arch}`,
            files
          })
        )
      }
      await manager.start(() =>
        performBootstrap({
          appIsPackaged: true,
          appVersion: '0.1.5-nightly.20261022.58',
          resourcesPath: join(root, '58')
        })
      )
      const old = manager.status()
      expect(old.state).toBe('running')
      const recordPath = join(home, 'runtime/native-current.json')
      const record = await readFile(recordPath, 'utf8')
      await writeFile(recordPath, JSON.stringify({ ...JSON.parse(record), version: 'invalid' }))
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: join(root, '59')
      })
      await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', manager)
      expect(manager.status().pid).toBe(old.pid)
      expect(
        JSON.parse(await readFile(join(home, 'runtime/update-status.json'), 'utf8')).status
      ).toBe('failed')
      await writeFile(recordPath, record)
      // Select .59 while the healthy owned .58 still runs from a different path.
      const prepared = await performBootstrap({
        appIsPackaged: true, appVersion: '0.1.5-nightly.20261022.59', resourcesPath: join(root, '59')
      })
      const damaged = prepared!.executable
      const hashes = await readFile(join(dirname(damaged), 'manifest.json'), 'utf8')
      for (const file of ['hexbot', 'hexbot-core']) await chmod(join(dirname(damaged), file), 0o644)
      expect(await readFile(join(dirname(damaged), 'manifest.json'), 'utf8')).toBe(hashes)
      await expect(manager.start(() => performBootstrap({
        appIsPackaged: true, appVersion: '0.1.5-nightly.20261022.58', resourcesPath: join(root, '58')
      }))).rejects.toThrow('identity cannot be verified')
      expect(manager.status().pid).toBe(old.pid)
      expect(await runningDaemonPort(home)).toBe(old.port)
      const alteredResources = join(root, 'altered59')
      const alteredSource = join(alteredResources, 'hexbot-native')
      await cp(join(root, '59/hexbot-native'), alteredSource, { recursive: true })
      const cli = 'pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
      await writeFile(join(alteredSource, cli), '// Different same-version Pi bytes')
      const alteredManifest = JSON.parse(await readFile(join(alteredSource, 'manifest.json'), 'utf8'))
      alteredManifest.files[cli] = createHash('sha256').update(await readFile(join(alteredSource, cli))).digest('hex')
      await writeFile(join(alteredSource, 'manifest.json'), JSON.stringify(alteredManifest))
      const damagedRecord = await readFile(recordPath, 'utf8')
      await expect(manager.start(() => performBootstrap({
        appIsPackaged: true, appVersion: '0.1.5-nightly.20261022.59', resourcesPath: alteredResources
      }))).rejects.toThrow('identity cannot be verified')
      expect(await readFile(recordPath, 'utf8')).toBe(damagedRecord)
      expect(manager.status().pid).toBe(old.pid)
      expect(await runningDaemonPort(home)).toBe(old.port)
      // Matching .59 source repairs into owned staging, without chmod of the old selection.
      await handleDaemonUpdateRequest('0.1.5-nightly.20261022.59', manager)
      const current = manager.status()
      expect(current.state).toBe('running')
      expect(current.pid).not.toBe(old.pid)
      expect(await realpath(join(home, 'runtime/native-executable'))).not.toBe(damaged)
      expect(await runningDaemonPort(home)).toBe(current.port)
      const selected = await realpath(join(home, 'runtime/native-executable'))
      expect((await promisify(execFile)(selected, ['version'])).stdout.trim()).toBe(
        '0.1.5-nightly.20261022.59'
      )
      expect(
        JSON.parse(await readFile(join(home, 'runtime/update-status.json'), 'utf8'))
      ).toMatchObject({ status: 'up-to-date', version: '0.1.5-nightly.20261022.59' })
      await handleDaemonUpdateRequest('0.1.5-nightly.20261022.60', manager)
      expect(manager.status().pid).toBe(current.pid)
      expect(
        JSON.parse(await readFile(join(home, 'runtime/update-status.json'), 'utf8')).status
      ).toBe('failed')
    } finally {
      await manager.stop()
      if (resources) Object.defineProperty(process, 'resourcesPath', resources)
      else delete (process as unknown as { resourcesPath?: string }).resourcesPath
      if (previousHome === undefined) delete process.env.HEXBOT_HOME
      else process.env.HEXBOT_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
