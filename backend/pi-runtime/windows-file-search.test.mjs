import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {searchWorkerSource} from './windows-file-search.mjs';

const sdk = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
function searchExecutable() {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const directories = process.env.HEXBOT_TEST_SEARCH_BIN ? [process.env.HEXBOT_TEST_SEARCH_BIN] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const source = directories.map(directory => join(directory, name)).find(existsSync);
  assert(source, 'Stage the pinned search tools in HEXBOT_TEST_SEARCH_BIN, or install ripgrep on PATH. The search test runs offline.');
  return {name, source};
}

test('one-shot search preserves SDK results and exact Unicode paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hexbot-search-worker-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const work = join(root, 'space\u00a0name 🦉 & $'), agent = join(root, 'agent');
  mkdirSync(work); mkdirSync(agent);
  mkdirSync(join(agent, 'bin'));
  const executable = searchExecutable();
  copyFileSync(executable.source, join(agent, 'bin', executable.name));
  writeFileSync(join(work, 'plain.txt'), 'first needle\nsecond needle\n');
  writeFileSync(join(work, 'ignored.txt'), 'needle ignored\n');
  writeFileSync(join(work, '.ignore'), 'ignored.txt\n');
  // Both calls use the installed SDK and actual ripgrep. This verifies the
  // wire boundary without presenting a Unix run as Windows containment proof.
  const previous = {PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR, PI_OFFLINE:process.env.PI_OFFLINE};
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_OFFLINE = '1';
  t.after(() => {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}});
  const {createGrepTool} = await import('@earendil-works/pi-coding-agent');
  const args = {pattern:'needle', path:work, context:1, limit:10};
  const baseline = await createGrepTool(work).execute('baseline', {...args, path:pathToFileURL(work).href});
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', searchWorkerSource], {
    cwd:work, env:{...process.env, PATH:'', PI_CODING_AGENT_DIR:agent, PI_OFFLINE:'1'}, encoding:'utf8', timeout:30000,
    input:JSON.stringify({sdk, name:'grep', cwd:work, args}),
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout).result, JSON.parse(JSON.stringify(baseline)));
  assert.match(child.stdout, /plain.txt/);
  assert.doesNotMatch(child.stdout, /needle ignored/);
});

test('search worker bounds requests and rejects unsupported tools', () => {
  const run = input => spawnSync(process.execPath, ['--input-type=module', '-e', searchWorkerSource], {input, encoding:'utf8', timeout:30000});
  const large = run('x'.repeat(256 * 1024 + 1));
  assert.notEqual(large.status, 0);
  assert.match(large.stderr, /Search request exceeds 256 KiB/);
  const unknown = run(JSON.stringify({sdk, name:'bash', cwd:process.cwd(), args:{}}));
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).error, 'Unsupported file search');
});

test('a missing managed binary fails offline without searching project PATH or downloading', t => {
  const root = mkdtempSync(join(tmpdir(), 'hexbot-search-missing-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  writeFileSync(join(root, 'plain.txt'), 'needle');
  // A real executable in the project must not satisfy a missing managed tool,
  // even on Windows where process creation also searches its working directory.
  const executable = searchExecutable();
  copyFileSync(executable.source, join(root, executable.name));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "globalThis.fetch=()=>{process.stderr.write('unexpected download');process.exit(77)};\n" + searchWorkerSource], {
    cwd:root, env:{...process.env, PATH:'', PI_CODING_AGENT_DIR:join(root, 'empty-agent'), PI_OFFLINE:'1'}, encoding:'utf8', timeout:30000,
    input:JSON.stringify({sdk, name:'grep', cwd:root, args:{path:root, pattern:'needle'}}),
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(JSON.parse(child.stdout).error, /managed search binary is unavailable/);
  assert.doesNotMatch(child.stderr, /unexpected download/);
});

test('production Windows search refuses unavailable OS containment', {skip:process.platform !== 'win32'}, t => {
  // No call may use the experimental native helper behind production's
  // explicit availability boundary, including a search with an SMB ignore path.
  const root = mkdtempSync(join(tmpdir(), 'hexbot-search-unavailable-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  // An isolated probe cache and missing helper keep this test meaningful when
  // a supported backend becomes available on other Windows installations.
  const source = `import assert from 'node:assert/strict';
const {executeWindowsFileSearch} = await import(${JSON.stringify(new URL('./windows-file-search.mjs', import.meta.url).href)});
await assert.rejects(executeWindowsFileSearch('grep', process.cwd(), ${JSON.stringify({pattern:'needle', path:'\\\\127.0.0.1\\hexbot-negative-probe\\.gitignore'})}, {home:process.cwd()}), /needs OS containment/);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {cwd:root, env:{...process.env, HEXBOT_DAEMON_EXECUTABLE:join(root, 'missing.exe')}, encoding:'utf8', timeout:30000});
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
