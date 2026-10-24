// Real POSIX runtime-only setup and owned-daemon readiness, without a live home.
import { spawn, execFile } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This smoke test requires POSIX runtime support');
const repo = fileURLToPath(new URL('../..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'hexbot-runtime-selection-'));
const target = join(repo, 'backend/hexbot-core/target');
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let built = false;
let failure;
try {
  for (const directory of ['backend/hexbot-core', 'backend/pi-runtime', 'packaging'])
    await cp(join(repo, directory), join(scratch, directory), {
      recursive: true, filter: path => !['target', 'node_modules', '.venv'].includes(basename(path))
    });
  await mkdir(join(scratch, 'apps/desktop'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(repo, 'apps/desktop/package.json'), 'utf8'));
  for (const runNumber of ['58', '59']) {
    await writeFile(join(scratch, 'apps/desktop/package.json'), JSON.stringify({ ...manifest, version: `0.1.5-nightly.20261022.${runNumber}` }));
    await run('cargo', ['build', '--locked', '--manifest-path', join(scratch, 'backend/hexbot-core/Cargo.toml'), '--bin', 'hexbot', '--target-dir', target]);
    built = true;
    await copyFile(join(target, 'debug/hexbot'), join(scratch, `hexbot-${runNumber}`));
  }
  await run('pnpm', ['--filter', './apps/desktop', 'exec', 'vitest', 'run', 'src/main/backend/native-selection.integration.test.ts'], {
    ...process.env, HEXBOT_TEST_RUNTIME_58: join(scratch, 'hexbot-58'), HEXBOT_TEST_RUNTIME_59: join(scratch, 'hexbot-59')
  });
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    // Restore the checkout's normal development binary after fixture builds.
    if (built) {
      // Distinct fixture manifests share this output name. Cargo's other
      // fingerprint can otherwise call the overwritten binary fresh.
      await rm(join(target, 'debug/hexbot'), { force: true });
      await run('cargo', ['build', '--locked', '--manifest-path', join(repo, 'backend/hexbot-core/Cargo.toml'), '--bin', 'hexbot', '--target-dir', target]);
      const expected = JSON.parse(await readFile(join(repo, 'apps/desktop/package.json'), 'utf8')).version;
      const { stdout } = await promisify(execFile)(join(target, 'debug/hexbot'), ['version']);
      if (stdout.trim() !== expected) throw new Error('Development binary was not restored to the checkout version');
    }
  } catch (error) {
    throw failure ? new AggregateError([failure, error], 'Runtime smoke test and binary restoration failed') : error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
