import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
const ps = process.env.HEXBOT_TEST_POWERSHELL ?? (process.platform === 'win32' ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : undefined)

test('actual service launch recreates logs and refuses foreign or linked log paths before execution', { skip: !ps }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hexbot-service-logs-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'serve'), "import{writeFileSync}from'node:fs';writeFileSync('called','launched');console.log('service stdout');console.error('service stderr');process.exit(17)")
  const selector = process.platform === 'win32' ? await readFile('backend/hexbot-core/assets/windows-runtime-selection.ps1', 'utf8') : `Add-Type 'public static class HexbotFinalPath { public static string Resolve(string path) { return System.IO.Path.GetFullPath(path); } }'`
  const source = await readFile('backend/hexbot-core/src/windows_service.rs', 'utf8')
  const command = source.match(/let command = if service \{\s*r#"([\s\S]*?)"#/)[1]
  const support = await readFile('backend/hexbot-core/assets/windows-service-logs.ps1', 'utf8')
  const quote = value => `'${value.replaceAll("'", "''")}'`
  const run = () => promisify(execFile)(ps, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';$env:HEXBOT_HOME=${quote(root)};${selector}\n${support}\nfunction Select-HexbotRuntime { ${quote(process.execPath)} };${command};exit $LASTEXITCODE`], { cwd: root, timeout: 30_000, windowsHide: true }).catch(error => error)
  for (const state of ['missing', 'removed-again', 'existing']) {
    const logs = join(root, 'logs')
    if (state !== 'existing') await rm(logs, { recursive: true, force: true })
    else await writeFile(join(logs, 'service.log'), 'existing bytes\n')
    const result = await run()
    assert.equal(result.code, 17, `${state}: ${result.stderr}`)
    assert.equal(await readFile(join(root, 'called'), 'utf8'), 'launched')
    assert.match(await readFile(join(logs, 'service.log'), 'utf8'), /service stdout/)
    assert.match(await readFile(join(logs, 'service-error.log'), 'utf8'), /service stderr/)
    if (state === 'existing') assert.match(await readFile(join(logs, 'service.log'), 'utf8'), /existing bytes/)
  }
  for (const state of ['logs-file', 'log-directory', 'logs-junction', ...(process.platform !== 'win32' ? ['unwritable-home', 'unwritable-log'] : [])]) {
    const logs = join(root, 'logs')
    await rm(logs, { recursive: true, force: true }); await rm(join(root, 'called'), { force: true })
    const outside = join(root, 'outside'); await mkdir(outside, { recursive: true })
    if (state === 'logs-file') await writeFile(logs, 'foreign bytes')
    if (state === 'log-directory') await mkdir(join(logs, 'service.log'), { recursive: true })
    if (state === 'logs-junction') await symlink(outside, logs, process.platform === 'win32' ? 'junction' : 'dir')
    if (state === 'unwritable-log') { await mkdir(logs); await writeFile(join(logs, 'service.log'), 'kept'); await chmod(join(logs, 'service.log'), 0o400) }
    if (state === 'unwritable-home') await chmod(root, 0o500)
    try {
      const result = await run()
      assert.notEqual(result.code, 0, `${state} unexpectedly succeeded`)
      await assert.rejects(readFile(join(root, 'called')), { code: 'ENOENT' })
      if (state === 'logs-file') assert.equal(await readFile(logs, 'utf8'), 'foreign bytes')
      if (state === 'logs-junction') await assert.rejects(readFile(join(outside, 'service.log')), { code: 'ENOENT' })
    } finally { await chmod(root, 0o700) }
  }
})
