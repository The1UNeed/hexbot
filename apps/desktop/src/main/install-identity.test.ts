import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseInstallIdentity, readInstallIdentity } from './install-identity'

const marker = (id: string) => Buffer.from(`[installation]\r\nappId=${id}\r\n`)
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Windows install identity', () => {
  it('preserves each initial identity when its installed payload switches tracks in either edition', () => {
    for (const edition of ['desktop', 'client']) {
      const stable = `app.hexbot.${edition}`, nightly = `${stable}.nightly`
      expect(parseInstallIdentity(marker(stable), nightly)).toBe(stable)
      expect(parseInstallIdentity(marker(nightly), stable)).toBe(nightly)
      expect(parseInstallIdentity(marker(stable), stable)).toBe(stable)
    }
  })

  it('reads UTF-16 Windows INI files without depending on the user code page', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[installation]\r\nappId=app.hexbot.client.nightly\r\n', 'utf16le')])
    expect(parseInstallIdentity(utf16, 'app.hexbot.client')).toBe('app.hexbot.client.nightly')
  })

  it('rejects another edition, Dev changes, unknown ids and ambiguous markers', () => {
    for (const id of ['app.hexbot.client', 'app.hexbot.desktop.dev', '../other', 'app.hexbot.desktop.unknown'])
      expect(() => parseInstallIdentity(marker(id), 'app.hexbot.desktop')).toThrow()
    expect(() => parseInstallIdentity(marker('app.hexbot.desktop'), 'app.hexbot.desktop.dev')).toThrow()
    expect(parseInstallIdentity(marker('app.hexbot.desktop.dev'), 'app.hexbot.desktop.dev')).toBe('app.hexbot.desktop.dev')
    for (const text of ['[installation]\nappId=app.hexbot.desktop\nappId=app.hexbot.client', '[other]\nappId=app.hexbot.desktop', '[installation]\nappId=app.hexbot.desktop\n[other]'])
      expect(() => parseInstallIdentity(Buffer.from(text), 'app.hexbot.desktop')).toThrow()
  })

  it('uses the marker beside the executable and only falls back when it is absent', async () => {
    const path = await mkdtemp(join(tmpdir(), 'hexbot install identity ')); temporary.push(path)
    const executable = join(path, 'Hexbot.exe')
    expect(await readInstallIdentity(executable, 'app.hexbot.desktop.nightly')).toBe('app.hexbot.desktop.nightly')
    await writeFile(join(path, 'hexbot-install.ini'), marker('app.hexbot.desktop'))
    expect(await readInstallIdentity(executable, 'app.hexbot.desktop.nightly')).toBe('app.hexbot.desktop')
    await writeFile(join(path, 'hexbot-install.ini'), 'corrupt')
    await expect(readInstallIdentity(executable, 'app.hexbot.desktop')).rejects.toThrow(/identify/)
  })
})
