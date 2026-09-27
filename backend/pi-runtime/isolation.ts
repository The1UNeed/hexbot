import {readFileSync, readdirSync, realpathSync, existsSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
export const credentialPolicy = JSON.parse(readFileSync(new URL('./credential-policy.json', import.meta.url), 'utf8'));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const privateKeyName = (name: string) => /^(id_.*|.*\.(pem|key))$/.test(name) && !name.endsWith('.pub');
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
      if (new RegExp(credentialPolicy.basename).test(entry.name) || new RegExp(credentialPolicy.home).test(local)) add(path);
      else if (entry.isDirectory() && !['node_modules', '.git', 'bin', 'venv', 'native', 'artifacts', 'python', 'cache'].includes(entry.name) && local !== 'runtime/sessions') walk(path);
    }
  };
  walk(home);
  const walkSsh = (dir: string) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name);
      if (privateKeyName(entry.name)) add(path);
      else if (entry.isDirectory()) walkSsh(path);
    }
  };
  walkSsh(join(homedir(), '.ssh'));
  cache.set(home, {at:Date.now(), paths:[...paths]});
  return [...paths];
}
let bwrap: string | null | undefined;
export function probeIsolation(): string | null {
  if (bwrap !== undefined) return bwrap;
  bwrap = null;
  if (process.platform === 'linux') {
    const candidate = (process.env.PATH ?? '').split(':').map(dir => join(dir, 'bwrap')).find(existsSync);
    if (candidate && spawnSync(candidate, ['--die-with-parent', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], {timeout:5000}).status === 0) bwrap = candidate;
  }
  if (process.platform !== 'darwin' && !bwrap) console.error('Hexbot credential isolation is unavailable; command approval guards remain active.');
  return bwrap;
}
export function isolatedCommand(command: string, home: string, cwd?: string, outputs: string[] = []): string {
  const roots = [...new Set([resolve(home), realpathSync(home)])];
  const paths = secretPaths(home);
  const writable = [cwd, ...outputs].filter((p): p is string => !!p && existsSync(p)).map(p => realpathSync(p)).filter(p => roots.some(root => p.startsWith(root + '/')));
  if (process.platform === 'darwin') {
    const patterns = roots.flatMap(root => ['^' + regexEscape(root) + '/(.*/)?' + credentialPolicy.basename.slice(1), '^' + regexEscape(root) + '/' + credentialPolicy.home.slice(1)]);
    const ssh = join(homedir(), '.ssh');
    const sshFilters = [...new Set([ssh, existsSync(ssh) ? realpathSync(ssh) : ssh])].map(root => `(require-all (regex ${JSON.stringify('^' + regexEscape(root) + '/(.*/)?(id_[^/]*|[^/]*\\.(pem|key))$')}) (require-not (regex ${JSON.stringify('\\.pub$')})))`);
    const filters = [...sshFilters, ...patterns.map(pattern => `(regex ${JSON.stringify(pattern)})`), ...paths.map(path => `(subpath ${JSON.stringify(path)})`)];
    const insideHome = `(require-any ${roots.map(p => `(subpath ${JSON.stringify(p)})`).join(' ')})`;
    const exceptWritable = writable.length ? `(require-not (require-any ${writable.map(p => `(subpath ${JSON.stringify(p)})`).join(' ')}))` : '';
    const profile = `(version 1)(allow default)(deny file-write* (require-all ${insideHome} ${exceptWritable}))(deny file-read* file-write* ${filters.join(' ')})`;
    return `/usr/bin/sandbox-exec -p ${quote(profile)} /bin/bash --noprofile --norc -c ${quote(command)}`;
  }
  const executable = probeIsolation();
  if (executable) {
    const args = ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc'];
    for (const root of roots) args.push('--ro-bind', root, root);
    for (const path of writable) args.push('--bind', path, path);
    for (const path of paths) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path, '--remount-ro', path] : ['--ro-bind', '/dev/null', path]));
    return [executable, ...args, '--', '/bin/bash', '--noprofile', '--norc', '-c', command].map(quote).join(' ');
  }
  return command;
}
