import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export function requireOneRustTest(output) {
  assert.match(output, /^running 1 test\r?$/m, 'Expected exactly one selected native test')
  assert.match(output, /^test result: ok\. 1 passed; 0 failed; 0 ignored;/m, 'Native test did not execute and pass exactly once')
}

export function nativeTestEnvironment(environment = process.env, executable = process.execPath) {
  const env = { ...environment }
  if (env.HEXBOT_WINDOWS_GUI_PROBE) {
    assert(isAbsolute(executable), 'GUI Node must be an absolute executable path')
    const node = realpathSync(executable)
    assert(statSync(node).isFile(), 'GUI Node must be a regular file')
    assert(isAbsolute(env.HEXBOT_WINDOWS_GUI_PROBE), 'GUI probe must be an absolute source path')
    const probe = realpathSync(env.HEXBOT_WINDOWS_GUI_PROBE)
    assert(statSync(probe).isFile(), 'GUI probe must be a regular file')
    // Use the already-running trusted CI Node as one executable. Do not
    // reconstruct a program path from command-discovery output.
    env.HEXBOT_WINDOWS_GUI_NODE = node
    env.HEXBOT_WINDOWS_GUI_PROBE = probe
  }
  return env
}

async function main() {
  const [manifest, target, name, ...extra] = process.argv.slice(2)
  assert(manifest && /^[\w-]+$/.test(target ?? '') && /^[\w:]+$/.test(name ?? '') && !extra.length,
    'Usage: run-one-rust-test.mjs <Cargo.toml> <integration target> <exact ignored test>')
  const env = nativeTestEnvironment()
  if (env.HEXBOT_WINDOWS_GUI_PROBE) console.log('Native GUI harness:', JSON.stringify({
    source: 'running Node process.execPath', type: typeof env.HEXBOT_WINDOWS_GUI_NODE,
    program: env.HEXBOT_WINDOWS_GUI_NODE.slice(0, 1024), nodeVersion: process.version,
    probe: env.HEXBOT_WINDOWS_GUI_PROBE.slice(0, 1024)
  }))
  const child = spawn('cargo', ['test', '--locked', '--manifest-path', manifest, '--test', target, name, '--', '--exact', '--ignored', '--nocapture'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8')
    stream.on('data', text => { destination.write(text); output += text })
  }
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 0, 'Native cargo test failed')
  requireOneRustTest(output)
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main()
