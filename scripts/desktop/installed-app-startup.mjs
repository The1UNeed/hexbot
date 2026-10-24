// Installed-app test harness only. One initial Full start, one shared deadline.
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export async function startInstalledRuntime(edition, start, ready, timeout = 300_000) {
  if (edition !== 'full') return
  const controller = new AbortController()
  const { signal } = controller
  let rejectDeadline
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject
  })
  const error = new Error(`Installed Full startup did not complete within ${timeout} ms`)
  const timer = setTimeout(() => {
    controller.abort(error)
    rejectDeadline(error)
  }, timeout)
  // Promise.race observes late rejection too. A late start cannot create a new
  // watcher after cancellation, and readiness cannot reset the overall budget.
  const startup = Promise.resolve()
    .then(start)
    .then(() => {
      signal.throwIfAborted()
      return ready(signal)
    })
  try {
    return await Promise.race([startup, deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export function startupRedactor(environment = process.env) {
  const secrets = Object.entries(environment)
    .filter(
      ([name, value]) =>
        /token|secret|password|credential|api_?key|pairing_?code/i.test(name) && value?.length >= 4
    )
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length)
  return text => {
    for (const value of secrets) text = text.replaceAll(value, '[redacted]')
    return text
      .replace(/\b(?:https?|wss?|hexbot):\/\/[^\s"'<>]+/gi, input => {
        try {
          const url = new URL(input)
          if (url.username || url.password) {
            url.username = '[redacted]'
            url.password = ''
          }
          for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]')
          if (url.hash) url.hash = '[redacted]'
          return url.href
        } catch {
          return '[redacted URL]'
        }
      })
      .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]')
      .replace(
        /((?:pairing|sign[ -]?in|login|one[ -]?time)[ _-]*(?:code|token)\s*[:=]\s*)[^\s"']+/gi,
        '$1[redacted]'
      )
      .replace(
        /\b((?:(?:access|refresh|device|session)[_-]?)?token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s"'&,]+/gi,
        '$1$2[redacted]'
      )
      .replace(
        /("[^"\n]*(?:token|password|secret|pairing[_-]?code|api[_-]?key)[^"\n]*"\s*:\s*)"[^"\n]*"/gi,
        '$1"[redacted]"'
      )
  }
}

export function formatStartupDiagnostic(value, redact) {
  return JSON.stringify(value, (key, field) => {
    if (/token|secret|password|credential|api[_-]?key|pairing[_-]?code/i.test(key))
      return '[redacted]'
    return typeof field === 'string' ? redact(field) : field
  })
}

export function captureInstalledApp(child, redact) {
  const output = { stdout: '', stderr: '' }
  const truncated = { stdout: false, stderr: false }
  const listeners = Object.keys(output).map(name => {
    const stream = child[name]
    const listener = bytes => {
      const text = output[name] + bytes.toString()
      truncated[name] ||= text.length > 16384
      output[name] = text.slice(-16384)
    }
    stream?.on('data', listener)
    return () => stream?.off('data', listener)
  })
  return {
    snapshot: () =>
      Object.fromEntries(
        Object.entries(output).map(([name, text]) => {
          // Drop a truncated first line rather than exposing half a credential.
          if (truncated[name]) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''
          return [name, redact(text).slice(-8192)]
        })
      ),
    dispose: () => listeners.forEach(remove => remove())
  }
}

// Fixed allowlist, bounded reads, no configuration/auth files. Resolve each
// file inside its owned root before opening; missing files are useful evidence.
export async function installedStartupFiles(home, bundle) {
  const read = async (root, name, fields) => {
    let file
    try {
      const base = await realpath(root)
      const path = await realpath(join(root, name))
      const local = relative(base, path)
      if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw new Error('Diagnostic file escaped its owned directory')
      file = await open(path, 'r')
      const info = await file.stat()
      if (!info.isFile() || (fields && info.size > 65536))
        throw new Error('Diagnostic file is not a bounded regular file')
      const bytes = Buffer.alloc(Math.min(info.size, fields ? 65536 : 8192))
      const offset = fields ? 0 : Math.max(0, info.size - bytes.length)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
      let text = bytes.subarray(0, bytesRead).toString()
      if (!fields)
        return offset ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text
      const value = JSON.parse(text)
      return Object.fromEntries(
        fields
          .filter(key => Object.hasOwn(value, key))
          .map(key => {
            const field = value[key]
            if (key === 'files')
              return [
                key,
                Object.fromEntries(
                  [
                    'hexbot.exe',
                    'hexbot-cli.exe',
                    'node.exe',
                    'pi/launch.mjs',
                    'pi/search-tools.mjs',
                    'web/index.html'
                  ].map(name => [
                    name,
                    /^[a-f0-9]{64}$/.test(field?.[name])
                      ? field[name]
                      : '[missing or invalid digest]'
                  ])
                )
              ]
            return [
              key,
              typeof field === 'string'
                ? field.slice(0, 1024)
                : typeof field === 'number' && Number.isFinite(field)
                  ? field
                  : '[invalid field]'
            ]
          })
      )
    } catch (error) {
      return { error: error.code ?? error.message }
    } finally {
      await file?.close()
    }
  }
  return {
    bootstrap: await read(home, 'logs/bootstrap.log'),
    daemon: await read(home, 'logs/daemon.log'),
    desktop: await read(home, 'logs/desktop.log'),
    manifest: await read(bundle, 'manifest.json', [
      'version',
      'target',
      'builtAt',
      'piVersion',
      'nodeVersion',
      'files'
    ]),
    selection: await read(home, 'runtime/native-current.json', [
      'version',
      'executable',
      'builtAt'
    ]),
    running: await read(home, 'runtime/native-running.json', ['pid', 'executable']),
    state: await read(home, 'serve-state.json', ['port'])
  }
}
