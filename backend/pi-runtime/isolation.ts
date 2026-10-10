// Child-process isolation for Pi's bash tool. credentials.rs builds the same
// profile for Python and scheduled scripts from the same credential-policy.json;
// a parity test there compares the two outputs.
import {readFileSync, readdirSync, realpathSync, existsSync, statSync} from 'node:fs';
import {join, relative, resolve, dirname, basename} from 'node:path';
import {homedir, tmpdir} from 'node:os';
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
// Project secrets such as .env, wherever they are; .env.example and the like are not.
export const secretFileName = (name: string) => policyRegex(credentialPolicy.secretFile).test(name) && !policyRegex(credentialPolicy.secretFileExample).test(name);
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
// Keychains and browser profiles (cookies, saved passwords). Unreadable in
// Manual and Auto and to the file tools; an approved full_access command may
// read them.
const readCache = new Map<string, {at: number, paths: string[]}>();
export function readDenied(): string[] {
  const home = homedir(), cached = readCache.get(home);
  if (cached && Date.now() - cached.at < 5000) return cached.paths;
  const denied: string[] = [];
  for (const entry of credentialPolicy.readDeny as string[]) {
    const root = policyRoot(entry);
    for (const path of [root, realRoot(root)]) if (!denied.includes(path)) denied.push(path);
  }
  readCache.set(home, {at: Date.now(), paths: denied});
  return denied;
}
// Inside the workspace sandbox git's own folders are read-only, as in Codex: a
// hook, config or gitdir written there would run outside the sandbox on the
// user's next commit. Project secrets are unreadable there too. Seatbelt matches
// these names wherever they appear, including ones created later; bubblewrap
// cannot match names, so on Linux the workspace is searched when a command
// starts, a few levels deep.
const GIT_DIR = '/' + regexEscape('.git') + '(/|$)';
export const bareRepository = (path: string) => fold(basename(path)).endsWith('.git') && existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects'));
const WORKSPACE_DEPTH = 3, WORKSPACE_DIRS = 1000;
export const SCAN_REASON = 'The workspace safety scan exceeded its directory budget. This command needs approval: retry with full_access and a reason.';
export const SCAN_FILE_REASON = 'The workspace safety scan reached its directory budget, so Git protection is partial. Approve this file change only if you trust its destination.';
export function workspaceProtected(roots: string[], limit = WORKSPACE_DIRS): {git: string[], secrets: string[], exhausted: boolean, failure?: string} {
  let exhausted = false, failure: string | undefined;
  const git = new Set<string>(), secrets = new Set<string>();
  const add = (set: Set<string>, path: string) => { set.add(path); set.add(realRoot(path)); };
  const pointerTarget = (base: string, value: string) => realRoot(value.startsWith('/') ? value : base + '/' + value);
  const hooks = (dir: string, worktree: string) => {
    for (const config of [join(dir, 'config'), join(dir, 'config.worktree')]) {
      if (!existsSync(config)) continue;
      // git config only parses files; it does not run hooks, aliases or commands.
      // Use system Git, never a workspace executable from PATH. Explicit --file
      // avoids user/system config. Git handles quoting and includes.
      const parsed = spawnSync('/usr/bin/git', ['config', '--null', '--includes', '--file', config, '--show-origin', '--path', '--get-regexp', '^(core.hookspath|include.path|includeif\\..*\\.path)$'], {
        encoding: 'utf8', timeout: 5000,
        env: {PATH: process.env.PATH, HOME: homedir(), GIT_DIR: dir, GIT_WORK_TREE: worktree},
      });
      if (parsed.status === 1) continue; // No matching settings.
      if (parsed.status !== 0) throw new Error('Git hook configuration could not be read.');
      const fields = parsed.stdout.split('\0');
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const origin = fields[i].replace(/^file:/, '');
        add(git, origin);
        const split = fields[i + 1].indexOf('\n');
        const key = fields[i + 1].slice(0, split), value = fields[i + 1].slice(split + 1);
        if (value) add(git, pointerTarget(key === 'core.hookspath' ? worktree : dirname(origin), value));
      }
    }
  };
  const metadata = (path: string, worktree = dirname(path)) => {
    add(git, path);
    let dir = path;
    if (statSync(path).isFile()) {
      const pointer = readFileSync(path, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!pointer) return; // Cache markers are ordinary files, but remain locked.
      dir = pointerTarget(dirname(path), pointer[1].trim());
      add(git, dir);
    }
    const common = join(dir, 'commondir');
    if (existsSync(common)) {
      const target = pointerTarget(dir, readFileSync(common, 'utf8').trim());
      add(git, target);
      hooks(target, worktree);
    }
    hooks(dir, worktree);
  };
  const recordMetadata = (path: string, worktree?: string) => {
    try { metadata(path, worktree); } catch { failure = 'Git metadata or hook configuration could not be scanned. Approve this file change only if you trust its destination.'; }
  };
  const queue: {dir: string, depth: number}[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root === '/tmp' || root === tmpdir()) continue;
    let dir: string;
    try { dir = realRoot(root); } catch { failure = 'The workspace safety scan could not read a directory. Approve this file change only if you trust its destination.'; continue; }
    if (bareRepository(dir)) recordMetadata(dir, dir);
    queue.push({dir, depth: 0});
    // A section can use a subdirectory of a linked worktree as its cwd.
    for (let parent = dir; dirname(parent) !== parent; parent = dirname(parent)) {
      const marker = join(parent, '.git');
      if (existsSync(marker)) recordMetadata(marker);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const {dir, depth} = queue[i];
    if (seen.has(dir)) continue;
    if (seen.size >= limit) { exhausted = true; break; }
    seen.add(dir);
    // Record every entry before visiting any child, even at the budget boundary.
    let list: ReturnType<typeof entries>;
    try { list = readdirSync(dir, {withFileTypes:true}); } catch { failure = 'The workspace safety scan could not read a directory. Approve this file change only if you trust its destination.'; continue; }
    for (const entry of list.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (fold(entry.name) === '.git' || bareRepository(path)) recordMetadata(path, bareRepository(path) ? path : dirname(path));
      else if (secretFileName(entry.name) && !entry.isDirectory()) {
        // Follow valid directory links, but keep unresolved secret names masked.
        let directory = false;
        try { directory = statSync(path).isDirectory(); } catch { /* Mask unresolved secret names. */ }
        if (directory) continue;
        try { add(secrets, path); } catch { failure = 'The workspace safety scan could not resolve a secret path. Approve this file change only if you trust its destination.'; }
      }
      else if (entry.isDirectory() && depth < WORKSPACE_DEPTH && !credentialPolicy.skip.includes(fold(entry.name))) queue.push({dir: path, depth: depth + 1});
    }
  }
  return {git: [...git], secrets: [...secrets], exhausted, failure};
}
function pathAncestors(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const path of paths) for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) ancestors.add(dir);
  return [...ancestors];
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
function layout(home: string, outputs: string[] = []) {
  const roots = [...new Set([resolve(home), realpathSync(home)])];
  const writable = outputs.filter(p => existsSync(p)).map(p => realpathSync(p)).filter(p => roots.some(root => p.startsWith(root + '/')));
  return {roots, paths: secretPaths(home), writable, denied: deniedWrites()};
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
export function sandboxProfile(home: string, outputs: string[] = [], workspace?: string[], searchRoots: string[] = workspace ?? []): string {
  const {roots, paths, writable, denied} = layout(home, outputs);
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
    const protectedPaths = workspaceProtected(searchRoots);
    const browserRoots = readDenied();
    const secretPaths = protectedPaths.secrets.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
    const locked = protectedPaths.git.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
    const parents = pathAncestors([...browserRoots, ...protectedPaths.git, ...protectedPaths.secrets]).map(p => `(literal ${JSON.stringify(p)})`).join(' ');
    const browsers = browserRoots.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)}) (regex ${JSON.stringify(sandboxRegex("^" + regexEscape(p) + "(/|$)"))})`).join(' ');
    const secret = `(require-all (vnode-type REGULAR-FILE) (regex ${JSON.stringify(sandboxRegex('/' + credentialPolicy.secretFile.slice(1)))}) (require-not (regex ${JSON.stringify(sandboxRegex(credentialPolicy.secretFileExample))})))`;
    confine = `(deny network-inbound)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))(deny file-read* ${stores} ${browsers} ${secret} ${secretPaths})(deny file-write* (require-not (require-any ${inside})))(deny file-write* ${config.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)})`).join(' ')})(deny file-write* ${browsers} ${secret} ${secretPaths} ${locked})(deny file-write-unlink ${parents})(deny file-write* (regex ${JSON.stringify(sandboxRegex(GIT_DIR))}))`;
  }
  // Apple Events would let a command drive Finder or another app outside the sandbox.
  return `(version 1)(allow default)(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))(deny appleevent-send)(deny file-write* (require-all ${insideHome} ${exceptWritable}))(deny file-write* ${stores})${ancestors ? `(deny file-write-unlink ${ancestors})` : ''}${confine}(deny file-read* file-write* ${filters.join(' ')})`;
}
export function bwrapArguments(home: string, outputs: string[] = [], workspace?: string[], searchRoots: string[] = workspace ?? []): string[] {
  const {roots, paths, writable, denied} = layout(home, outputs);
  const confine = workspace && confined(workspace);
  const args = confine ? ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--tmpfs', '/tmp'] : ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc'];
  if (confine) for (const path of confine.writable) if (path !== '/tmp') args.push('--bind', path, path);
  if (confine) for (const path of [...new Set(searchRoots.filter(existsSync).map(p => realpathSync(p)))]) {
    if (!confine.writable.some(root => path === root || path.startsWith(root + '/'))) args.push('--ro-bind', path, path);
  }
  for (const root of roots) args.push('--ro-bind', root, root);
  for (const path of writable) if (!confine || confine.writable.some(root => path === root || path.startsWith(root + '/'))) args.push('--bind', path, path);
  // A store that does not exist yet cannot be bound (bubblewrap would create the
  // mount point on the host).
  for (const path of denied) if (existsSync(path)) args.push(...!confine ? ['--ro-bind', path, path] : statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]);
  for (const path of confine ? confine.config : []) if (existsSync(path)) args.push('--ro-bind', path, path);
  if (confine) {
    for (const path of readDenied()) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]));
    const {git, secrets, exhausted, failure} = workspaceProtected(searchRoots);
    if (exhausted) throw new Error(SCAN_REASON);
    if (failure) throw new Error('The workspace safety scan could not finish. Retry with full_access and a reason.');
    for (let path of git) {
      // Pin the nearest existing parent when the configured hooks dir is absent.
      while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
      args.push('--ro-bind', path, path);
    }
    for (const path of secrets) args.push('--ro-bind', '/dev/null', path);
  }
  for (const path of paths) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]));
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
export function isolatedCommand(command: string, home: string, outputs: string[] = [], workspace?: string[], searchRoots: string[] = workspace ?? []): string {
  // A command that cannot be capped does not run.
  if (workspace) {
    const limit = processLimit();
    command = limit ? `ulimit -u ${limit} || exit 126\n${command}` : "echo 'Hexbot could not cap processes for the sandbox.' >&2; exit 126";
  }
  if (process.platform === 'darwin') return `/usr/bin/sandbox-exec -p ${quote(sandboxProfile(home, outputs, workspace, searchRoots))} /bin/bash --noprofile --norc -c ${quote(command)}`;
  const executable = probeIsolation();
  if (executable) return [executable, ...bwrapArguments(home, outputs, workspace, searchRoots), '--', '/bin/bash', '--noprofile', '--norc', '-c', command].map(quote).join(' ');
  return command;
}
