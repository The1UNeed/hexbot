// Child-process isolation for Pi's bash tool. credentials.rs builds the same
// profile for Python and scheduled scripts from the same credential-policy.json;
// a parity test there compares the two outputs.
import {readFileSync, readdirSync, readlinkSync, realpathSync, existsSync, statSync, lstatSync, openSync, opendirSync, fstatSync, readSync, closeSync, constants, type Dirent} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, relative, resolve, dirname, basename, isAbsolute} from 'node:path';
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
export const userHomes = () => [...new Set(process.platform === 'win32'
  ? [process.env.USERPROFILE, process.env.HOME, homedir()].filter((path): path is string => !!path)
  : [homedir()])];
export const policyRoots = (entry: string) => isAbsolute(entry) ? [entry] : userHomes().map(home => join(home, entry));
export const policyRoot = (entry: string) => policyRoots(entry)[0];
export const WINDOWS_ISOLATION_UNAVAILABLE = 'Windows tool isolation is not implemented. Auto and Manual cannot run local commands, code, or file tools on Windows, including approved full_access requests. Windows remains unsupported. Bypass has no sandbox or credential protection.';
export function requireSupportedExecution(): void {
  if (process.platform === 'win32') throw new Error(WINDOWS_ISOLATION_UNAVAILABLE);
}
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
// A path that does not exist yet resolves through its existing parent, and a
// dangling link to where its target would be.
const LINK_HOPS = 40;
function realRoot(path: string, hops = 0): string {
  try { return realpathSync.native(path); }
  catch (error: any) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    let link: string | undefined;
    try { if (hops < LINK_HOPS && lstatSync(path).isSymbolicLink()) link = readlinkSync(path); } catch { /* Not there. */ }
    if (link !== undefined) return realRoot(link.startsWith('/') ? link : realRoot(dirname(path)) + '/' + link, hops + 1);
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
  requireSupportedExecution();
  const home = JSON.stringify(userHomes()), cached = readCache.get(home);
  if (cached && Date.now() - cached.at < 5000) return cached.paths;
  const denied: string[] = [];
  for (const root of (credentialPolicy.readDeny as string[]).flatMap(policyRoots)) {
    // A profile path that cannot be resolved (unreadable, a loop) is denied as named.
    let real = root;
    try { real = realRoot(root); } catch { /* Keep the name. */ }
    for (const path of [root, real]) if (!denied.includes(path)) denied.push(path);
  }
  readCache.set(home, {at: Date.now(), paths: denied});
  return denied;
}
// Inside the workspace sandbox git's own folders are read-only, as in Codex: a
// hook, config or gitdir written there would run outside the sandbox on the
// user's next commit. Project secrets are unreadable there too. Seatbelt matches
// these names wherever they appear, including ones created later; bubblewrap
// cannot match names, so on Linux the workspace is searched when a command
// starts, a few levels deep. The search reads at most WORKSPACE_DIRS folders and
// WORKSPACE_ENTRIES entries for each of them in all (50,000), so a huge flat
// folder cannot stall it either.
const GIT_DIR = '/' + regexEscape('.git') + '(/|$)';
// A folder with HEAD and objects whose name ends in .git is Git metadata. A
// literal .git belongs to the worktree around it; any other one is a bare
// repository, its own worktree.
export const gitDirectory = (path: string) => fold(basename(path)).endsWith('.git') && existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects'));
export const bareRepository = (path: string) => fold(basename(path)) !== '.git' && gitDirectory(path);
const WORKSPACE_DEPTH = 3, WORKSPACE_DIRS = 1000, WORKSPACE_ENTRIES = 50;
export const SCAN_REASON = 'The workspace safety scan exceeded its directory budget. This command needs approval: retry with full_access and a reason.';
export const SCAN_FILE_REASON = 'The workspace safety scan reached its directory budget, so Git protection is partial. Approve this file change only if you trust its destination.';
// Inside a writable root, as the sandboxes and file tools compare paths.
export const within = (path: string, roots: string[]) => roots.some(root => fold(path) === fold(root) || fold(path).startsWith(fold(root).replace(/\/$/, '') + '/'));
// A command can create the files the scan reads (.git pointers, commondir,
// configs and their includes), so they are opened without blocking and read only
// when they are small regular files: a FIFO or device would stall the daemon.
// Anything else stays locked but unread, which Git cannot load hooks from either.
// Includes are followed at most this deep. A scan reads each config file once
// and visits it once per worktree. Beyond the repository and user configs it
// reads at most GIT_INCLUDES include files for one worktree, which real
// configurations never reach, and GIT_SCAN_INCLUDES in all, and visits at most
// GIT_CONFIG_STEPS settings, so include cycles and fan-out cannot stall it.
const GIT_FILE_BYTES = 1 << 20, GIT_TIMEOUT = 5000, GIT_INCLUDE_DEPTH = 10, GIT_INCLUDES = 64, GIT_SCAN_INCLUDES = 256, GIT_CONFIG_STEPS = 10000;
function regularFile(path: string): Buffer | undefined {
  // Do not open Windows pipes/devices and then try to classify the handle.
  // No Windows metadata scan is supported yet.
  requireSupportedExecution();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error: any) { if (['ENOENT', 'ENOTDIR', 'ENXIO'].includes(error.code)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > GIT_FILE_BYTES) throw new Error('Git metadata is too large to scan.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read; length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += read;
    if (length > stat.size) throw new Error('Git metadata changed while it was scanned.');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
// Hook settings by a hash of the config contents, so unchanged repositories cost
// no Git process. The least recently used entry goes first, and the cache holds
// more configs than a scan of the largest workspace reads.
const GIT_CACHE = 2048;
const configCache = new Map<string, [string, string][]>();
function configEntries(text: Buffer): [string, string][] {
  // Windows has no managed trusted Git yet. In particular, do not substitute
  // `git` and search the workspace-controlled PATH outside the sandbox.
  requireSupportedExecution();
  const key = createHash('sha256').update(text).digest('hex'), cached = configCache.get(key);
  if (cached) {
    configCache.delete(key);
    configCache.set(key, cached);
    return cached;
  }
  // git config only parses; it does not run hooks, aliases or commands. Use system
  // Git, never a workspace executable from PATH, and give it the bytes already
  // read: with --no-includes it opens no file, so includes are followed here.
  const parsed = spawnSync('/usr/bin/git', ['config', '--no-includes', '--null', '--file', '-', '--path', '--get-regexp', '^(core.hookspath|include.path|includeif\\..*\\.path)$'], {
    input: text, encoding: 'utf8', timeout: GIT_TIMEOUT, env: {PATH: process.env.PATH, HOME: homedir()},
  });
  // Exit 1 without a message is "no matching settings"; a missing Git (the macOS
  // shim without developer tools) also exits 1, but says so.
  if (parsed.status !== 0 && !(parsed.status === 1 && !parsed.stderr)) throw new Error('Git hook configuration could not be read.');
  const entries: [string, string][] = [];
  for (const field of parsed.stdout.split('\0')) {
    const split = field.indexOf('\n');
    if (split > 0) entries.push([field.slice(0, split), field.slice(split + 1)]);
  }
  if (configCache.size >= GIT_CACHE) configCache.delete(configCache.keys().next().value!);
  configCache.set(key, entries);
  return entries;
}
// The user's own Git configuration applies to every repository: a global
// core.hooksPath such as .githooks names a folder in each worktree. The files
// are the ones Git reads: GIT_CONFIG_GLOBAL replaces ~/.gitconfig and the XDG
// file, and GIT_CONFIG_SYSTEM or GIT_CONFIG_NOSYSTEM choose the system file,
// which is otherwise /etc/gitconfig or Homebrew's. Other Git builds keep a
// system file elsewhere; it is not read.
const SYSTEM_GIT_CONFIGS = ['/etc/gitconfig', '/opt/homebrew/etc/gitconfig', '/usr/local/etc/gitconfig'];
export function globalGitConfigs(env: NodeJS.ProcessEnv = process.env): string[] {
  const set = (name: string) => env[name] || undefined;
  const files = set('GIT_CONFIG_GLOBAL') ? [set('GIT_CONFIG_GLOBAL')!] : set('HOME') ? [join(set('HOME')!, '.gitconfig'), join(set('XDG_CONFIG_HOME') ?? join(set('HOME')!, '.config'), 'git/config')] : [];
  const noSystem = set('GIT_CONFIG_NOSYSTEM');
  if (!noSystem || /^(0|false|no|off)$/i.test(noSystem)) files.push(...set('GIT_CONFIG_SYSTEM') ? [set('GIT_CONFIG_SYSTEM')!] : SYSTEM_GIT_CONFIGS);
  return files.filter(file => file.startsWith('/'));
}
// git: Git metadata, config files and configured folders, as named and as real
// paths. worktrees: the folders their repositories belong to. files: targets Git
// reads as files (includes). links: symbolic links inside the scanned roots on
// the way to any of them. cause: why Git configuration could not be scanned,
// when a limit stopped it.
export type WorkspaceScan = {git: string[], secrets: string[], worktrees: string[], files: string[], links: string[], exhausted: boolean, failure?: string, cause?: string};
export function workspaceProtected(roots: string[], limit = WORKSPACE_DIRS): WorkspaceScan {
  requireSupportedExecution();
  let exhausted = false, failure: string | undefined, cause: string | undefined;
  const git = new Set<string>(), secrets = new Set<string>(), worktrees = new Set<string>(), files = new Set<string>(), links = new Set<string>();
  const add = (set: Set<string>, path: string) => { set.add(path); set.add(realRoot(path)); };
  const scanned = roots.flatMap(root => { try { return [realRoot(root)]; } catch { return []; } });
  // A command could replace a link inside the workspace and so swap the metadata
  // a later ordinary git command trusts. The path is walked as the kernel walks
  // it, so a `..` after a link leaves the link's target, not the link's folder.
  // Links inside locked Git metadata (exempt) are locked with it.
  const linked = (path: string, exempt: string[] = []) => {
    const parts = path.split('/').reverse();
    let dir = '/';
    for (let hops = 0; parts.length;) {
      const part = parts.pop()!;
      if (!part || part === '.') continue;
      if (part === '..') { dir = dirname(dir); continue; }
      const next = join(dir, part);
      let link: string | undefined;
      try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { /* Not there yet. */ }
      if (link === undefined || ++hops > LINK_HOPS) { dir = next; continue; }
      if (within(next, scanned) && !scanned.some(root => fold(root) === fold(next)) && !within(next, exempt)) links.add(next);
      if (link.startsWith('/')) dir = '/';
      parts.push(...link.split('/').reverse());
    }
  };
  const pointerTarget = (base: string, value: string) => {
    const path = value.startsWith('/') ? value : base + '/' + value;
    linked(path);
    return realRoot(path);
  };
  const configs = new Map<string, [string, string][]>();
  const includes = new Set<string>();
  let steps = 0;
  const stop = (reason: string) => { cause ??= reason; return new Error(reason); };
  const configAt = (file: string) => {
    const real = realRoot(file);
    let found = configs.get(real);
    if (!found) {
      const text = regularFile(real);
      found = text ? configEntries(text) : [];
      configs.set(real, found);
    }
    return {real, found};
  };
  // Settings from the user's own configuration matter only where they name a
  // folder inside the scanned roots; the rest is outside the sandbox already.
  const hooks = (dirs: string[], worktree: string) => {
    const queue = [...dirs.flatMap(dir => [join(dir, 'config'), join(dir, 'config.worktree')]).map(file => ({file, depth: 0, user: false})), ...globalGitConfigs().map(file => ({file, depth: 0, user: true}))];
    const visited = new Set<string>(), own = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const {file, depth, user} = queue[i];
      const {real, found} = configAt(file);
      if (visited.has(real)) continue;
      visited.add(real);
      for (const [key, value] of found) {
        if (!value) continue;
        if (++steps > GIT_CONFIG_STEPS) throw stop(`Git configuration in the workspace has more than ${GIT_CONFIG_STEPS} settings`);
        const hooksPath = key === 'core.hookspath';
        const target = pointerTarget(hooksPath ? worktree : dirname(file), value);
        if (!hooksPath && !own.has(target)) {
          if (own.size >= GIT_INCLUDES) throw stop(`Git configuration for ${quote(worktree)} includes more than ${GIT_INCLUDES} files`);
          own.add(target);
          if (!includes.has(target) && includes.size >= GIT_SCAN_INCLUDES) throw stop(`Git configuration in the workspace includes more than ${GIT_SCAN_INCLUDES} files`);
          includes.add(target);
        }
        if (!user || within(target, scanned)) {
          add(git, target);
          if (!hooksPath) files.add(target);
        }
        if (!hooksPath && depth < GIT_INCLUDE_DEPTH) queue.push({file: target, depth: depth + 1, user});
      }
    }
  };
  const metadata = (path: string, worktree = dirname(path)) => {
    add(git, path);
    worktrees.add(realRoot(worktree));
    linked(path);
    let dir = path;
    if (!statSync(path, {throwIfNoEntry: false})?.isDirectory()) {
      const pointer = regularFile(path)?.toString('utf8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!pointer) return; // Cache markers and other files stay locked.
      dir = pointerTarget(dirname(path), pointer[1].trim());
      add(git, dir);
    }
    const common = regularFile(join(dir, 'commondir'))?.toString('utf8').trim();
    const dirs = [dir];
    if (common) {
      const target = pointerTarget(dir, common);
      add(git, target);
      dirs.unshift(target);
    }
    // The metadata folder itself is locked, but a hooks folder or config in it
    // can be a link to a folder or file in the workspace, which is locked too,
    // as is every link in the workspace on the way there.
    const exempt = dirs.flatMap(gitDir => [gitDir, realRoot(gitDir)]);
    for (const gitDir of dirs) for (const name of ['hooks', 'config', 'config.worktree', 'commondir']) {
      const entry = join(gitDir, name);
      linked(entry, exempt);
      add(git, entry);
      if (name !== 'hooks') files.add(realRoot(entry));
    }
    hooks(dirs, worktree);
  };
  const recordMetadata = (path: string, worktree?: string) => {
    try { metadata(path, worktree); } catch { failure = `Git metadata or hook configuration could not be scanned${cause ? ` because ${cause}` : ''}. Approve this file change only if you trust its destination.`; }
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
  let entriesLeft = limit * WORKSPACE_ENTRIES;
  for (let i = 0; i < queue.length && !exhausted; i++) {
    const {dir, depth} = queue[i];
    if (seen.has(dir)) continue;
    if (seen.size >= limit) { exhausted = true; break; }
    seen.add(dir);
    // Record every entry before visiting any child, even at the budget boundary.
    const list: Dirent[] = [];
    try {
      const handle = opendirSync(dir);
      try {
        for (let entry; (entry = handle.readSync()) !== null;) {
          if (list.length >= entriesLeft) { exhausted = true; break; }
          list.push(entry);
        }
      } finally { handle.closeSync(); }
    } catch { failure = 'The workspace safety scan could not read a directory. Approve this file change only if you trust its destination.'; continue; }
    if (exhausted) break;
    entriesLeft -= list.length;
    for (const entry of list.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(dir, entry.name);
      if (fold(entry.name) === '.git') recordMetadata(path, dir);
      else if (bareRepository(path)) recordMetadata(path, path);
      else if (secretFileName(entry.name) && !entry.isDirectory()) {
        // Follow valid directory links, but keep unresolved secret names masked.
        let directory = false;
        try { directory = statSync(path).isDirectory(); } catch { /* Mask unresolved secret names. */ }
        if (directory) continue;
        // A link that cannot be resolved (a loop) is masked by name alone.
        secrets.add(path);
        try { secrets.add(realRoot(path)); } catch { /* Nothing to read through it. */ }
      }
      else if (entry.isDirectory() && depth < WORKSPACE_DEPTH && !credentialPolicy.skip.includes(fold(entry.name))) queue.push({dir: path, depth: depth + 1});
    }
  }
  return {git: [...git], secrets: [...secrets], worktrees: [...worktrees], files: [...files], links: [...links], exhausted, failure, cause};
}
export function scanFailureReason(scan: Pick<WorkspaceScan, 'cause'>): string {
  return `The workspace safety scan could not finish${scan.cause ? ` because ${scan.cause}` : ''}. Retry with full_access and a reason.`;
}
// Repository files a command can write choose some Git targets (gitdir:,
// commondir, core.hooksPath, include.path), so only real paths inside a writable
// root are locked: anything else is read-only already, and binding or locking it
// could cover a mask (hooksPath = ~/.config/google-chrome) or the whole file
// system (hooksPath = /). On Linux a missing target is pinned at its nearest
// existing parent inside the writable root. A folder inside a repository is fine
// (.husky for a missing .husky/_), and so is one already locked, but pinning a
// repository's own folder, a writable root or a folder holding one would make
// all of it read-only, so the command needs approval instead, and creating the
// targets restores the sandbox. A symbolic link on the way to Git metadata
// inside a writable root could be replaced, which bubblewrap cannot prevent, so
// that needs approval too; Seatbelt locks the link itself.
const COMMAND_APPROVAL = {action: 'this command needs approval: retry with full_access and a reason', after: 'commands run in the sandbox again'};
export function missingGitReason(missing: {path: string, file: boolean}[], approval = COMMAND_APPROVAL): string {
  const one = missing.length === 1;
  const files = missing.filter(m => m.file).map(m => m.path);
  const dirs = [...new Set([...missing.filter(m => !m.file).map(m => m.path), ...files.map(file => dirname(file)).filter(dir => !existsSync(dir))])];
  const create = [dirs.length ? `mkdir -p ${dirs.map(quote).join(' ')}` : '', files.length ? `touch ${files.map(quote).join(' ')}` : ''].filter(Boolean).join(' && ');
  return `Git is set to load hooks or settings from ${missing.map(m => quote(m.path)).join(', ')}, which ${one ? 'does' : 'do'} not exist yet. The sandbox could keep ${one ? 'it' : 'them'} read-only only by making a whole repository or the workspace read-only, so ${approval.action}. Once ${one ? 'it exists' : 'they exist'} (${create}), ${approval.after}.`;
}
export function linkedGitReason(links: string[], approval = COMMAND_APPROVAL): string {
  return `Git metadata in the workspace is reached through ${links.length === 1 ? 'a symbolic link' : 'symbolic links'} (${links.map(quote).join(', ')}) that a command could replace, so ${approval.action}. Once ${links.length === 1 ? 'it is' : 'they are'} replaced by the folder or file ${links.length === 1 ? 'it points' : 'they point'} to, ${approval.after}.`;
}
export function lockedGit(scan: Pick<WorkspaceScan, 'git' | 'worktrees' | 'files' | 'links'>, roots: string[], pin = false): string[] {
  const locked = new Set<string>(), missing: {path: string, file: boolean}[] = [];
  // Only targets that are themselves locked can hold a pinned folder.
  const holders = [...roots, ...scan.worktrees], present = scan.git.flatMap(path => {
    try { const real = realRoot(path); return existsSync(real) && within(real, roots) ? [real] : []; } catch { return []; }
  });
  for (const path of scan.git) {
    let real: string;
    try { real = realRoot(path); } catch { continue; }
    const target = real;
    if (pin) while (!existsSync(real) && within(dirname(real), roots)) real = dirname(real);
    if (pin && real !== target && within(real, roots) && holders.some(holder => within(holder, [real])) && !within(real, present)) {
      if (!missing.some(m => m.path === target)) missing.push({path: target, file: scan.files.includes(target)});
      continue;
    }
    if (within(real, roots) && (!pin || existsSync(real))) locked.add(real);
  }
  const links = scan.links.filter(link => within(link, roots) && !roots.some(root => fold(root) === fold(link)));
  if (pin && missing.length) throw new Error(missingGitReason(missing));
  if (pin && links.length) throw new Error(linkedGitReason(links));
  for (const link of links) locked.add(link);
  // A path inside a locked folder is locked with it.
  const folded = new Set([...locked].map(fold));
  return [...locked].filter(path => { for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) if (folded.has(fold(dir))) return false; return true; });
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
// Reject mutable aliases of managed roots. Resolving only the candidate path
// misses a runtime root that itself points into a writable artifact directory.
export function managedRuntimeRoots(home: string): string[] {
  requireSupportedExecution();
  const root = resolve(home), realHome = realRoot(root);
  return [...new Set((credentialPolicy.managedRuntime as string[]).flatMap(local => {
    const path = join(root, local), real = realRoot(path);
    if (fold(real) !== fold(join(realHome, local))) throw new Error('Managed runtime roots must not be symlinked.');
    return [path, real];
  }))];
}
// Snapshot only: an already-unconfined process can insert an alias later.
// uv/cache hard links are valid unless an installed inode is also found in a
// declared workspace/output grant. No chmod or ACL changes are made.
export function rejectManagedHardlinks(managed: string[], grants: string[], budget = 100_000): void {
  const reason = 'Managed runtime hard-link topology could not be validated. Remove artifact/workspace hard links to installed files, use independent copies, and retry with smaller folders. Repair damaged runtimes from a trusted installer.';
  try {
    const linked = new Set<string>();
    for (const [roots, index] of [[managed, true], [grants, false]] as const) {
      if (!index && !linked.size) break;
      const visited = new Set<string>();
      const pending = roots.map(path => ({path, root:true}));
      while (pending.length) {
        if (--budget < 0) throw new Error(reason);
        const {path, root} = pending.pop()!;
        let info;
        try { info = statSync(path, {bigint:true}); }
        catch (error: any) { if (error.code === 'ENOENT' && (root || lstatSync(path).isSymbolicLink())) continue; throw error; }
        const id = `${info.dev}:${info.ino}`;
        if (info.isDirectory() && !visited.has(id)) {
          visited.add(id);
          const directory = opendirSync(path);
          try {
            for (let entry; (entry = directory.readSync());) {
              if (pending.length >= budget) throw new Error(reason);
              pending.push({path:join(path,entry.name),root:false});
            }
          } finally { directory.closeSync(); }
        } else if (info.isFile() && info.nlink > 1n) {
          if (index) linked.add(id);
          else if (linked.has(id)) throw new Error(reason);
        }
      }
    }
  } catch { throw new Error(reason); }
}
// Only the daemon-chosen output folders are writable inside the home. The
// session cwd is never one of them: the daemon refuses a workspace there and
// ignores a saved cwd inside it.
function layout(home: string, outputs: string[] = [], searchRoots: string[] = []) {
  const roots = [...new Set([resolve(home), realpathSync(home)])];
  const managed = managedRuntimeRoots(home);
  rejectManagedHardlinks(managed, [...outputs, ...searchRoots]);
  const writable = outputs.filter(p => existsSync(p)).map(p => realpathSync(p))
    .filter(p => roots.some(root => p.startsWith(root + '/')))
    .filter(p => !managed.some(root => within(p, [root]) || within(root, [p])));
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
  const {roots, paths, writable, denied} = layout(home, outputs, searchRoots);
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
    const git = lockedGit(protectedPaths, open);
    const secretPaths = protectedPaths.secrets.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
    const locked = git.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
    const parents = pathAncestors([...browserRoots, ...git, ...protectedPaths.secrets]).map(p => `(literal ${JSON.stringify(p)})`).join(' ');
    const browsers = browserRoots.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)}) (regex ${JSON.stringify(sandboxRegex("^" + regexEscape(p) + "(/|$)"))})`).join(' ');
    const secret = `(require-all (vnode-type REGULAR-FILE) (regex ${JSON.stringify(sandboxRegex('/' + credentialPolicy.secretFile.slice(1)))}) (require-not (regex ${JSON.stringify(sandboxRegex(credentialPolicy.secretFileExample))})))`;
    confine = `(deny network-inbound)(deny network-outbound (remote ip))(deny network-outbound (remote unix-socket))(deny signal)(allow signal (target same-sandbox))(deny file-read* ${stores} ${browsers} ${secret} ${secretPaths})(deny file-write* (require-not (require-any ${inside})))(deny file-write* ${config.map(p => `(literal ${JSON.stringify(p)}) (subpath ${JSON.stringify(p)})`).join(' ')})(deny file-write* ${browsers} ${secret} ${secretPaths} ${locked})(deny file-write-unlink ${parents})(deny file-write* (regex ${JSON.stringify(sandboxRegex(GIT_DIR))}))`;
  }
  // Apple Events would let a command drive Finder or another app outside the sandbox.
  return `(version 1)(allow default)(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))(deny appleevent-send)(deny file-write* (require-all ${insideHome} ${exceptWritable}))(deny file-write* ${stores})${ancestors ? `(deny file-write-unlink ${ancestors})` : ''}${confine}(deny file-read* file-write* ${filters.join(' ')})`;
}
export function bwrapArguments(home: string, outputs: string[] = [], workspace?: string[], searchRoots: string[] = workspace ?? []): string[] {
  const {roots, paths, writable, denied} = layout(home, outputs, searchRoots);
  const confine = workspace && confined(workspace);
  const args = confine ? ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--tmpfs', '/tmp'] : ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc'];
  if (confine) for (const path of confine.writable) if (path !== '/tmp') args.push('--bind', path, path);
  if (confine) for (const path of [...new Set(searchRoots.filter(existsSync).map(p => realpathSync(p)))]) {
    if (!confine.writable.some(root => path === root || path.startsWith(root + '/'))) args.push('--ro-bind', path, path);
  }
  for (const root of roots) args.push('--ro-bind', root, root);
  for (const path of writable) if (!confine || confine.writable.some(root => path === root || path.startsWith(root + '/'))) args.push('--bind', path, path);
  // Host binds come before every mask, so a later bind can never uncover one.
  const scan = confine && workspaceProtected(searchRoots);
  if (scan) {
    if (scan.exhausted) throw new Error(SCAN_REASON);
    if (scan.failure) throw new Error(scanFailureReason(scan));
    for (const path of lockedGit(scan, confine.writable.filter(p => p !== '/tmp'), true)) args.push('--ro-bind', path, path);
    for (const path of confine.config) if (existsSync(path)) args.push('--ro-bind', path, path);
  }
  // A store that does not exist yet cannot be bound (bubblewrap would create the
  // mount point on the host).
  for (const path of denied) if (existsSync(path)) args.push(...!confine ? ['--ro-bind', path, path] : statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]);
  if (scan) {
    for (const path of readDenied()) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]));
    // A dangling link has nothing to read yet, and bubblewrap would create its target.
    for (const path of scan.secrets) if (existsSync(path)) args.push('--ro-bind', '/dev/null', path);
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
  // Approval/full_access cannot turn missing Windows containment into execution.
  requireSupportedExecution();
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
