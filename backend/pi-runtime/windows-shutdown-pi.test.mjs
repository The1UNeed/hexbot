import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import test from 'node:test';

function event(child, predicate) {
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => { cleanup(); reject(new Error(`Fixture exited before event: ${code}/${signal}`)); };
    const onMessage = message => { if (message?.type === 'fixture-event' && predicate(message.value)) { cleanup(); resolve(message.value); } };
    const cleanup = () => { child.off('exit', onExit); child.off('message', onMessage); };
    child.on('message', onMessage); child.once('exit', onExit);
  });
}

for (const earlyExit of [false, true]) test(earlyExit ? 'a descendant that exits before real Pi startup cannot produce readiness' : 'shutdown fixture binds real Pi readiness to a fresh run and live descendant', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot shutdown fixture '));
  let child, descendant, monitor, tracked;
  try {
    const dir = join(root, 'command'); await mkdir(dir);
    const launcher = new URL('./node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url).href;
    const module = new URL('./fixtures/windows-shutdown-pi.mjs', import.meta.url).href;
    monitor = createServer(socket => { let input = ''; socket.on('data', async bytes => {
      input += bytes; assert(input.length <= 4096); if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      tracked = JSON.parse(input);
      assert.equal(tracked.nonce, 'fresh-run');
      process.kill(tracked.pid, 0); process.kill(tracked.child, 0);
      if (earlyExit) {
        const ended = event(child, value => value.event === 'descendant-exit');
        process.kill(tracked.child); await ended;
      }
      socket.end('tracked\n');
    }); });
    await new Promise(resolve => monitor.listen(0, '127.0.0.1', resolve));
    const file = join(root, 'launch.mjs');
    await writeFile(file, `import {runShutdownFixture} from ${JSON.stringify(module)};await runShutdownFixture(${JSON.stringify({ directory: dir, mode: 'command', nonce: 'fresh-run', launcher, monitor: monitor.address().port })});`);
    const agent = join(root, 'agent'); await mkdir(agent);
    child = spawn(process.execPath, [file, '--mode', 'rpc', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates'], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    const exited = once(child, 'exit');
    let output = ''; child.stdout.on('data', bytes => { output += bytes; });
    let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2048); });
    const start = await event(child, value => value.event === 'descendant-ready');
    descendant = start.child;
    const ready = earlyExit ? undefined : event(child, value => value.event === 'ready');
    child.stdin.write(JSON.stringify({ id: 'fixture-state', type: 'get_state' }) + '\n');
    if (earlyExit) {
      const [code, signal] = await exited;
      assert.notEqual(code, 0, diagnostic); assert.equal(signal, null);
      await assert.rejects(readFile(join(dir, 'ready.json')), { code: 'ENOENT' });
      const records = (await readFile(join(dir, `pi-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
      assert(records.some(record => record.event === 'descendant-exit'));
      assert(!records.some(record => record.event === 'ready'));
      return;
    }
    const value = await ready;
    assert.equal(tracked.pid, child.pid);
    assert.equal(tracked.child, descendant);
    assert.equal(value.pid, child.pid);
    assert.equal(value.ppid, process.pid);
    assert.equal(value.child, descendant);
    assert.equal(value.nonce, 'fresh-run');
    assert.equal(value.mode, 'command');
    process.kill(child.pid, 0); process.kill(descendant, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'ready.json'), 'utf8')), {
      mode: 'command', nonce: 'fresh-run', pid: child.pid, ppid: process.pid, child: descendant
    });
    child.stdin.end();
    assert.deepEqual(await exited, [0, null], diagnostic);
    const childRecords = (await readFile(join(dir, `descendant-${descendant}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(childRecords[0].event, 'ready');
    const records = (await readFile(join(dir, `pi-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(record => record.event === 'pi-state-response' && record.success).length, 1);
    assert.equal(records.at(-1).event, 'exit');
    assert.equal(records.at(-1).code, 0);
    const responses = output.trim().split('\n').map(line => JSON.parse(line)).filter(v => v.id === 'fixture-state');
    assert.equal(responses.length, 1); assert.equal(responses[0].success, true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    if (descendant) { try { process.kill(descendant); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (monitor) await new Promise(resolve => monitor.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale readiness file fails before a descendant or real Pi starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hexbot stale readiness '));
  try {
    const file = join(root, 'ready.json'); await writeFile(file, '{"nonce":"old-run","pid":1}');
    const { runShutdownFixture } = await import('./fixtures/windows-shutdown-pi.mjs');
    await assert.rejects(runShutdownFixture({ directory: root, mode: 'force', nonce: 'new-run', launcher: pathToFileURL(join(root, 'must-not-import.mjs')).href }), /must not be reused/);
    assert.equal(await readFile(file, 'utf8'), '{"nonce":"old-run","pid":1}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
