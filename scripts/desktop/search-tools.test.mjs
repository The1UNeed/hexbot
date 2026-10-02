import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { launchers } from './native-runtime.mjs'
import { prepareSearchTools } from './search-tools.mjs'

test('packaged Pi replaces stale managed downloads with shipped tools before loading Pi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pi-search-'))
  try {
    const agent = join(root, 'bot/pi')
    await mkdir(join(agent, 'bin'), { recursive: true })
    await mkdir(join(root, 'bin'))
    const outside = join(root, 'unrelated')
    await writeFile(outside, 'keep me')
    await symlink(outside, join(agent, 'bin/rg'))
    await writeFile(join(agent, 'bin/fd'), 'old unverified download')
    for (const tool of ['rg', 'fd']) await writeFile(join(root, 'bin', tool), `pinned ${tool}`)
    const cli = join(root, 'pi/node_modules/@earendil-works/pi-coding-agent/dist')
    await mkdir(cli, { recursive: true })
    const manager = new URL('../../backend/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js', import.meta.url)
    await writeFile(join(cli, 'cli.js'), `
      globalThis.fetch = () => { throw new Error('Pi must not download tools') };
      const { ensureTool } = await import(${JSON.stringify(manager.href)});
      const { readFile } = await import('node:fs/promises');
      for (const tool of ['rg', 'fd']) console.log(await readFile(await ensureTool(tool), 'utf8'));
    `)
    await cp(new URL('search-tools.mjs', import.meta.url), join(root, 'pi/search-tools.mjs'))
    await symlink(process.execPath, join(root, 'node'))
    const launcher = join(root, 'pi/hexbot-pi')
    await writeFile(launcher, launchers().pi)
    const result = await promisify(execFile)('sh', [launcher, '--mode', 'rpc'], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agent }
    })
    assert.equal(result.stdout.trim(), 'pinned rg\npinned fd')
    assert.equal(await readFile(outside, 'utf8'), 'keep me')
    // Matching copies stay in place: the same inode, untouched.
    const before = await Promise.all(['rg', 'fd'].map(tool => stat(join(agent, 'bin', tool))))
    await prepareSearchTools(join(root, 'bin'), agent)
    const after = await Promise.all(['rg', 'fd'].map(tool => stat(join(agent, 'bin', tool))))
    assert.deepEqual(after.map(item => [item.ino, item.mtimeMs]), before.map(item => [item.ino, item.mtimeMs]))
    await writeFile(join(agent, 'bin/rg'), 'tampered again')
    await prepareSearchTools(join(root, 'bin'), agent)
    assert.equal(await readFile(join(agent, 'bin/rg'), 'utf8'), 'pinned rg')
    assert.equal((await stat(join(agent, 'bin/rg'))).mode & 0o111, 0o111)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a copy that fails leaves Pi the verified tool on PATH instead of blocking the section',
  { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot-pi-search-failure-'))
  const path = process.env.PATH
  try {
    const agent = join(root, 'bot/pi')
    await mkdir(join(agent, 'bin'), { recursive: true })
    await mkdir(join(root, 'bin'))
    for (const tool of ['rg', 'fd']) await writeFile(join(root, 'bin', tool), `pinned ${tool}`)
    await chmod(join(agent, 'bin'), 0o555)
    const notes = []
    process.env.PATH = [join(root, 'bin'), path ?? ''].join(delimiter)
    await prepareSearchTools(join(root, 'bin'), agent, message => notes.push(message))
    assert.equal(notes.length, 2)
    assert.match(notes[0], /^search tools: rg not copied \(.+\); using the verified copy on PATH$/)
    // Without the verified tool on PATH, Pi would download its own: that is an error.
    process.env.PATH = path ?? ''
    await assert.rejects(prepareSearchTools(join(root, 'bin'), agent), /EACCES|EPERM/)
    // A stale copy Pi would prefer must go, so a copy it cannot remove is an error too.
    await chmod(join(agent, 'bin'), 0o755)
    await writeFile(join(agent, 'bin/rg'), 'old unverified download')
    await chmod(join(agent, 'bin'), 0o555)
    process.env.PATH = [join(root, 'bin'), path ?? ''].join(delimiter)
    await assert.rejects(prepareSearchTools(join(root, 'bin'), agent, () => undefined), /EACCES|EPERM/)
  } finally {
    process.env.PATH = path
    await chmod(join(root, 'bot/pi/bin'), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
