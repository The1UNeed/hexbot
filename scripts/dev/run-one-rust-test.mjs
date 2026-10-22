import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function requireOneRustTest(output) {
  assert.match(output, /^running 1 test\r?$/m, 'Expected exactly one selected native test')
  assert.match(output, /^test result: ok\. 1 passed; 0 failed; 0 ignored;/m, 'Native test did not execute and pass exactly once')
}

async function main() {
  const [manifest, target, name, ...extra] = process.argv.slice(2)
  assert(manifest && /^[\w-]+$/.test(target ?? '') && /^[\w:]+$/.test(name ?? '') && !extra.length,
    'Usage: run-one-rust-test.mjs <Cargo.toml> <integration target> <exact ignored test>')
  const child = spawn('cargo', ['test', '--locked', '--manifest-path', manifest, '--test', target, name, '--', '--exact', '--ignored', '--nocapture'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
