import {statSync, symlinkSync as nativeSymlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
export const windows = process.platform === 'win32';
export const nullDevice = windows ? 'NUL' : '/dev/null';
export const outsideTemporaryRoot = windows ? dirname(tmpdir()) : '/var/tmp';
export const normalize = path => path.replaceAll('\\', '/');
export const environmentCommand = windows ? 'Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }' : 'env';
export function useHome(t, home) {
  const previous = {HOME:process.env.HOME, USERPROFILE:process.env.USERPROFILE};
  process.env.HOME = home;
  if (windows) process.env.USERPROFILE = home;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// Register immediately after spawn, before assertions, so a failed test cannot
// leave Pi or one of its MCP servers holding the test runner's pipes open.
export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (windows && child.pid) {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], {stdio:'ignore', windowsHide:true});
    killer.on('error', () => child.kill());
  } else child.kill('SIGKILL');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child did not exit after termination')), 5000); timer.unref(); })]); }
  finally { clearTimeout(timer); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); }
}

export function symlinkSync(target, path, type) {
  if (windows && !type) {
    try { if (statSync(resolve(dirname(path), target)).isDirectory()) return nativeSymlinkSync(resolve(dirname(path), target), path, 'junction'); } catch { /* File or dangling link. */ }
  }
  return nativeSymlinkSync(target, path, type);
}

export const hostPath = path => windows ? /^\/etc\//i.test(path) ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/drivers', path.slice(1)) : resolve(path) : path;
