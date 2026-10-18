import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

// Never search the working directory or PATH for an executable that runs before
// the OS sandbox. Use the stock shell exercised by the native containment probe; disable its
// profiles and startup scripts.
export function powerShellExecutable(): string {
  const path = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (existsSync(path)) return path;
  throw new Error('Windows PowerShell could not be found.');
}
export const powerShellArgs = (command: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from("try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n$ProgressPreference='SilentlyContinue'\n" + command, 'utf16le').toString('base64')];

export function createWindowsShellOperations({cleanup}: {cleanup?: (command: string) => void} = {}) {
  return {async exec(command: string, cwd: string, {onData, signal, timeout, env}: any) {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) throw new Error('Invalid timeout: must be a positive finite number of seconds below 2147483.647');
    if (signal?.aborted) throw new Error('aborted');
    const helper = process.env.HEXBOT_DAEMON_EXECUTABLE;
    if (!helper || !isAbsolute(helper) || !existsSync(helper)) throw new Error('The native Hexbot process helper is unavailable. Update or repair Hexbot before running Windows commands.');
    const child = spawn(helper, ['__sandbox', '--unconfined', '--', powerShellExecutable(), ...powerShellArgs(command)], {cwd, env, stdio:['ignore', 'pipe', 'pipe'], windowsHide:true});
    let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined, drainTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], {stdio:'ignore', windowsHide:true, timeout:5000});
        child.kill();
      }
    };
    const exited = new Promise<number | null>((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
    const closed = new Promise<void>(resolve => child.once('close', resolve));
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    if (timeout !== undefined) timer = setTimeout(() => {timedOut = true; kill();}, timeout * 1000);
    signal?.addEventListener('abort', kill, {once:true});
    if (signal?.aborted) kill();
    try {
      const exitCode = await exited;
      // Descendants can inherit pipes after the shell exits. Bound the drain so
      // cancellation and failed MCP hooks cannot hold the daemon open forever.
      await Promise.race([closed, new Promise<void>(resolve => {drainTimer = setTimeout(resolve, 1000);})]);
      if (signal?.aborted) throw new Error('aborted');
      if (timedOut) throw new Error(`timeout:${timeout}`);
      return {exitCode:exitCode ?? 1};
    } finally {
      clearTimeout(timer); clearTimeout(drainTimer); signal?.removeEventListener('abort', kill);
      child.stdout.destroy(); child.stderr.destroy();
      cleanup?.(command);
    }
  }};
}
