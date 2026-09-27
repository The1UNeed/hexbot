import {readFileSync, readdirSync, realpathSync, existsSync, statSync} from 'node:fs';
import {join, basename, relative, resolve} from 'node:path';
import {homedir} from 'node:os';
export const credentialPolicy = JSON.parse(readFileSync(new URL('./credential-policy.json', import.meta.url), 'utf8'));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let warned = false;
export function isolatedCommand(command: string, home: string): string {
  const roots = [...new Set([resolve(home), realpathSync(home)])];
  const ssh = join(homedir(), '.ssh');
  const paths = new Set<string>([ssh]);
  if (existsSync(ssh)) paths.add(realpathSync(ssh));
  const secret = (path: string) => new RegExp(credentialPolicy.basename).test(basename(path)) || new RegExp(credentialPolicy.home).test(relative(home, path));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes:true})) {
      const path = join(dir, entry.name);
      if (secret(path)) {
        paths.add(path);
        if (existsSync(path)) paths.add(realpathSync(path));
      } else if (entry.isDirectory() && !['node_modules', '.git', 'bin', 'venv', 'native', 'artifacts'].includes(entry.name)) walk(path);
    }
  };
  walk(home);
  if (process.platform === 'darwin') {
    const patterns = ['/' + credentialPolicy.basename.slice(1), ...roots.map(root => '^' + regexEscape(root) + '/' + credentialPolicy.home.slice(1))];
    const filters = [...patterns.map(pattern => `(regex #${JSON.stringify(pattern)})`), ...[...paths].map(path => `(subpath ${JSON.stringify(path)})`)];
    // sandbox-exec failure exits the command; there is no unsandboxed retry.
    const profile = `(version 1)(allow default)(deny file-read* file-write* ${filters.join(' ')})`;
    return `/usr/bin/sandbox-exec -p ${quote(profile)} /bin/bash --noprofile --norc -c ${quote(command)}`;
  }
  if (process.platform === 'linux') {
    const bwrap = (process.env.PATH ?? '').split(':').map(dir => join(dir, 'bwrap')).find(existsSync);
    if (bwrap) {
      const args = ['--die-with-parent', '--unshare-pid', '--bind', '/', '/', '--proc', '/proc'];
      for (const path of paths) if (existsSync(path)) args.push(...(statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]));
      return [bwrap, ...args, '--', '/bin/bash', '--noprofile', '--norc', '-c', command].map(quote).join(' ');
    }
  }
  if (!warned) { console.error('Hexbot credential isolation is unavailable; command approval guards remain active.'); warned = true; }
  return command;
}
