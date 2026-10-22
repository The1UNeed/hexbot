// Test-only wrapper around the real pinned Pi. Stdout remains Pi's exact RPC
// bytes; lifecycle evidence goes to this run's files and optional test IPC.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';

export async function runShutdownFixture({ directory, mode, nonce, launcher, monitor }) {
  const readyPath = join(directory, 'ready.json');
  if (existsSync(readyPath)) throw new Error('Shutdown fixture readiness must not be reused');
  const identity = { mode, nonce, pid: process.pid, ppid: process.ppid };
  const events = join(directory, `pi-${process.pid}.jsonl`);
  let count = 0;
  const record = (event, fields = {}) => {
    if (++count > 64) return;
    const value = { ...identity, event, ...fields };
    appendFileSync(events, JSON.stringify(value) + '\n');
    if (process.connected) process.send?.({ type: 'fixture-event', value });
  };
  record('start', { executable: process.execPath, node: process.versions.node, uv: process.versions.uv });
  process.on('exit', code => record('exit', { code }));
  process.on('beforeExit', code => record('before-exit', { code }));
  process.on('uncaughtExceptionMonitor', error => record('exception', { name: error.name, code: error.code ?? null }));
  const descendant = `
    const fs = require('node:fs');
    const identity = ${JSON.stringify({ mode, nonce })};
    const file = ${JSON.stringify(directory)} + '/descendant-' + process.pid + '.jsonl';
    const record = event => fs.appendFileSync(file, JSON.stringify({...identity,pid:process.pid,ppid:process.ppid,...event})+'\\n');
    process.on('exit', code => record({event:'exit',code}));
    process.on('uncaughtExceptionMonitor', error => record({event:'exception',name:error.name,code:error.code??null}));
    record({event:'ready'});
    setInterval(() => {}, 60_000);
    process.send({type:'descendant-ready',...identity,pid:process.pid,ppid:process.ppid});
  `;
  const child = spawn(process.execPath, ['-e', descendant], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
  });
  child.on('error', error => record('descendant-error', { name: error.name, code: error.code ?? null }));
  child.on('exit', (code, signal) => record('descendant-exit', { child: child.pid, code, signal }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Descendant startup timed out')), 15_000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', finish);
      child.once('exit', () => finish(new Error('Descendant exited before readiness')));
      child.once('message', value => {
        if (value?.type !== 'descendant-ready' || value.nonce !== nonce || value.mode !== mode ||
            value.pid !== child.pid || value.ppid !== process.pid) finish(new Error('Wrong descendant identity'));
        else finish();
      });
    });
    record('descendant-ready', { child: child.pid });
    // Rust captures kernel process handles before real Pi can reply or exit.
    // This is only a per-test startup barrier, never a daemon control endpoint.
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: monitor });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Tracking handshake timed out')); }, 15_000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => socket.write(JSON.stringify({ ...identity, child: child.pid }) + '\n'));
      let acknowledgement = '';
      socket.on('data', bytes => {
        acknowledgement += bytes;
        if (acknowledgement.length > 8 || acknowledgement.includes('\n')) {
          clearTimeout(timer); socket.destroy();
          if (acknowledgement === 'tracked\n') resolve();
          else reject(new Error('Wrong tracking acknowledgement'));
        }
      });
      socket.once('end', () => {
        if (acknowledgement !== 'tracked\n') { clearTimeout(timer); reject(new Error('Tracking socket closed early')); }
      });
    });
    record('tracked', { child: child.pid });
    let buffer = '';
    let ready = false;
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      if (!ready) {
        buffer += chunk.toString();
        if (buffer.length > 256 * 1024) throw new Error('Fixture startup record exceeded bound');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          if (value.type !== 'response' || value.command !== 'get_state') continue;
          record('pi-state-response', { success: value.success === true, child: child.pid });
          if (!value.success || child.exitCode !== null || child.signalCode !== null)
            throw new Error('Real Pi or descendant was not ready');
          writeFileSync(readyPath + '.tmp', JSON.stringify({ ...identity, child: child.pid }), { flag: 'wx' });
          if (existsSync(readyPath)) throw new Error('Replacement Pi tried to reuse readiness');
          renameSync(readyPath + '.tmp', readyPath);
          ready = true;
          record('ready', { child: child.pid });
          break;
        }
      }
      return original(chunk, ...args);
    };
    await import(launcher);
  } catch (error) {
    record('startup-error', { name: error.name, code: error.code ?? null });
    child.kill();
    throw error;
  }
}
