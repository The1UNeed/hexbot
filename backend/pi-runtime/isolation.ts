// Child-process isolation for Pi's bash tool. credentials.rs builds the same
// profile for Python and scheduled scripts from the same credential-policy.json;
// a parity test there compares the two outputs.
import {readFileSync, readdirSync, realpathSync, existsSync, statSync, mkdirSync} from 'node:fs';
import {join, relative, resolve, dirname, basename} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
export const credentialPolicy = JSON.parse(readFileSync(new URL('./credential-policy.json', import.meta.url), 'utf8'));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// macOS and Windows file systems ignore case, so every path comparison and policy
// matcher does too (the sandbox itself matches the on-disk path, whatever case a
// child spells).
export const foldCase = process.platform === 'darwin' || process.platform === 'win32';
export const fold = (s: string) => foldCase ? s.toLowerCase() : s;
export const policyRegex = (source: string) => new RegExp(source, foldCase ? 'i' : '');
// Write policy entries are absolute or relative to the user's home.
export const policyRoot = (entry: string) => entry.startsWith('/') ? entry : join(homedir(), entry);
// Seatbelt regexes use character pairs rather than JavaScript's i flag.
const sandboxRegex = (source: string) => foldCase ? source.replace(/[a-z]/gi, c => `[${c.toLowerCase()}${c.toUpperCase()}]`) : source;
export const privateKeyName = (name: string) => !policyRegex(credentialPolicy.sshPublic).test(name);
const entries = (dir: string) => { try { return readdirSync(dir, {withFileTypes:true}); } catch { return []; } };
const cache = new Map<string, {at: number, paths: string[]}>();
function secretPaths(home: string): string[] {
  const cached = cache.get(home);
  if (cached && Date.now() - cached.at < 5000) return cached.paths;
  const paths = new Set<string>();
  const add = (path: string) => { paths.add(path); try { paths.add(realpathSync(path)); } catch {} };
  const walk = (dir: string) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name), local = relative(home, path);
      if (policyRegex(credentialPolicy.basename).test(entry.name) || policyRegex(credentialPolicy.home).test(local)) add(path);
      else if (entry.isDirectory() && !credentialPolicy.skip.includes(fold(entry.name)) && fold(local) !== 'runtime/sessions') walk(path);
    }
  };
  walk(home);
  const walkSsh = (dir: string) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() || privateKeyName(entry.name)) add(path);
    }
  };
  walkSsh(join(homedir(), '.ssh'));
  for (const local of credentialPolicy.user) add(join(homedir(), local));
  const sorted = [...paths].sort();
  cache.set(home, {at:Date.now(), paths:sorted});
  return sorted;
}
let bwrap: string | null | undefined;
export function probeIsolation(): string | null {
  if (bwrap !== undefined) return bwrap;
  bwrap = null;
  if (process.platform === 'linux') {
    const candidate = (process.env.PATH ?? '').split(':').map(dir => join(dir, 'bwrap')).find(existsSync);
    if (candidate && spawnSync(candidate, ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/usr/bin/env', 'true'], {timeout:5000}).status === 0) bwrap = candidate;
  }
  return bwrap;
}
// macOS always sandboxes (sandbox-exec fails closed). Elsewhere only bubblewrap does.
export const isolationAvailable = () => process.platform === 'darwin' || !!probeIsolation();
function realRoot(path: string): string {
  try { return realpathSync.native(path); }
  catch (error: any) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(realRoot(dirname(path)), basename(path));
  }
}
// The write policy's deny tier (credential stores such as ~/.aws and ~/.netrc):
// the OS sandbox makes "never written in any mode" hold for every program a
// command runs, not only for the guarded tools.
function deniedWrites(): string[] {
  const denied: string[] = [];
  for (const entry of credentialPolicy.write.deny as string[]) {
    const root = policyRoot(entry);
    const real = realRoot(root);
    for (const path of [root, real]) if (!denied.includes(path)) denied.push(path);
  }
  return denied;
}
// Renaming an ancestor would carry a nested store (~/.config/gh) out from under
// its rule, so the directories between the home and a store cannot be renamed
// or removed either; creating siblings inside them stays allowed.
function storeAncestors(denied: string[]): string[] {
  const homes = [...new Set([homedir(), realRoot(homedir())])];
  const ancestors: string[] = [];
  for (const path of denied) for (const home of homes) {
    for (let dir = dirname(path); dir.startsWith(home + '/'); dir = dirname(dir)) if (!ancestors.includes(dir)) ancestors.push(dir);
  }
  return ancestors;
}
// Only the daemon-chosen output folders are writable inside the home. The
// session cwd is never one of them: the daemon refuses a workspace there and
// ignores a saved cwd inside it.
function layout(home: string, outputs: string[] = [], guest?: string) {
  const roots = [...new Set([resolve(home), realpathSync(home)])];
  const writable = outputs.filter(p => existsSync(p)).map(p => realpathSync(p)).filter(p => roots.some(root => p.startsWith(root + '/')));
  return {roots, paths: secretPaths(home), writable, denied: deniedWrites(), hidden: guest !== undefined ? privatePaths(roots) : [], sessions: guest !== undefined ? sessionMasks(roots, guest) : []};
}
// A shared bot in someone else's room is a guest there: every bot's memory and
// notes folder, every About you, and every other section's folder (its history
// quotes what the owner read, and its attachments are the owner's) are
// unreadable for the programs a command starts, as privatePath() in the
// extension makes them for the file tools. `guest` is the guest's own section
// id: that folder stays readable, with its output folders writable.
// macOS matches the files by pattern, so one that appears mid-command is
// covered. bubblewrap can only mask a path that exists when the command
// starts, and a code run keeps its worker between calls, so the masks are
// whole folders the builder creates first: `users` (a guest needs nothing
// there), every bot's `memories`, and `runtime/sessions` with the own section
// bound back. An About you, note or section written later lands under a mask.
export const PRIVATE_PATTERNS = ['profiles/[^/]+/memories(/.*)?', 'users/[^/]+/user\\.md'];
export const NO_GUEST_SANDBOX = 'Hexbot has no OS sandbox on this system, so a shared bot cannot run commands or code in someone else\'s room. Install bubblewrap and restart the daemon.';
const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
function privatePaths(roots: string[]): string[] {
  const paths = new Set<string>();
  const add = (path: string) => { try { mkdirSync(path, {recursive:true}); } catch {} if (isDirectory(path)) { paths.add(path); paths.add(realpathSync(path)); } };
  for (const root of roots) {
    add(join(root, 'users'));
    // A profile that is a link to a folder elsewhere is masked by both paths.
    for (const bot of entries(join(root, 'profiles'))) if (isDirectory(join(root, 'profiles', bot.name))) add(join(root, 'profiles', bot.name, 'memories'));
  }
  return [...paths].sort();
}
// One mask per real folder: a home named through a link gives the lexical and
// canonical `runtime/sessions` the same folder, and a second tmpfs on it would
// hide the own section bound back under the first. The own section and its
// output folders are named by real path too, as the outputs are.
function sessionMasks(roots: string[], section: string): {masked: string, own?: string}[] {
  const masks = new Map<string, string | undefined>();
  for (const root of roots) {
    const sessions = join(root, 'runtime/sessions');
    try { mkdirSync(sessions, {recursive:true}); } catch {}
    if (!isDirectory(sessions)) continue;
    const masked = realpathSync(sessions);
    if (!masks.has(masked)) masks.set(masked, section ? join(masked, section) : undefined);
  }
  return [...masks].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([masked, own]) => ({masked, own}));
}
// Codex's workspace sandbox, for a session's own commands in Manual and Auto:
// no network, no host Unix sockets (a user service manager or Docker would
// start programs outside it), no signals to processes outside it, and writes
// only inside `workspace` (empty in Manual, so read-only) and to a few device
// files. Credential stores are unreadable, not just unwritable. Output folders stay writable only inside it. Shell profiles and login
// items stay read-only even inside it. On Linux /run and /tmp, where host
// sockets live, are private. A command the user lets out of it runs with the
// base layer alone.
const DEVICES = ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/dtracehelper'];
function confined(workspace: string[]) {
  const writable = [...new Set(workspace.filter(p => existsSync(p)).map(p => realpathSync(p)))];
  const config: string[] = [];
  for (const entry of credentialPolicy.write.ask as string[]) {
    const root = policyRoot(entry);
    for (const path of [root, realRoot(root)]) if (!config.includes(path)) config.push(path);
  }
  return {writable, config};
}
export function sandboxProfile(home: string, outputs: string[] = [], workspace?: string[], guest?: string): string {
  const {roots, paths, writable, denied, hidden, sessions} = layout(home, outputs, guest);
  const patterns = roots.flatMap(root => ['^' + regexEscape(root) + '/(.*/)?' + credentialPolicy.basename.slice(1), '^' + regexEscape(root) + '/' + credentialPolicy.home.slice(1)]);
  const ssh = join(homedir(), '.ssh');
  const sshFilters = [...new Set([ssh, existsSync(ssh) ? realpathSync(ssh) : ssh])].map(root => `(require-all (subpath ${JSON.stringify(root)}) (require-not (regex ${JSON.stringify(sandboxRegex('^' + regexEscape(root) + '/' + credentialPolicy.sshPublic.slice(1)))})))`);
  const filters = [...sshFilters, ...patterns.map(pattern => `(regex ${JSON.stringify(sandboxRegex(pattern))})`), ...paths.map(path => `(subpath ${JSON.stringify(path)})`)];
  const insideHome = `(require-any ${roots.map(p => `(subpath ${JSON.stringify(p)})`).join(' ')})`;
  const exceptWritable = writable.length ? `(require-not (require-any ${writable.map(p => `(subpath ${JSON.stringify(p)})`).join(' ')}))` : '';
  const stores = denied.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)}) (regex ${JSON.stringify(sandboxRegex("^" + regexEscape(p) + "(/|$)"))})`).join(' ');
  const ancestors = storeAncestors(denied).map(p => `(literal ${JSON.stringify(p)})`).join(' ');
  let confine = '';
  if (workspace) {
    const {writable: open, config} = confined(workspace);
    const inside = [...DEVICES.map(p => `(literal ${JSON.stringify(p)})`), ...['/dev/fd', ...open].map(p => `(subpath ${JSON.stringify(p)})`)].join(' ');
    confine = `(deny network-inbound)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))(deny file-read* ${stores})(deny file-write* (require-not (require-any ${inside})))(deny file-write* ${config.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)})`).join(' ')})`;
  }
  // Guest rules hold in the base layer too: an approved full_access command
  // in someone else's room still cannot read the owner's files.
  const owner = guest !== undefined ? `(deny file-read* ${[...roots.flatMap(root => PRIVATE_PATTERNS.map(pattern => `(regex ${JSON.stringify(sandboxRegex('^' + regexEscape(root) + '/' + pattern + '$'))})`)), ...hidden.map(path => `(subpath ${JSON.stringify(path)})`), ...sessions.map(({masked, own}) => own ? `(require-all (subpath ${JSON.stringify(masked)}) (require-not (subpath ${JSON.stringify(own)})))` : `(subpath ${JSON.stringify(masked)})`)].join(' ')})` : '';
  return `(version 1)(allow default)(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))(deny file-write* (require-all ${insideHome} ${exceptWritable}))(deny file-write* ${stores})${ancestors ? `(deny file-write-unlink ${ancestors})` : ''}${confine}${owner}(deny file-read* file-write* ${filters.join(' ')})`;
}
export function bwrapArguments(home: string, outputs: string[] = [], workspace?: string[], guest?: string): string[] {
  const {roots, paths, writable, denied, hidden, sessions} = layout(home, outputs, guest);
  const confine = workspace && confined(workspace);
  const args = confine ? ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--tmpfs', '/tmp'] : ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc'];
  if (confine) for (const path of confine.writable) if (path !== '/tmp') args.push('--bind', path, path);
  for (const root of roots) args.push('--ro-bind', root, root);
  const open = writable.filter(path => !confine || confine.writable.some(root => path === root || path.startsWith(root + '/')));
  for (const path of open) args.push('--bind', path, path);
  // A store that does not exist yet cannot be bound (bubblewrap would create the
  // mount point on the host).
  for (const path of denied) if (existsSync(path)) args.push(...!confine ? ['--ro-bind', path, path] : statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]);
  for (const path of confine ? confine.config : []) if (existsSync(path)) args.push('--ro-bind', path, path);
  for (const path of [...paths, ...hidden]) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]));
  // The sessions mask covers the output folder bound above, so the own section
  // comes back inside it, read-only with its output folders writable, before
  // the mask itself is made read-only.
  for (const {masked, own} of sessions) {
    args.push('--tmpfs', masked);
    if (own && existsSync(own)) {
      args.push('--ro-bind', own, own);
      for (const path of open) if (path.startsWith(own + '/')) args.push('--bind', path, path);
    }
    args.push('--remount-ro', masked);
  }
  return args;
}
// Neither sandbox caps process creation, so a workspace command may start at
// most this many more processes than you already run: a fork bomb stops there.
export const PROCESS_HEADROOM = 512;
export function processLimit(): number | undefined {
  // Linux charges the limit per thread, macOS per process.
  const listed = spawnSync('ps', [...process.platform === 'linux' ? ['-L'] : [], '-U', String(process.getuid?.() ?? ''), '-o', 'pid='], {encoding: 'utf8', timeout: 5000});
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).length + PROCESS_HEADROOM : undefined;
}
// `guest` is a shared bot's own section id in someone else's room, where its
// owner's files stay unreadable; such a command never runs without a sandbox.
export function isolatedCommand(command: string, home: string, outputs: string[] = [], workspace?: string[], guest?: string): string {
  // A command that cannot be capped does not run.
  if (workspace) {
    const limit = processLimit();
    command = limit ? `ulimit -u ${limit} || exit 126\n${command}` : "echo 'Hexbot could not cap processes for the sandbox.' >&2; exit 126";
  }
  if (process.platform === 'darwin') return `/usr/bin/sandbox-exec -p ${quote(sandboxProfile(home, outputs, workspace, guest))} /bin/bash --noprofile --norc -c ${quote(command)}`;
  const executable = probeIsolation();
  if (executable) return [executable, ...bwrapArguments(home, outputs, workspace, guest), '--', '/bin/bash', '--noprofile', '--norc', '-c', command].map(quote).join(' ');
  if (guest !== undefined) throw new Error(NO_GUEST_SANDBOX);
  return command;
}
