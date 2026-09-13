import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

// Versions 0.1.3 and 0.1.4 shipped client packages that believed they were
// the full package: the edition was read from import.meta.env, which the
// main-process build never replaces. Build the main process for real and
// check the value is baked in.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const electronVite = join(desktopRoot, 'node_modules/.bin/electron-vite')
const outputs: string[] = []

async function buildMain(edition: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), `hexbot-${edition}-`))
  outputs.push(outDir)
  await promisify(execFile)(electronVite, ['build', '--outDir', outDir], {
    cwd: desktopRoot,
    env: { ...process.env, HEXBOT_EDITION: edition }
  })
  return readFile(join(outDir, 'main/index.js'), 'utf8')
}

afterAll(() => Promise.all(outputs.map(dir => rm(dir, { force: true, recursive: true }))))

describe('edition build', () => {
  it('bakes HEXBOT_EDITION into the main bundle', async () => {
    const bundle = await buildMain('client')
    expect(bundle).not.toContain('__HEXBOT_EDITION__')
    expect(bundle).toContain('const edition = "client"')
  }, 120_000)
})
