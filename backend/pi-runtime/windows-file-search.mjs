/** Run the unchanged SDK search tools where their own filesystem reads cannot use the network. */
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gitScanEnvironment, credentialPolicy, isolationAvailable} from './isolation.ts';
import {requireLocalPath} from './windows-files.ts';

const OUTPUT_LIMIT = 1024 * 1024, TIMEOUT = 120000;
// Inline code avoids granting access to the daemon's runtime state merely to
// load this worker. The only imports come from the installed, read-only SDK.
export const searchWorkerSource = `
import {pathToFileURL} from 'node:url';
let text = '';
process.stdin.setEncoding('utf8');
for await (const part of process.stdin) {
  text += part;
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Search request exceeds 256 KiB');
}
try {
  const {sdk, name, cwd, args} = JSON.parse(text);
  const factories = await import(pathToFileURL(sdk).href);
  const factory = name === 'grep' ? factories.createGrepTool : name === 'find' ? factories.createFindTool : undefined;
  if (!factory) throw new Error('Unsupported file search');
  // SDK normalization applies to the URL spelling, before decoding, so a
  // Unicode space in the checked native path cannot become another filename.
  const result = await factory(cwd).execute('search', {...args, path:pathToFileURL(args.path).href});
  const output = JSON.stringify({result});
  if (Buffer.byteLength(output) > ${OUTPUT_LIMIT}) throw new Error('Search result exceeds 1 MiB');
  process.stdout.write(output);
} catch (error) {process.stdout.write(JSON.stringify({error:error.message})); process.exitCode = 1;}
`;

function sdkLocation(cwd) {
  // Production Pi starts from the packaged CLI or its adjacent launcher. A
  // checkout's tests resolve from this module's own package instead.
  const roots = [process.argv[1] && dirname(process.argv[1]), dirname(fileURLToPath(import.meta.url))].filter(Boolean);
  for (const root of roots) for (const sdk of [
    ...(basename(root) === 'dist' && basename(dirname(root)) === 'pi-coding-agent' ? [join(root, 'index.js')] : []),
    join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'),
  ]) {
    try {
      requireLocalPath(sdk, cwd, true);
      if (statSync(sdk).isFile()) return {sdk, runtime:dirname(dirname(dirname(dirname(dirname(sdk)))))};
    } catch { /* Try the other installed-package anchor. */ }
  }
  throw new Error('The installed file tools are unavailable. Update or repair Hexbot.');
}

export async function executeWindowsFileSearch(name, cwd, args, {home, signal} = {}) {
  if (process.platform !== 'win32') throw new Error('Windows file search requires Windows');
  if (!['grep', 'find'].includes(name)) throw new Error('Unsupported file search');
  if (signal?.aborted) throw new Error('Operation aborted');
  if (!isolationAvailable()) throw new Error('Guarded Windows file search needs OS containment, which is unavailable. Use local read and ls tools, or run an explicitly approved command.');
  const helper = process.env.HEXBOT_DAEMON_EXECUTABLE;
  if (!helper || !isAbsolute(helper)) throw new Error('The native Windows file sandbox is unavailable. Update or repair Hexbot.');
  const input = args.path ?? '.';
  // These checks precede even stat/module loading and helper setup: a UNC or
  // mapped drive must never reach a host filesystem operation before approval.
  for (const path of [helper, home, cwd, input, process.execPath, process.argv[1]].filter(Boolean)) requireLocalPath(path, cwd, true);
  const {sdk, runtime} = sdkLocation(cwd);
  const agent = process.env.PI_CODING_AGENT_DIR;
  if (!agent || !isAbsolute(agent)) throw new Error('The installed search tools are unavailable. Update or repair Hexbot.');
  const bin = join(agent, 'bin');
  for (const path of [sdk, runtime, bin]) requireLocalPath(path, cwd, true);
  const search = isAbsolute(input) ? input : join(cwd, input);
  const root = statSync(search).isDirectory() ? search : dirname(search);
  const id = randomUUID();
  const spec = {home, id, gitEnv:gitScanEnvironment(), readOnly:true, readRoots:[...new Set([cwd, root, runtime, bin])], writeRoots:[]};
  const inherited = new Set(credentialPolicy.environment.map(name => name.toUpperCase()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.has(name.toUpperCase()) || /^LC_/i.test(name)));
  // Never let a project PATH or a missing-tool download choose an executable.
  env.PATH = [bin, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';');
  env.PI_CODING_AGENT_DIR = agent;
  env.PI_OFFLINE = '1';
  const request = JSON.stringify({sdk, name, cwd, args:{...args, path:search}});
  if (Buffer.byteLength(request) > 256 * 1024) throw new Error('Search request exceeds 256 KiB');
  const child = spawn(helper, ['__sandbox', JSON.stringify(spec), '--', process.execPath, '--input-type=module', '-e', searchWorkerSource], {cwd, env, windowsHide:true, stdio:['pipe', 'pipe', 'pipe']});
  let output = '', diagnostic = '', stopped, timer;
  const stop = reason => {
    stopped ??= reason;
    // Killing the helper closes its Job handle and kills every owned rg/fd
    // descendant. Cleanup independently waits for an empty job before ACL edits.
    child.kill();
  };
  const abort = () => stop('Operation aborted');
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => {if (!stopped) {output += part; if (Buffer.byteLength(output) > OUTPUT_LIMIT) stop('Search result exceeds 1 MiB');}});
  child.stderr.on('data', part => {if (diagnostic.length < 8192) diagnostic += part.slice(0, 8192 - diagnostic.length);});
  child.stdin.on('error', () => {}); // A failed sandbox may exit before reading.
  const closed = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
  timer = setTimeout(() => stop('File search timed out'), TIMEOUT);
  signal?.addEventListener('abort', abort, {once:true});
  if (signal?.aborted) abort();
  child.stdin.end(request);
  try {
    const code = await closed;
    if (stopped) throw new Error(stopped);
    let reply;
    try {reply = JSON.parse(output);} catch {throw new Error(`The Windows file sandbox could not complete this search.${diagnostic ? ' ' + diagnostic.trim() : ''}`);}
    if (code !== 0 || reply.error || !reply.result) throw new Error(reply.error ?? 'The Windows file sandbox could not complete this search.');
    return reply.result;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    const cleanup = spawnSync(helper, ['__sandbox', '--cleanup', home, id], {windowsHide:true, timeout:15000, encoding:'utf8'});
    if (cleanup.status !== 0) throw new Error('The Windows file sandbox could not finish cleaning up its processes and permissions.');
  }
}
