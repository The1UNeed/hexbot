import { createHash } from 'node:crypto'
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { performBootstrap, runChild } from './bootstrap'
import { binDir, canonicalRuntimePath, hexbotHome, nativeServiceExecutable } from './paths'
vi.mock('../service', () => ({ migrateLegacyService: async () => undefined }))

describe.skipIf(process.platform !== 'win32' || !process.env.HEXBOT_NATIVE_TEST_BUNDLE)('real Windows Full bootstrap', () => {
  it('activates the same verified EXE Headless selects, without a stable EXE or symlink', async () => {
    const bundle = process.env.HEXBOT_NATIVE_TEST_BUNDLE!
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as { version: string; target: string; builtAt?: number }
    const root = await mkdtemp(join(tmpdir(), 'hexbot Windows Full '))
    const previous = { ...process.env }
    process.env.HEXBOT_CLI_NO_PATH = '1'
    const profile = join(root, 'José profile with spaces')
    const decoy = join(root, 'Git Bash HOME')
    await mkdir(profile)
    await mkdir(decoy)
    delete process.env.HEXBOT_HOME
    process.env.USERPROFILE = profile
    process.env.HOME = decoy
    const chosen = hexbotHome()
    expect(chosen).toBe(join(profile, '.hexbot'))
    const progress: string[] = []
    const events: unknown[] = []
    const output: string[] = []
    const secretValues = Object.entries(previous)
      .filter(([name, value]) => /token|secret|password|credential|api_?key/i.test(name) && value && value.length >= 8)
      .map(([, value]) => value!)
    const redact = (text: string): string => {
      for (const value of secretValues) text = text.replaceAll(value, '[redacted]')
      return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]')
    }
    const emit = (event: { stage: string; message: string }): void => {
      progress.push(event.stage)
      events.push({ stage: event.stage, message: redact(event.message).slice(-512) })
      if (events.length > 32) events.shift()
    }
    // Capture only this disposable test's child output. Production logging and
    // Pi stderr privacy are unchanged; failures still throw the original error.
    const run: typeof runChild = async (command, args, options = {}, onLine) => {
      events.push({ command, args: args.slice(0, 16).map(value => redact(value).slice(0, 1024)),
        home: options.env?.HEXBOT_HOME ?? chosen, cwd: options.cwd })
      if (events.length > 32) events.shift()
      await runChild(command, args, options, (line, stream) => {
        output.push(redact(line).slice(-1024))
        while (output.join('\n').length > 8192) output.shift()
        onLine?.(line, stream)
      })
    }
    try {
      // E: Full activation may already publish runtime/lock and Node logs.
      // Only this Python boundary's outside effects are asserted here.
      const phaseOutside = join(root, 'outside Python phase')
      await mkdir(phaseOutside)
      await writeFile(join(phaseOutside, 'sentinel'), 'outside unchanged')
      await mkdir(chosen, { recursive: true })
      await symlink(phaseOutside, join(chosen, 'python'), 'junction')
      await expect(performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })).rejects.toThrow()
      expect(progress).not.toContain('done')
      expect(await readdir(phaseOutside)).toEqual(['sentinel'])
      expect(await readFile(join(phaseOutside, 'sentinel'), 'utf8')).toBe('outside unchanged')
      expect(JSON.parse(await readFile(join(chosen, 'runtime/native-current.json'), 'utf8'))).toBeTruthy()
      await rm(join(chosen, 'python'))
      // Poison discovery/configuration without changing the selected owned paths.
      const decoyBin = join(root, 'poisoned PATH')
      await mkdir(decoyBin)
      await writeFile(join(decoyBin, 'python.exe'), 'foreign ordinary python')
      await writeFile(join(decoyBin, 'uv.exe'), 'foreign ordinary uv')
      const foreignPython = join(root, 'foreign Python')
      await mkdir(join(foreignPython, 'edge_tts'), { recursive: true })
      await writeFile(join(foreignPython, 'edge_tts/__init__.py'), 'raise RuntimeError("foreign package executed")')
      const config = join(root, 'poisoned uv.toml')
      await writeFile(config, 'invalid = [ TOML never accepted')
      await writeFile(join(chosen, 'runtime/uv.toml'), 'invalid = [ project config never accepted')
      Object.assign(process.env, { PATH: `${decoyBin};${previous.PATH ?? ''}`, UV_CONFIG_FILE: config,
        UV_CACHE_DIR: phaseOutside, UV_PYTHON_INSTALL_DIR: phaseOutside, UV_PYTHON_BIN_DIR: phaseOutside,
        UV_LINK_MODE: 'hardlink', UV_PYTHON_NO_REGISTRY: '0', PYTHONHOME: foreignPython,
        PYTHONPATH: foreignPython, VIRTUAL_ENV: foreignPython, AIOHTTP_NO_EXTENSIONS: '1',
        FROZENLIST_NO_EXTENSIONS: '1', MULTIDICT_NO_EXTENSIONS: '1', PROPCACHE_NO_EXTENSIONS: '1', YARL_NO_EXTENSIONS: '1' })
      await performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(progress.at(-1)).toBe('done')
      await expect(readFile(join(decoy, '.hexbot/runtime/native-current.json'))).rejects.toThrow()
      const exe = nativeServiceExecutable()
      expect(exe.endsWith('hexbot.exe')).toBe(true)
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      expect((await promisify(execFile)(exe, ['version'])).stdout.trim()).toBe(manifest.version)
      const python = join(chosen, 'runtime/tools/code-python/Scripts/python.exe')
      const voiceProbe = await promisify(execFile)(python, ['-I', '-c',
        'import aiohappyeyeballs, aiohttp, aiosignal, attrs, certifi, edge_tts, frozenlist, idna, multidict, propcache, tabulate, typing_extensions, yarl; from importlib.metadata import version; print(version("edge-tts"))'],
      { windowsHide: true, env: { ...process.env, HEXBOT_HOME: chosen } })
      expect(voiceProbe.stdout.trim()).toBe('7.2.7')
      await performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' })
      expect(nativeServiceExecutable()).toBe(exe)
      expect(await readdir(phaseOutside)).toEqual(['sentinel'])
      // Direct setup without --activate has no earlier runtime/log mutation.
      const directProfile = join(root, 'direct isolated profile')
      const directHome = join(directProfile, '.hexbot')
      await mkdir(directHome, { recursive: true })
      await symlink(phaseOutside, join(directHome, 'runtime'), 'junction')
      const directRefusal = await promisify(execFile)(exe, ['setup', '--json'], { windowsHide: true,
        env: { ...process.env, USERPROFILE: directProfile, HOME: directProfile, HEXBOT_HOME: directHome } }).then(() => undefined, error => error as { stdout?: string; stderr?: string })
      expect(directRefusal).toBeTruthy()
      const directDiagnostics = `${directRefusal?.stdout ?? ''}\n${directRefusal?.stderr ?? ''}`
      expect(directDiagnostics).toContain('Python code tools (preflight)')
      expect(directDiagnostics).not.toContain('"stage":"done"')
      expect(await readdir(phaseOutside)).toEqual(['sentinel'])
      await rm(join(directHome, 'runtime'))
      await proveProductionRepair(chosen, exe, async () => {
        progress.length = 0
        try { return await performBootstrap({ run, emit, appIsPackaged: true, appVersion: manifest.version, resourcesPath: dirname(bundle), platform: 'win32', arch: 'x64' }) }
        catch (error) { expect(progress).not.toContain('done'); throw error }
      })
      await expect(readFile(join(chosen, 'runtime/native-executable.exe'))).rejects.toThrow()
      const older = join(root, 'older runtime')
      await cp(bundle, older, { recursive: true })
      const metadata = JSON.parse(await readFile(join(older, 'manifest.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(older, 'manifest.json'), JSON.stringify({ ...metadata, builtAt: 1 }))
      const retained = await promisify(execFile)(join(older, 'hexbot.exe'), ['setup', '--activate', '--no-code-tools', '--json'], { env: { ...process.env, HEXBOT_HOME: chosen } })
      expect(retained.stdout).toContain('"stage":"done"')
      expect(nativeServiceExecutable()).toBe(exe)
      // Legacy uv capability diagnostics run last and never heal a fixture
      // before any production Python repair acceptance control.
      await provePinnedUvRepair(chosen, exe, redact)
    } catch (error) {
      const selected = await readFile(join(chosen, 'runtime/native-current.json'), 'utf8').then(JSON.parse).catch(() => undefined) as { executable?: string; builtAt?: number } | undefined
      const bootstrapTail = await readFile(join(chosen, 'logs/bootstrap.log'), 'utf8').then(text => redact(text.slice(-8192))).catch(() => undefined)
      console.error('Isolated Windows bootstrap failure:', JSON.stringify({
        home: chosen, manifest: { version: manifest.version, target: manifest.target, builtAt: manifest.builtAt },
        selection: selected && { executable: selected.executable, builtAt: selected.builtAt },
        events, outputTail: output.join('\n'), bootstrapTail
      }))
      throw error
    } finally {
      process.env = previous
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

// Capability evidence for the proposed repair commands, not a production
// repair implementation. Every mutation belongs to the fresh test home.
async function provePinnedUvRepair(home: string, daemon: string, redact: (text: string) => string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const environment = join(home, 'runtime/tools/code-python')
  const python = join(environment, 'Scripts/python.exe')
  // Rust setup installs pinned tools in <home>/bin with a version/hash receipt.
  expect(binDir()).toBe(join(home, 'bin'))
  const uv = join(binDir(), 'uv.exe')
  const receipt = JSON.parse(await readFile(join(binDir(), 'uv-version'), 'utf8')) as { version?: string; sha256?: string }
  expect(receipt.version).toBe('0.12.18')
  expect(receipt.sha256).toBe(createHash('sha256').update(await readFile(uv)).digest('hex'))
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(?:UV_|PYTHON|VIRTUAL_ENV$)/i.test(name)))
  Object.assign(env, { HEXBOT_HOME: home,
    UV_PYTHON_INSTALL_DIR: join(home, 'python'), UV_PYTHON_BIN_DIR: join(home, 'bin'),
    UV_CACHE_DIR: join(home, 'runtime/uv-cache'), UV_LINK_MODE: 'copy', UV_PYTHON_NO_REGISTRY: '1' })
  const run = async (program: string, args: string[]): Promise<string> => {
    const pending = promisify(execFile)(program, args, { cwd: home, env, windowsHide: true, timeout: 60_000, maxBuffer: 32768 })
    pending.child.stdin?.end()
    try { return (await pending).stdout.trim() }
    catch (error) {
      const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string }
      console.error('Pinned uv capability command failed:', JSON.stringify({ program, args, code: failure.code,
        message: redact(failure.message).slice(-1024), stdout: redact(failure.stdout ?? '').slice(-2048), stderr: redact(failure.stderr ?? '').slice(-2048) }))
      throw error
    }
  }
  expect(await run(uv, ['--version'])).toMatch(/^uv 0\.12\.18(?:\s|$)/)
  const script = 'import json,platform,sys; import aiohappyeyeballs,aiohttp,aiosignal,attrs,certifi,edge_tts,frozenlist,idna,multidict,propcache,tabulate,typing_extensions,yarl; from importlib.metadata import version; print(json.dumps({"patch":platform.python_version(),"implementation":platform.python_implementation(),"prefix":sys.prefix,"base":sys.base_prefix,"voice":version("edge-tts")}))'
  type Identity = { patch: string; implementation: string; prefix: string; base: string; voice: string }
  const identity = JSON.parse(await run(python, ['-I', '-c', script])) as Identity
  expect(identity.implementation).toBe('CPython')
  expect(identity.patch).toMatch(/^3\.11\.\d+$/)
  expect(identity.voice).toBe('7.2.7')
  expect(canonicalRuntimePath(identity.prefix)).toBe(canonicalRuntimePath(environment))
  const base = canonicalRuntimePath(identity.base)
  const location = relative(canonicalRuntimePath(join(home, 'python')), base)
  expect(location.length).toBeGreaterThan(0)
  expect(location.startsWith('..') || isAbsolute(location) || /[\/]/.test(location)).toBe(false)
  const key = `cpython-${identity.patch}-windows-x86_64-none`
  expect(location.toLowerCase()).toBe(key)
  const config = Object.fromEntries((await readFile(join(environment, 'pyvenv.cfg'), 'utf8'))
    .split(/\r?\n/).map(line => line.split(/\s*=\s*/, 2)).filter(([name, value]) => typeof name === 'string' && value !== undefined && ['home', 'implementation', 'uv', 'version_info'].includes(name)))
  console.log('Pinned uv owned capability input:', JSON.stringify({ patch: identity.patch, base, environment, config, key }))
  const check = async (stage: string): Promise<void> => {
    const current = JSON.parse(await run(python, ['-I', '-c', script])) as Identity
    expect({ patch: current.patch, implementation: current.implementation, voice: current.voice })
      .toEqual({ patch: identity.patch, implementation: identity.implementation, voice: identity.voice })
    expect(canonicalRuntimePath(current.prefix)).toBe(canonicalRuntimePath(environment))
    expect(canonicalRuntimePath(current.base)).toBe(base)
    expect(await run(join(environment, 'Scripts/edge-tts.exe'), ['--version'])).toMatch(/^edge-tts 7\.2\.7$/)
    console.log('Pinned uv owned capability passed:', JSON.stringify({ stage, patch: identity.patch, base, environment }))
  }
  await check('healthy')
  await writeFile(python, 'ordinary truncated redirector')
  expect((await lstat(python)).isFile()).toBe(true)
  await expect(run(python, ['-I', '-c', script])).rejects.toThrow()
  // The exact known base path, never global discovery or a broad minor selector.
  await run(uv, ['--no-config', 'venv', '--allow-existing', '--no-project', '--managed-python', '--python', join(base, 'python.exe'), environment])
  await check('truncated redirector restored with allow-existing')
  const dll = join(base, 'python311.dll')
  expect((await lstat(dll)).isFile()).toBe(true)
  await rm(dll)
  await run(uv, ['--no-config', 'python', 'install', '--no-bin', '--reinstall', key])
  expect((await lstat(dll)).isFile()).toBe(true)
  await check('same exact patch base DLL restored')
  await rm(join(environment, 'Lib/site-packages/edge_tts/communicate.py'))
  await rm(join(environment, 'Scripts/edge-tts.exe'))
  await expect(run(python, ['-I', '-c', script])).rejects.toThrow()
  const requirements = join(environment, 'requirements.txt')
  await run(uv, ['--no-config', 'pip', 'install', '--python', python, '--reinstall', '--require-hashes', '--no-deps', '--no-build', '-r', requirements])
  await check('required module and edge entrypoint restored with unchanged hashes')
  // The direct Headless setup surface stays on this same verified home/base.
  expect(await run(daemon, ['setup', '--json'])).toContain('"stage":"done"')
  await check('healthy direct setup')
}

// Production Full bootstrap repairs owned damage itself. The fixture only
// damages files and restores them after a refusal; uv is never run here.
async function proveProductionRepair(home: string, daemon: string, bootstrap: () => Promise<unknown>): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const environment = join(home, 'runtime/tools/code-python')
  const python = join(environment, 'Scripts/python.exe')
  const entry = join(environment, 'Scripts/edge-tts.exe')
  const tools = join(home, 'runtime/tools')
  const identity = JSON.parse(await readFile(join(tools, 'code-python-identity.json'), 'utf8')) as { schema: number; home: string; base_key: string; base_dll_sha256: string }
  expect(identity.schema).toBe(2)
  expect(canonicalRuntimePath(identity.home)).toBe(canonicalRuntimePath(home))
  expect(identity.base_key).toMatch(/^cpython-3\.11\.(?:0|[1-9]\d*)-windows-x86_64-none$/)
  const dll = join(home, 'python', identity.base_key, 'python311.dll')
  const basePython = join(home, 'python', identity.base_key, 'python.exe')
  expect(identity.base_dll_sha256).toBe(createHash('sha256').update(await readFile(dll)).digest('hex'))
  const communicate = join(environment, 'Lib/site-packages/edge_tts/communicate.py')
  const digest = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex')
  const originals = new Map<string, string>()
  for (const path of [python, entry, dll, basePython, communicate]) originals.set(path, await digest(path))
  const locked = await readFile(new URL('../../../../../backend/hexbot-core/assets/edge-tts.requirements.txt', import.meta.url), 'utf8')
  const versions = Object.fromEntries([...locked.matchAll(/^([\w-]+)==([^\s\\]+)/gm)].map(match => [match[1], match[2]]))
  expect(Object.keys(versions)).toHaveLength(13)
  const modules = ['aiohappyeyeballs', 'aiohttp', 'aiosignal', 'attrs', 'certifi', 'edge_tts', 'frozenlist', 'idna', 'multidict', 'propcache', 'tabulate', 'typing_extensions', 'yarl']
  const extensions = ['aiohttp._http_parser', 'aiohttp._http_writer', 'aiohttp._websocket.mask', 'aiohttp._websocket.reader_c', 'frozenlist._frozenlist', 'multidict._multidict', 'propcache._helpers_c', 'yarl._quoting_c']
  const identityBytes = await readFile(join(tools, 'code-python-identity.json'))
  const inspect = async (): Promise<{ versions: Record<string, string>; modules: Record<string, [string, string]>; extensions: Record<string, [string, string]> }> => {
    const script = 'import importlib,importlib.metadata,json,sys; names,modules,extensions=map(json.loads,sys.argv[1:]); origin=lambda name: (lambda m:[m.__spec__.origin,type(m.__spec__.loader).__name__])(importlib.import_module(name)); print(json.dumps({"versions":{name:importlib.metadata.version(name) for name in names},"modules":{name:origin(name) for name in modules},"extensions":{name:origin(name) for name in extensions}},ensure_ascii=True))'
    const result = await promisify(execFile)(python, ['-I', '-B', '-c', script, JSON.stringify(Object.keys(versions)), JSON.stringify(modules), JSON.stringify(extensions)], { windowsHide: true })
    expect([...result.stdout].every(character => character.charCodeAt(0) < 128)).toBe(true)
    return JSON.parse(result.stdout) as Awaited<ReturnType<typeof inspect>>
  }
  const initial = await inspect()
  for (const [origin] of [...Object.values(initial.modules), ...Object.values(initial.extensions)]) originals.set(origin, await digest(origin))
  const healthy = async (label: string): Promise<void> => {
    for (const [path, expected] of originals) expect(await digest(path), `${label}: ${path}`).toBe(expected)
    expect(await readFile(join(tools, 'code-python-identity.json')), label).toEqual(identityBytes)
    const result = await inspect()
    expect(result.versions, label).toEqual(versions)
    for (const name of modules) {
      const [origin, loader] = result.modules[name]!
      expect(loader, name).toBe('SourceFileLoader')
      const relativeOrigin = relative(await realpath(join(environment, 'Lib/site-packages')), await realpath(origin)).replaceAll('\\', '/')
      expect([`${name}/__init__.py`, `${name}.py`], name).toContain(relativeOrigin)
    }
    for (const name of extensions) {
      const [origin, loader] = result.extensions[name]!
      expect(loader, name).toBe('ExtensionFileLoader')
      const relativeOrigin = relative(await realpath(join(environment, 'Lib/site-packages')), await realpath(origin)).replaceAll('\\', '/')
      expect(relativeOrigin, name).toBe(`${name.replaceAll('.', '/')}.cp311-win_amd64.pyd`)
    }
  }
  const receipt = join(tools, 'edge-tts.requirements.txt')
  const unchanged = async (label: string, act: () => Promise<void>): Promise<void> => {
    const before = await Promise.all([receipt, join(tools, 'code-python-identity.json')].map(path => readFile(path)))
    await act()
    const after = await Promise.all([receipt, join(tools, 'code-python-identity.json')].map(path => readFile(path)))
    expect(after.map(buffer => buffer.toString('hex')), label).toEqual(before.map(buffer => buffer.toString('hex')))
  }
  // Node logs setup's JSON even on a healthy repeat. Verify the owned
  // Python files separately from those caller log appends.
  const stablePaths = [receipt, join(tools, 'code-python-identity.json'), join(environment, 'requirements.txt'), join(environment, 'pyvenv.cfg')]
  const { stat } = await import('node:fs/promises')
  const before = await Promise.all(stablePaths.map(async path => [await digest(path), (await stat(path)).mtimeMs]))
  await unchanged('healthy Full repeat', () => bootstrap().then(() => undefined))
  expect(await Promise.all(stablePaths.map(async path => [await digest(path), (await stat(path)).mtimeMs]))).toEqual(before)
  await healthy('healthy Full repeat')
  const edgeInit = join(environment, 'Lib/site-packages/edge_tts/__init__.py')
  const edgeInitBytes = await readFile(edgeInit)
  await writeFile(edgeInit, Buffer.concat([Buffer.from("import sys\nsys.stderr.write('owned healthy launcher diagnostics\\n')\n"), edgeInitBytes]))
  await unchanged('healthy Full launcher stderr refuses without done', () => expect(bootstrap()).rejects.toThrow())
  await writeFile(edgeInit, edgeInitBytes)
  await healthy('after healthy stderr refusal')
  // Direct explicit setup uses the selected real runtime, with no fixture uv
  // repair and no activation. It must report done only after production probes.
  const direct = async (): Promise<void> => {
    const result = await promisify(execFile)(daemon, ['setup', '--json'], {
      windowsHide: true, env: { ...process.env, HEXBOT_HOME: home, HEXBOT_CLI_NO_PATH: '1' }
    })
    expect(result.stdout).toContain('"stage":"done"')
  }
  await rm(basePython)
  await direct()
  await healthy('direct setup restores the missing base executable')
  await writeFile(python, Buffer.alloc(63, 'p'))
  await direct()
  await healthy('direct setup restores a 63-byte redirector')
  // Recorded damage repaired by Full bootstrap, same payload hashes.
  await writeFile(python, 'ordinary truncated redirector')
  await bootstrap()
  await healthy('Full restores a 29-byte redirector')
  await rm(dll)
  await bootstrap()
  await healthy('Full restores a missing base DLL')
  await rm(communicate)
  await rm(entry)
  await bootstrap()
  await healthy('Full restores a missing module and entrypoint')
  await rm(environment, { recursive: true, force: true })
  await bootstrap()
  await healthy('Full recreates the deleted environment')
  expect(JSON.parse(await readFile(join(tools, 'code-python-identity.json'), 'utf8'))).toEqual(identity)
  // Refusals: a long invalid redirector and an existing truncated DLL keep
  // their bytes, publish nothing new and fail the Full bootstrap.
  const saved = await readFile(python)
  await writeFile(python, Buffer.alloc(64, 'g'))
  await unchanged('64-byte redirector refusal', () => expect(bootstrap()).rejects.toThrow())
  await unchanged('direct setup refuses a 64-byte redirector', () => expect(direct()).rejects.toThrow())
  expect((await readFile(python)).toString('hex')).toBe(Buffer.alloc(64, 'g').toString('hex'))
  await writeFile(python, saved)
  const image = await readFile(dll)
  await writeFile(dll, image.subarray(0, image.length >> 1))
  await unchanged('truncated DLL refusal', () => expect(bootstrap()).rejects.toThrow())
  expect((await readFile(dll)).length).toBe(image.length >> 1)
  await writeFile(dll, image)
  await healthy('after refusals')
  // E retained-runtime phase: Node may append its own log before Rust refuses.
  const outside = join(home, 'outside retained boundary')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'outside unchanged')
  const cache = join(home, 'runtime/uv-cache')
  const parked = join(home, 'runtime/uv-cache-parked')
  await rename(cache, parked)
  await symlink(outside, cache, 'junction')
  await unchanged('Full retained-runtime cache escape refusal', () => expect(bootstrap()).rejects.toThrow())
  expect(await readdir(outside)).toEqual(['sentinel'])
  await rm(cache)
  await rename(parked, cache)
  const witness = join(outside, 'python witness')
  await link(python, witness)
  const witnessBefore = await digest(witness)
  await unchanged('Full shared redirector refusal', () => expect(bootstrap()).rejects.toThrow())
  expect(await digest(witness)).toBe(witnessBefore)
  await rm(witness)
  await healthy('after retained-runtime refusals')
  // Schema-1 fixture scope is unreleased; one healthy enrichment is allowed.
  await writeFile(join(tools, 'code-python-identity.json'), JSON.stringify({ schema: 1, home: identity.home, base_key: identity.base_key }))
  await bootstrap()
  expect(await readFile(join(tools, 'code-python-identity.json'))).toEqual(identityBytes)
  await healthy('healthy schema-1 enrichment')
  // Both actual production callers must repair module-only damage with the
  // launcher still present. Final checks use the ordinary launcher.
  await rm(communicate)
  await bootstrap()
  await healthy('Full restores module-only damage through launcher observer')
  await writeFile(communicate, 'def (:\n')
  await direct()
  await healthy('direct setup restores invalid owned source')
}
