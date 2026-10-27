// Production must remain unsupported, without concealing another compile error.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const message = 'The Hexbot daemon supports macOS and Linux only'
export function checkUnsupportedDiagnostics(result) {
  if (result.error || result.signal || result.status !== 101)
    throw new Error('Expected Cargo to fail with the production Windows support guard')
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const errors = events.filter(e => e.reason === 'compiler-message' && ['error', 'ice', 'failure-note'].includes(e.message.level))
  if (errors.length !== 1) throw new Error(`Expected only the support guard, got ${errors.length} compiler errors`)
  const diagnostic = errors[0]
  if (diagnostic.message.message !== message || diagnostic.message.code !== null ||
      diagnostic.target?.name !== 'hexbot_core' || !diagnostic.target.kind.includes('lib') ||
      !diagnostic.message.spans.some(span => span.is_primary && /(?:^|[\\/])src[\\/]lib.rs$/.test(span.file_name) &&
        span.text.some(line => line.text === `compile_error!("${message}");`)))
    throw new Error('Cargo failed with something other than the exact production support guard')
  // Cargo reports build-script and driver failures on stderr rather than as
  // compiler-message events. Do not mistake those for the expected guard.
  const cargoErrors = [...(result.stderr ?? '').matchAll(/^error(?:\[[^\]]+\])?: (.+)$/gm)]
  if (cargoErrors.some(([, text]) => !/^could not compile `hexbot-core` \(lib\) due to 1 previous error(?:; \d+ warnings? emitted)?$/.test(text)))
    throw new Error('Cargo reported an additional build failure')
  const finished = events.filter(e => e.reason === 'build-finished')
  if (finished.length !== 1 || finished[0].success !== false)
    throw new Error('Missing failed Cargo build completion')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('This check must run on native Windows')
  const source = process.argv[2]
  if (!source || !isAbsolute(source)) throw new Error('Expected an absolute production source directory')
  const lib = join(source, 'backend/hexbot-core/src/lib.rs')
  const before = readFileSync(lib)
  const result = spawnSync('cargo', ['check', '--locked', '--manifest-path', 'backend/hexbot-core/Cargo.toml', '--lib', '--bin', 'hexbot', '--message-format=json'], {
    cwd: source, env: { ...process.env, CARGO_TERM_COLOR: 'never' }, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  })
  process.stderr.write(result.stderr ?? '')
  for (const line of (result.stdout ?? '').trim().split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.reason === 'compiler-message') process.stderr.write(event.message.rendered ?? `${event.message.message}\n`)
    } catch { /* The strict parser below rejects non-JSON output. */ }
  }
  checkUnsupportedDiagnostics(result)
  if (!before.equals(readFileSync(lib))) throw new Error('Production support guard source changed')
  console.log('Production Windows check failed with only the unchanged support guard, as required')
}
