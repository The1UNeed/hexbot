import {readFileSync, existsSync, statSync} from 'node:fs';
import {dirname, extname, isAbsolute, join, resolve} from 'node:path';
import {expandHome, validateFilePath} from './paths.ts';

let installed = false;
/**
 * Pi MCP 1.0.1 closes Windows transports with a PATH-resolved taskkill, which
 * can execute a workspace file. Its process wrapper may also leave descendants
 * behind after the server exits. Keep this small compatibility patch at our
 * private boundary: every server below owns a native kill-on-close Job, so
 * terminating the exact helper process is sufficient. A Pi version update must
 * review this adapter and pass the real Windows lifecycle/sentinel tests.
 */
export async function installWindowsMcpTransport(): Promise<void> {
  if (process.platform !== 'win32' || installed) return;
  const entry = import.meta.resolve('@earendil-works/pi-mcp');
  const version = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8')).version;
  if (version !== '1.0.1') throw new Error('Windows connected tools require a transport review for this Pi version.');
  const {StdioTransport} = await import('@earendil-works/pi-mcp');
  const probe: any = new StdioTransport({command:process.execPath});
  if (!['options', 'child', 'closed', 'started'].every(key => Object.hasOwn(probe, key)) || typeof probe.closed !== 'boolean' || typeof probe.started !== 'boolean' || probe.child !== undefined || typeof probe.emitClose !== 'function' || typeof StdioTransport.prototype.close !== 'function') throw new Error('The Windows connected-tool transport changed unexpectedly.');
  StdioTransport.prototype.close = async function(this: any) {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) { this.emitClose(); return; }
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(grace); clearTimeout(deadline);
        child.off('close', onClose); child.off('error', onError);
        error ? reject(error) : resolve();
      };
      const kill = () => { try { child.kill(); } catch { /* The helper already exited. */ } };
      const onClose = () => finish();
      const onError = (error: Error) => {kill(); finish(error);};
      const grace = setTimeout(kill, 200);
      const deadline = setTimeout(() => {
        kill(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        this.emitClose(); finish(new Error('The Windows connected tool did not finish stopping.'));
      }, 5000);
      child.once('close', onClose); child.once('error', onError);
      child.stdin?.end();
    });
  };
  installed = true;
}

function commandPath(command: string, cwd: string, configured: Record<string, string> = {}): string {
  command = expandHome(command);
  validateFilePath(command);
  // Windows environment names ignore case. Resolve through the same effective
  // server PATH that the transport will inherit, before escaping literal '$'.
  const lookup = (env: NodeJS.ProcessEnv) => Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1];
  const path = (lookup(configured) ?? lookup(process.env) ?? '').split(';').filter(Boolean);
  const candidates = isAbsolute(command) || /[\\/]/.test(command) ? [resolve(cwd, command)] : path.map(root => resolve(cwd, root.replace(/^"(.*)"$/, '$1'), command));
  for (const candidate of candidates) for (const suffix of extname(candidate) ? [''] : ['.exe', '.com', '.cmd', '.bat']) {
    const file = candidate + suffix;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`The connected-tool command could not be found: ${command}`);
}

export function windowsMcpServer(entry: any, cwd: string): any {
  if (process.platform !== 'win32' || typeof entry.command !== 'string') return entry;
  const helper = process.env.HEXBOT_DAEMON_EXECUTABLE;
  if (!helper || !isAbsolute(helper) || !existsSync(helper)) throw new Error('Update or repair Hexbot before starting Windows connected tools.');
  let program = /^(node|node\.exe)$/i.test(entry.command) ? process.execPath : commandPath(entry.command, resolve(cwd, expandHome(entry.cwd ?? '.')), entry.env);
  let args = entry.args ?? [];
  const extension = extname(program).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    const name = program.slice(program.lastIndexOf('\\') + 1, -extension.length).toLowerCase();
    if (name !== 'npm' && name !== 'npx') throw new Error('Windows connected tools require a native executable or a Node script.');
    const script = [join(dirname(program), `node_modules/npm/bin/${name}-cli.js`), join(dirname(program), `../node_modules/npm/bin/${name}-cli.js`), join(dirname(program), `../npm/bin/${name}-cli.js`)].find(existsSync);
    if (!script) throw new Error(`The ${name} Node script could not be found. Update or repair Node.js.`);
    args = [resolve(script), ...args]; program = process.execPath;
  } else if (['.js', '.mjs', '.cjs'].includes(extension)) {
    args = [program, ...args]; program = process.execPath;
  } else if (!['.exe', '.com'].includes(extension)) throw new Error('Windows connected tools require a native executable or a Node script.');
  return {...entry, command:helper, args:['__sandbox', '--unconfined', '--', program, ...args]};
}
