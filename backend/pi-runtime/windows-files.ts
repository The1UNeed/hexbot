import {AsyncLocalStorage} from 'node:async_hooks';
import {spawnSync} from 'node:child_process';
import {isAbsolute} from 'node:path';

// Keep this state per gate/execution, including asynchronous SDK operations.
// Bypass uses the SDK directly and does not enter the guarded filesystem path.
const checks = new AsyncLocalStorage<Set<string>>();
export const withLocalPathChecks = <T>(operation: () => T): T => process.platform === 'win32' ? checks.run(new Set(), operation) : operation();
export const localPathChecksActive = () => process.platform === 'win32' && !!checks.getStore();
const key = (path: string, cwd: string) => cwd + '\0' + path;
const failure = (message: string) => Object.assign(new Error(message), {code:'HEXBOT_WINDOWS_PATH'});

export function localPaths(paths: string[], cwd = process.cwd(), fresh = false): boolean[] {
  if (process.platform !== 'win32') return paths.map(() => true);
  const helper = process.env.HEXBOT_DAEMON_EXECUTABLE;
  if (!helper || !isAbsolute(helper)) throw failure('Update or repair Hexbot before using guarded Windows file tools.');
  const cached = checks.getStore();
  const allowed = paths.map(path => !fresh && !!cached?.has(key(path, cwd)));
  const pending = paths.map((path, index) => ({path, index})).filter(({index}) => !allowed[index]);
  for (let start = 0; start < pending.length;) {
    let batch = pending.slice(start, start + 1024);
    let input = JSON.stringify({cwd, paths:batch.map(({path}) => path)});
    // Bound the protocol by bytes too. A single excessively long path fails
    // closed rather than passing through a Windows command-line parser.
    while (Buffer.byteLength(input) > 256 * 1024 && batch.length > 1) {
      batch = batch.slice(0, Math.ceil(batch.length / 2));
      input = JSON.stringify({cwd, paths:batch.map(({path}) => path)});
    }
    if (Buffer.byteLength(input) > 256 * 1024) throw failure('The Windows file safety request is too large.');
    start += batch.length;
    const child = spawnSync(helper, ['__validate-local-paths'], {input, encoding:'utf8', windowsHide:true, timeout:15000, maxBuffer:256 * 1024});
    let result: any;
    try { result = JSON.parse(child.stdout); } catch { /* Fail closed below. */ }
    if (child.status !== 0 || !Array.isArray(result?.allowed) || result.allowed.length !== batch.length || result.allowed.some((value: any) => typeof value !== 'boolean')) throw failure('The Windows file safety check failed. Update or repair Hexbot and try again.');
    batch.forEach(({path, index}, offset) => {
      allowed[index] = result.allowed[offset];
      if (allowed[index]) cached?.add(key(path, cwd));
    });
  }
  return allowed;
}

export function requireLocalPath(path: string, cwd = process.cwd(), fresh = false): void {
  if (process.platform !== 'win32' || !fresh && !checks.getStore()) return;
  if (!localPaths([path], cwd, fresh)[0]) throw failure('Windows guarded file tools require a verifiable local path. Network paths require Bypass and a trusted destination.');
}
