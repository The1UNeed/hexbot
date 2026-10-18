// Candidate-only proof. This never enables Windows containment in Hexbot.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

assert.equal(process.platform, 'win32', 'Run the PSEC candidate proof on a real Windows VM');
const required = name => {
  const value = process.env[name];
  assert(value && path.isAbsolute(value), `${name} must name an absolute native executable`);
  return value;
};
const mxc = required('HEXBOT_TEST_MXC_EXECUTABLE');
const python = required('HEXBOT_TEST_PYTHON');
const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
assert(system && path.isAbsolute(system), 'SystemRoot is required');
const powershell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const evidence = path.resolve(process.env.HEXBOT_WINDOWS_PROBE_DIR ?? path.join(os.tmpdir(), `hexbot-psec-evidence-${randomUUID()}`));
await fs.mkdir(evidence, { recursive: true });
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hexbot-psec-candidate-'));
const work = path.join(fixture, 'work');
const home = path.join(work, 'hexbot-home');
const outputs = path.join(home, 'profiles/owl/artifacts');
const privateRoot = path.join(fixture, 'owner-credentials');
const privateFile = path.join(privateRoot, 'credentials');
const state = path.join(fixture, 'mxc-dacl-state');
const runtime = path.join(fixture, 'private-runtime');
const temporary = path.join(runtime, 'Temp');
for (const directory of [work, outputs, privateRoot, state, temporary, path.join(work, '.git'), path.join(runtime, 'LocalAppData')]) {
  await fs.mkdir(directory, { recursive: true });
}
await fs.writeFile(path.join(work, 'plain.txt'), 'ordinary');
await fs.writeFile(path.join(work, '.env'), 'project-secret');
await fs.writeFile(path.join(work, '.git/config'), 'git-config');
await fs.writeFile(path.join(home, 'config.yaml'), 'home-config');
await fs.writeFile(path.join(home, 'auth.json'), 'home-secret');
await fs.writeFile(path.join(outputs, 'initial.txt'), 'initial');
await fs.writeFile(path.join(outputs, '.env'), 'output-secret');
await fs.writeFile(privateFile, 'external-secret');
await fs.link(privateFile, path.join(work, 'hardlink-alias.txt'));
await fs.symlink(privateRoot, path.join(work, 'junction-alias'), 'junction');
const hostEnv = { ...process.env, MXC_DACL_STATE_DIR: state, PSModulePath: path.join(system, 'System32/WindowsPowerShell/v1.0/Modules') };
const envValue = name => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const cleanEnv = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)']
  .flatMap(name => envValue(name) ? [`${name}=${envValue(name)}`] : []);
cleanEnv.push(`LOCALAPPDATA=${path.join(runtime, 'LocalAppData')}`, `TEMP=${temporary}`, `TMP=${temporary}`, 'PYTHONNOUSERSITE=1', 'PYTHONDONTWRITEBYTECODE=1', 'PYTHONUTF8=1');
const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
const config = (writable = false) => ({
  version: '1.0.0',
  containerId: `hexbot-proof-${randomUUID()}`,
  containment: 'processcontainer',
  lifecycle: { destroyOnExit: true, preservePolicy: false },
  process: { commandLine: `${quote(python)} -c pass`, cwd: work, env: cleanEnv, inheritDefaultEnv: false, timeout: 30_000 },
  filesystem: {
    readonlyPaths: [...(writable ? [] : [work]), home, path.join(work, '.git'), path.dirname(python), path.dirname(powershell), system, runtime],
    readwritePaths: writable ? [work, temporary, outputs] : [],
    deniedPaths: [path.join(work, '.env'), path.join(home, 'auth.json'), path.join(outputs, '.env'), privateRoot],
  },
  fallback: { allowDaclMutation: false },
  network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
  ui: { disable: true, clipboard: 'none', injection: false },
  processContainer: { leastPrivilege: false, capabilities: [] },
  telemetry: { enabled: false },
});
const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
const encoded = value => Buffer.from(value, 'utf16le').toString('base64');
const fixedAclPaths = [work, path.join(work, 'plain.txt'), path.join(work, '.env'), path.join(work, '.git'), path.join(work, '.git/config'), home, path.join(home, 'auth.json'), outputs, path.join(outputs, 'initial.txt'), privateRoot, privateFile, path.join(work, 'hardlink-alias.txt')];
function aclSnapshot() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$paths=ConvertFrom-Json ${psLiteral(JSON.stringify(fixedAclPaths))};$result=@{};foreach($p in $paths){$result[$p]=(Get-Acl -LiteralPath $p).Sddl};$result|ConvertTo-Json -Compress`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 15_000 });
  assert.equal(result.status, 0, `Cannot capture native ACL evidence: ${result.stderr}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
const before = aclSnapshot();
await fs.writeFile(path.join(evidence, 'acl-before.json'), JSON.stringify(before, null, 2));
const token = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded("$ErrorActionPreference='Stop';$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity);[Console]::WriteLine($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString().ToLowerInvariant())")], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 15_000 });
assert.equal(token.status, 0, `Cannot inspect the Windows token: ${token.stderr}`);
assert(['true', 'false'].includes(token.stdout.trim()), 'Windows token inspection returned an invalid result');
const tokenIsAdmin = token.stdout.trim() === 'true';
await fs.writeFile(path.join(evidence, 'host.json'), JSON.stringify({ tokenIsAdmin, arch: process.arch, release: os.release(), version: os.version() }, null, 2));
if (process.env.HEXBOT_REQUIRE_STANDARD_USER === '1') assert.equal(tokenIsAdmin, false, 'The standard-user proof must run without an administrator token');
const reports = [];
const active = new Set();
const runs = [];
function start(label, policy, program, args) {
  const child = spawn(mxc, ['--config-base64', base64(policy), '--', program, ...args], { cwd: work, env: hostEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let stdout = '', stderr = '', closed = false, spawnError;
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => {
      closed = true;
      active.delete(child);
      const report = { label, code, signal, stdout, stderr, spawnError, policy };
      reports.push(report);
      resolve(report);
    });
  });
  const run = { child, completion, closed: () => closed, output: () => ({ stdout, stderr, spawnError }) };
  runs.push(run);
  return run;
}
async function complete(run, timeout = 40_000) {
  let timer;
  try {
    return await Promise.race([run.completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MXC workload exceeded ${timeout}ms: ${JSON.stringify(run.output())}`)), timeout); })]);
  } finally { clearTimeout(timer); }
}
async function waitFile(file, run, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (!['ENOENT', undefined].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    assert(!run.closed() && !run.output().spawnError, `Workload exited before producing ${path.basename(file)}: ${JSON.stringify(run.output())}`);
    await delay(10);
  }
  throw new Error(`Workload did not produce ${path.basename(file)}: ${JSON.stringify(run.output())}`);
}
async function waitReady(run, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const marker = run.output().stdout.split(/\r?\n/).find(line => line.startsWith('HEXBOT_PSEC_READY '));
    if (marker) return JSON.parse(marker.slice('HEXBOT_PSEC_READY '.length));
    assert(!run.closed() && !run.output().spawnError, `Workload exited before its readiness marker: ${JSON.stringify(run.output())}`);
    await delay(10);
  }
  throw new Error(`Workload did not become ready: ${JSON.stringify(run.output())}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pid) {
  const until = Date.now() + 5_000;
  while (alive(pid) && Date.now() < until) await delay(10);
  assert(!alive(pid), `Sandbox descendant ${pid} survived`);
}
async function hostConnection(port) {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = connected => { socket.destroy(); resolve(connected); };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
  });
}
const pythonProof = String.raw`import errno,json,pathlib,socket,subprocess,sys,time
work,home,outputs,external=map(pathlib.Path,sys.argv[1:5])
mode,hostport,signal=sys.argv[5],int(sys.argv[6]),sys.argv[7]
def denied(action,label):
    try: action()
    except PermissionError: return
    except OSError as e:
        if getattr(e,'winerror',None) in (5,10013): return
        raise
    raise AssertionError(label+' was permitted')
assert (work/'plain.txt').read_text()=='ordinary'
assert (work/'.git/config').read_text()=='git-config'
assert (home/'config.yaml').read_text()=='home-config'
assert (outputs/'initial.txt').read_text()=='initial'
for p in (work/'.env',home/'auth.json',outputs/'.env',external,work/'hardlink-alias.txt',work/'junction-alias/credentials'):
    denied(lambda p=p:p.read_text(),'credential read '+str(p))
for p in (work/'.git/config',home/'config.yaml',external):
    denied(lambda p=p:p.write_text('bad'),'protected write '+str(p))
if mode=='auto':
    (work/'ordinary-created.txt').write_text('ok')
    (outputs/'result.txt').write_text('result')
    (outputs/'result.txt').rename(outputs/'moved.txt')
    (outputs/'moved.txt').unlink()
else:
    denied(lambda:(work/'ordinary-created.txt').write_text('bad'),'Manual workspace write')
    denied(lambda:(outputs/'result.txt').write_text('bad'),'Manual output creation')
    denied(lambda:(outputs/'initial.txt').write_text('bad'),'Manual output modification')
client=socket.socket();client.settimeout(1.5)
try:
    client.connect(('127.0.0.1',hostport))
    raise AssertionError('sandbox reached the host listener')
except (PermissionError,TimeoutError): pass
except OSError as e:
    if getattr(e,'winerror',None) not in (10013,10060,10065,10051): raise
finally: client.close()
server=socket.socket();server.settimeout(1)
try:
    server.bind(('127.0.0.1',0));server.listen();port=server.getsockname()[1]
except PermissionError: port=0
child=subprocess.Popen([sys.executable,'-B','-c','import time; time.sleep(300)'],creationflags=0x00000008|0x00000200)
print('HEXBOT_PSEC_READY '+json.dumps({'port':port,'pid':child.pid}),flush=True)
deadline=time.monotonic()+15
while not (outputs/(signal+'.host-checked')).exists():
    if time.monotonic()>deadline: raise AssertionError('host did not finish network proof')
assert (outputs/(signal+'.incoming')).read_text()=='native-output'
server.close()
print('HEXBOT_PSEC_PYTHON_OK '+mode,flush=True)
`;

let host;
try {
  const policy = config();
  const probe = spawnSync(mxc, ['--probe', '--config-base64', base64(policy)], { encoding: 'utf8', windowsHide: true, cwd: work, env: hostEnv, timeout: 20_000 });
  await fs.writeFile(path.join(evidence, 'psec-probe.stdout.log'), probe.stdout ?? '');
  await fs.writeFile(path.join(evidence, 'psec-probe.stderr.log'), probe.stderr ?? '');
  assert.equal(probe.status, 0, `PSEC capability probe failed: ${probe.error ?? probe.stderr}`);
  const capabilities = JSON.parse(probe.stdout.replace(/^\uFEFF/, '').trim());
  await fs.writeFile(path.join(evidence, 'psec-probe.json'), JSON.stringify(capabilities, null, 2));
  assert.equal(capabilities.tier, 'base-container', 'This proof requires PSEC, never AppContainer/DACL/BFS fallback');
  assert.equal(capabilities.needsDaclAugmentation, false, 'PSEC proof must not mutate host DACLs');
  assert.equal(capabilities.probes?.baseContainerApiPresent, true, 'BaseContainer API is required');
  assert.equal(capabilities.probes?.baseContainerSupportsDenyPaths, true, 'PSEC deny-path support is required');
  assert(!capabilities.error, `Capability probe reported an error: ${capabilities.error}`);

  for (const writable of [false, true]) {
    const mode = writable ? 'auto' : 'manual';
    const positive = await complete(start(`python-startup-${mode}`, config(writable), python, ['-B', '-c', "import pathlib,sys;assert pathlib.Path(sys.argv[1]).read_text()=='ordinary';print('HEXBOT_PSEC_STARTUP_OK',flush=True)", path.join(work, 'plain.txt')]));
    assert.equal(positive.code, 0, JSON.stringify(positive));
    assert(positive.stdout.includes('HEXBOT_PSEC_STARTUP_OK'), 'The Python startup control must execute');
  }
  const psScript = `$ErrorActionPreference='Stop';if([IO.File]::ReadAllText(${psLiteral(path.join(work, 'plain.txt'))}) -ne 'ordinary'){throw 'read failed'};try{[IO.File]::ReadAllText(${psLiteral(path.join(work, '.env'))})|Out-Null;throw 'secret read permitted'}catch [System.UnauthorizedAccessException] {};[Console]::WriteLine('HEXBOT_PSEC_POWERSHELL_OK');exit 0`;
  const psRun = await complete(start('powershell-manual', config(), powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(psScript)]));
  assert.equal(psRun.code, 0, JSON.stringify(psRun));
  assert(psRun.stdout.includes('HEXBOT_PSEC_POWERSHELL_OK'), 'A positive PowerShell execution marker is required');

  let hostAccepts = 0;
  host = net.createServer(socket => { hostAccepts++; socket.destroy(); });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const hostPort = host.address().port;
  assert(await hostConnection(hostPort), 'The host loopback control must be reachable outside the sandbox');
  hostAccepts = 0;
  for (const writable of [false, true]) {
    const mode = writable ? 'auto' : 'manual';
    const signal = `${mode}-${randomUUID()}`;
    const run = start(`python-${mode}`, config(writable), python, ['-B', '-c', pythonProof, work, home, outputs, privateFile, mode, String(hostPort), signal]);
    const ready = await waitReady(run);
    assert.equal(hostAccepts, 0, 'The contained workload connected to the host');
    if (ready.port) assert.equal(await hostConnection(ready.port), false, 'The host reached a contained listener');
    await fs.writeFile(path.join(outputs, `${signal}.incoming`), 'native-output');
    await fs.writeFile(path.join(outputs, `${signal}.host-checked`), 'checked');
    const report = await complete(run);
    assert.equal(report.code, 0, JSON.stringify(report));
    assert(report.stdout.includes(`HEXBOT_PSEC_PYTHON_OK ${mode}`), 'A positive Python execution marker is required');
    await gone(ready.pid);
  }

  const cancellationId = `cancel-${randomUUID()}`;
  const cancellationScript = `import json,pathlib,subprocess,sys,time; p=subprocess.Popen([sys.executable,'-B','-c','import time;time.sleep(300)'],creationflags=8|512); pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':p.pid,'parent':__import__('os').getpid()}));time.sleep(300)`;
  const cancellationPolicy = config(true);
  cancellationPolicy.process.timeout = 0;
  const cancellation = start('kill-launcher', cancellationPolicy, python, ['-B', '-c', cancellationScript, path.join(outputs, `${cancellationId}.json`)]);
  const cancelled = await waitFile(path.join(outputs, `${cancellationId}.json`), cancellation);
  cancellation.child.kill('SIGKILL');
  await complete(cancellation, 10_000);
  await gone(cancelled.pid);
  await gone(cancelled.parent);
  assert.equal(hostAccepts, 0, 'A contained process reached the host loopback listener');
  console.log('PSEC candidate positive/negative process, filesystem, network and cancellation probes passed');
} finally {
  for (const child of active) child.kill('SIGKILL');
  await Promise.allSettled(runs.map(run => complete(run, 10_000)));
  if (host) await new Promise(resolve => host.close(resolve));
  const after = aclSnapshot();
  await fs.writeFile(path.join(evidence, 'acl-after.json'), JSON.stringify(after, null, 2));
  await fs.writeFile(path.join(evidence, 'workloads.json'), JSON.stringify(reports, null, 2));
  await fs.writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ fixture, mxc, python, powershell }, null, 2));
  assert.deepEqual(after, before, 'PSEC changed a host filesystem DACL');
  assert.deepEqual(await fs.readdir(state), [], 'PSEC left host DACL recovery state');
  assert.equal(await fs.readFile(privateFile, 'utf8'), 'external-secret');
  assert.equal(await fs.readFile(path.join(work, '.env'), 'utf8'), 'project-secret');
  assert.equal(await fs.readFile(path.join(work, '.git/config'), 'utf8'), 'git-config');
  assert.equal(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'), 'home-config');
  // Keep the disposable fixture until the VM is destroyed so failed probes can
  // be investigated without changing the descriptors being measured.
}
