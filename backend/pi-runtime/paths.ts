import {realpathSync, lstatSync, readlinkSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {homedir} from 'node:os';

export const foldCase = process.platform === 'darwin' || process.platform === 'win32';
export const fold = (path: string) => foldCase ? path.toLowerCase() : path;
export const within = (path: string, roots: string[]) => roots.some(root => {
  const local = relative(fold(root), fold(path));
  return !local || local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local);
});

export function expandHome(path: string): string {
  const user = process.env.USER ?? process.env.USERNAME ?? basename(homedir());
  return path.replace(/\$\{HOME\}|\$HOME\b/g, homedir())
    .replace(process.platform === 'win32' ? /^~([^/\\]*)/ : /^~([^/]*)/, (_match, name) => !name || name === user ? homedir() : join(dirname(homedir()), name));
}

function normalizedPath(path: string): string {
  let expanded = path;
  if (process.platform === 'win32') {
    expanded = expanded.replaceAll('/', '\\');
    // Extended paths may spell the same file; device paths and alternate data
    // streams cannot be approved as ordinary files.
    if (/^\\\\\?\\UNC\\/i.test(expanded)) expanded = '\\\\' + expanded.slice(8);
    else if (/^\\\\\?\\[a-z]:\\/i.test(expanded)) expanded = expanded.slice(4);
    else if (/^\\\\[?.]\\/.test(expanded)) throw new Error('Windows device paths are unavailable to file tools');
    if (/^\\(?!\\)/.test(expanded)) throw new Error('A Windows path must include its drive or share');
    if (/^[a-z]:[^\\]/i.test(expanded) || /^[a-z]:$/i.test(expanded)) throw new Error('Use an absolute Windows drive path');
  }
  if (process.platform === 'win32') for (const part of expanded.slice(parse(expanded).root.length).split(sep)) {
    if (!part || part === '.' || part === '..') continue;
    const base = part.split('.')[0].trimEnd().toUpperCase();
    if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/.test(base) || /[. ]$/.test(part) || /[\p{Cc}<>:\x22|?*]/u.test(part)) throw new Error('Windows device names, file streams and ambiguous names are not allowed');
  }
  return expanded;
}
export function validateFilePath(path: string): void { normalizedPath(expandHome(path)); }

// Preserve component order: a parent after a symbolic link or junction belongs
// to the link's destination. resolve() alone would remove it before following it.
export function canonicalPath(path: string, cwd: string, depth = 0): string {
  if (depth > 40) throw new Error('Too many symbolic links');
  const expanded = normalizedPath(expandHome(path));
  const root = parse(expanded).root;
  let current = root ? resolve(cwd, root) : realpathSync.native(cwd);
  for (const part of expanded.slice(root.length).split(sep)) {
    if (!part || part === '.') continue;
    current = part === '..' ? dirname(current) : join(current, part);
    try { current = realpathSync.native(current); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) current = canonicalPath(readlinkSync(current), dirname(current), depth + 1);
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return current;
}
