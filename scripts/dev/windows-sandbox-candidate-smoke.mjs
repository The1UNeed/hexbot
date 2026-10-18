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
import { fileURLToPath } from 'node:url';

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
const tokenFixture = fileURLToPath(new URL('./fixtures/windows-psec-token-probe.py', import.meta.url));
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
const hostEnv = { ...process.env, HEXBOT_PSEC_HOST_SECRET: randomUUID(), MXC_DACL_STATE_DIR: state, PSModulePath: path.join(system, 'System32/WindowsPowerShell/v1.0/Modules') };
let ownerSid;
function protectPrivate(file) {
  const result = spawnSync(path.join(system, 'System32/icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${ownerSid}:F`, '*S-1-5-18:F'], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 15_000 });
  assert.equal(result.status, 0, `Cannot create a private native output fixture: ${JSON.stringify({ status: result.status, error: result.error?.stack, stdout: result.stdout, stderr: result.stderr })}`);
}
async function privateAtomicOutput(file, contents) {
  const temporaryFile = path.join(path.dirname(file), `.private-output-${randomUUID()}`);
  await fs.writeFile(temporaryFile, '');
  protectPrivate(temporaryFile);
  await fs.writeFile(temporaryFile, contents);
  await fs.rename(temporaryFile, file);
}
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
  ui: { disable: false, clipboard: 'none', injection: false },
  processContainer: { leastPrivilege: false, capabilities: [], ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false } },
  telemetry: { enabled: false },
});
const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
const encoded = value => Buffer.from(value, 'utf16le').toString('base64');
const fixedAclPaths = [work, path.join(work, 'plain.txt'), path.join(work, '.env'), path.join(work, '.git'), path.join(work, '.git/config'), home, path.join(home, 'auth.json'), outputs, path.join(outputs, 'initial.txt'), privateRoot, privateFile, path.join(work, 'hardlink-alias.txt'), python, path.dirname(python), powershell, path.dirname(powershell), process.execPath, path.dirname(process.execPath)];
// Capture platform support before host inspectors, so an inspector failure can
// never hide the actual VM's PSEC capability evidence.
const probe = spawnSync(mxc, ['--probe', '--config-base64', base64(config())], { encoding: 'utf8', windowsHide: true, cwd: work, env: hostEnv, timeout: 20_000 });
await fs.writeFile(path.join(evidence, 'psec-probe.stdout.log'), probe.stdout ?? '');
await fs.writeFile(path.join(evidence, 'psec-probe.stderr.log'), probe.stderr ?? '');
await fs.writeFile(path.join(evidence, 'psec-probe-process.json'), JSON.stringify({ status: probe.status, signal: probe.signal, error: probe.error?.stack }, null, 2));
let capabilities;
try {
  capabilities = JSON.parse((probe.stdout ?? '').replace(/^\uFEFF/, '').trim());
  await fs.writeFile(path.join(evidence, 'psec-probe.json'), JSON.stringify(capabilities, null, 2));
} catch { /* The assertion below reports malformed output with native details. */ }
const identity = spawnSync(path.join(system, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 10_000 });
assert.equal(identity.status, 0, `Cannot identify the fixture owner: ${identity.error ?? identity.stderr}`);
ownerSid = identity.stdout.trim().match(/"(S-1-\d+(?:-\d+)+)"\s*$/)?.[1];
assert(ownerSid, 'The native fixture owner SID was not returned');
for (const file of [path.join(outputs, 'initial.txt'), path.join(outputs, '.env'), path.join(home, 'auth.json'), privateFile]) protectPrivate(file);
function aclSnapshot() {
  const script = String.raw`import ctypes as c,json,sys
from ctypes import wintypes as w
a=c.WinDLL('advapi32',use_last_error=True);k=c.WinDLL('kernel32',use_last_error=True)
a.GetNamedSecurityInfoW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD]+[c.POINTER(c.c_void_p)]*5
a.GetNamedSecurityInfoW.restype=w.DWORD
a.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes=[c.c_void_p,w.DWORD,w.DWORD,c.POINTER(c.c_void_p),c.POINTER(w.DWORD)]
a.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype=w.BOOL
k.LocalFree.argtypes=[c.c_void_p];k.LocalFree.restype=c.c_void_p
out={}
for p in json.loads(sys.argv[1]):
    sd=c.c_void_p();text=c.c_void_p()
    status=a.GetNamedSecurityInfoW(p,1,4,None,None,None,None,c.byref(sd))
    if status: raise OSError(status,'GetNamedSecurityInfoW '+p)
    try:
        if not a.ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,4,c.byref(text),None): raise c.WinError(c.get_last_error())
        out[p]=c.wstring_at(text)
    finally:
        if text:k.LocalFree(text)
        if sd:k.LocalFree(sd)
print(json.dumps(out))
`;
  const result = spawnSync(python, ['-B', '-X', 'utf8', '-c', script, JSON.stringify(fixedAclPaths)], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 20_000 });
  assert.equal(result.status, 0, `Cannot capture native ACL evidence: ${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.stack, stdout: result.stdout, stderr: result.stderr })}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
const before = aclSnapshot();
await fs.writeFile(path.join(evidence, 'acl-before.json'), JSON.stringify(before, null, 2));
const token = spawnSync(python, ['-B', '-c', "import ctypes;print('true' if ctypes.WinDLL('shell32').IsUserAnAdmin() else 'false')"], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 20_000 });
assert.equal(token.status, 0, `Cannot inspect the Windows token: ${JSON.stringify({ status: token.status, signal: token.signal, error: token.error?.stack, stdout: token.stdout, stderr: token.stderr })}`);
assert(['true', 'false'].includes(token.stdout.trim()), 'Windows token inspection returned an invalid result');
const tokenIsAdmin = token.stdout.trim() === 'true';
await fs.writeFile(path.join(evidence, 'host.json'), JSON.stringify({ tokenIsAdmin, arch: process.arch, release: os.release(), version: os.version() }, null, 2));
if (process.env.HEXBOT_REQUIRE_STANDARD_USER === '1') assert.equal(tokenIsAdmin, false, 'The standard-user proof must run without an administrator token');
const reports = [];
const active = new Set();
const runs = [];
const failures = [];
const ownedProcesses = new Map();
const cleanupObservations = [];
function trackProcess(pid, started) {
  assert(Number.isInteger(pid) && pid > 4 && pid <= 0xffffffff && pid !== process.pid, 'The child returned an invalid owned PID');
  assert(typeof started === 'string' && /^\d+$/.test(started), 'The child must return its process creation identity');
  ownedProcesses.set(pid, { pid, started });
}
function cleanupOwnedProcesses() {
  if (!ownedProcesses.size) return;
  const result = hostPython(String.raw`import ctypes as c,json,sys
from ctypes import wintypes as w
k=c.WinDLL('kernel32',use_last_error=True);FT=w.DWORD*2
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=c.c_void_p
k.CloseHandle.argtypes=[c.c_void_p];k.CloseHandle.restype=w.BOOL
k.GetProcessTimes.argtypes=[c.c_void_p]+[c.POINTER(FT)]*4;k.GetProcessTimes.restype=w.BOOL
k.GetExitCodeProcess.argtypes=[c.c_void_p,c.POINTER(w.DWORD)];k.GetExitCodeProcess.restype=w.BOOL
k.TerminateProcess.argtypes=[c.c_void_p,w.UINT];k.TerminateProcess.restype=w.BOOL
k.WaitForSingleObject.argtypes=[c.c_void_p,w.DWORD];k.WaitForSingleObject.restype=w.DWORD
out=[]
for item in json.loads(sys.argv[1]):
    h=k.OpenProcess(0x101001,False,item['pid'])
    if not h:
        error=c.get_last_error()
        if error==87:out.append({'pid':item['pid'],'gone':True});continue
        raise c.WinError(error)
    try:
        created,exit,kernel,user=FT(),FT(),FT(),FT();status=w.DWORD()
        if not k.GetProcessTimes(h,c.byref(created),c.byref(exit),c.byref(kernel),c.byref(user)):raise c.WinError(c.get_last_error())
        actual=str((created[1]<<32)|created[0])
        if actual!=item['started']:out.append({'pid':item['pid'],'reused':True});continue
        if not k.GetExitCodeProcess(h,c.byref(status)):raise c.WinError(c.get_last_error())
        if status.value!=259:out.append({'pid':item['pid'],'gone':True});continue
        if not k.TerminateProcess(h,125):raise c.WinError(c.get_last_error())
        if k.WaitForSingleObject(h,5000)!=0:raise RuntimeError('Owned child did not terminate')
        out.append({'pid':item['pid'],'forcedCleanup':True})
    finally:k.CloseHandle(h)
print(json.dumps(out))
`, [JSON.stringify([...ownedProcesses.values()])]);
  cleanupObservations.push(...JSON.parse(result));
}
async function checked(label, operation) {
  const first = runs.length;
  try { await operation(); } catch (error) {
    failures.push({ label, error: error.stack ?? String(error) });
    for (const run of runs.slice(first)) if (!run.closed()) run.child.kill('SIGKILL');
    await Promise.allSettled(runs.slice(first).map(run => complete(run, 10_000)));
    cleanupOwnedProcesses();
  }
}
function hostPython(script, args = []) {
  const result = spawnSync(python, ['-B', '-X', 'utf8', '-c', script, ...args], { encoding: 'utf8', windowsHide: true, env: hostEnv, timeout: 20_000 });
  assert.equal(result.status, 0, `Trusted host fixture failed: ${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.stack, stdout: result.stdout, stderr: result.stderr })}`);
  return result.stdout.trim();
}
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
async function waitOutput(run, marker, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (run.output().stdout.includes(marker)) return;
    assert(!run.closed() && !run.output().spawnError, `Workload exited before ${marker}: ${JSON.stringify(run.output())}`);
    await delay(10);
  }
  throw new Error(`Workload did not return ${marker}: ${JSON.stringify(run.output())}`);
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
const creationIdentity = String.raw`import ctypes as c
FT=c.c_uint32*2
process_times=c.WinDLL('kernel32',use_last_error=True).GetProcessTimes
process_times.argtypes=[c.c_void_p]+[c.POINTER(FT)]*4
process_times.restype=c.c_int32
def identity(handle):
    created,exited,kernel,user=FT(),FT(),FT(),FT()
    if not process_times(handle,c.byref(created),c.byref(exited),c.byref(kernel),c.byref(user)):raise c.WinError(c.get_last_error())
    return str((created[1]<<32)|created[0])
`;
const pythonProof = creationIdentity + String.raw`import errno,json,os,pathlib,socket,subprocess,sys,time
work,home,outputs,external=map(pathlib.Path,sys.argv[1:5])
mode,hostport,signal=sys.argv[5],int(sys.argv[6]),sys.argv[7]
assert 'HEXBOT_PSEC_HOST_SECRET' not in os.environ,'host environment secret was inherited'
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
    for p in (work/'.env',work/'.git/config',home/'auth.json',outputs/'.env'):
        denied(lambda p=p:p.rename(p.with_name(p.name+'.moved')),'protected rename '+str(p))
        denied(lambda p=p:p.unlink(),'protected unlink '+str(p))
    for p in (work/'.git',home,external.parent):
        denied(lambda p=p:p.rename(p.with_name(p.name+'.moved')),'protected directory rename '+str(p))
if mode=='auto':
    (work/'ordinary-created.txt').write_text('ok')
    (outputs/'initial.txt').write_text('updated')
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
print('HEXBOT_PSEC_READY '+json.dumps({'port':port,'pid':child.pid,'started':identity(c.c_void_p(int(child._handle))),'parent':os.getpid(),'parentStarted':identity(c.c_void_p(-1))}),flush=True)
deadline=time.monotonic()+15
while not (outputs/(signal+'.host-checked')).exists():
    if time.monotonic()>deadline: raise AssertionError('host did not finish network proof')
assert (outputs/(signal+'.incoming')).read_text()=='native-output'
server.close()
print('HEXBOT_PSEC_PYTHON_OK '+mode,flush=True)
`;

let host, pipeHost, registryFixture;
try {
  assert.equal(probe.status, 0, `PSEC capability probe failed: ${probe.error ?? probe.stderr}`);
  assert(capabilities, `PSEC capability probe returned invalid JSON: ${probe.stdout}`);
  assert.equal(capabilities.tier, 'base-container', 'This proof requires PSEC, never AppContainer/DACL/BFS fallback');
  assert.equal(capabilities.needsDaclAugmentation, false, 'PSEC proof must not mutate host DACLs');
  assert.equal(capabilities.probes?.baseContainerApiPresent, true, 'BaseContainer API is required');
  assert.equal(capabilities.probes?.baseContainerSupportsDenyPaths, true, 'PSEC deny-path support is required');
  assert(!capabilities.error, `Capability probe reported an error: ${capabilities.error}`);

  await checked('persistent-python-stdio', async () => {
    const persistentPolicy = config();
    persistentPolicy.process.timeout = 0;
    const persistent = start('persistent-python-stdio', persistentPolicy, python, ['-u', '-B', '-c', "import json,sys;print('HEXBOT_PSEC_READY '+json.dumps({'persistent':True}),flush=True)\nfor line in sys.stdin:\n item=json.loads(line);print('HEXBOT_PSEC_ECHO '+item['id'],flush=True)"]);
    await waitReady(persistent);
    persistent.child.stdin.write(`${JSON.stringify({ id: 'first' })}\n`);
    await waitOutput(persistent, 'HEXBOT_PSEC_ECHO first');
    persistent.child.stdin.write(`${JSON.stringify({ id: 'second' })}\n`);
    await waitOutput(persistent, 'HEXBOT_PSEC_ECHO second');
    persistent.child.stdin.end();
    assert.equal((await complete(persistent)).code, 0, 'The persistent Python protocol did not end cleanly');
  });
  await checked('native-node-startup', async () => {
    const nodePolicy = config();
    nodePolicy.filesystem.readonlyPaths.push(path.dirname(process.execPath));
    const node = await complete(start('native-node-startup', nodePolicy, process.execPath, ['-e', "const fs=require('node:fs');if(fs.readFileSync(process.argv[1],'utf8')!=='ordinary')throw Error('read failed');console.log('HEXBOT_PSEC_NODE_OK')", path.join(work, 'plain.txt')]));
    assert.equal(node.code, 0, JSON.stringify(node));
    assert(node.stdout.includes('HEXBOT_PSEC_NODE_OK'), 'A positive native Node execution marker is required');

  });
  for (const writable of [false, true]) {
    const mode = writable ? 'auto' : 'manual';
    await checked(`python-startup-${mode}`, async () => {
      const positive = await complete(start(`python-startup-${mode}`, config(writable), python, ['-B', '-c', "import pathlib,sys;assert pathlib.Path(sys.argv[1]).read_text()=='ordinary';print('HEXBOT_PSEC_STARTUP_OK',flush=True)", path.join(work, 'plain.txt')]));
      assert.equal(positive.code, 0, JSON.stringify(positive));
      assert(positive.stdout.includes('HEXBOT_PSEC_STARTUP_OK'), 'The Python startup control must execute');
    });
  }
  await checked('token-process-registry-pipe', async () => {
    const fixtureId = randomUUID();
    const registryKey = `Software\\HexbotTests\\${fixtureId}`;
    const registryValue = `canary-${randomUUID()}`;
    const pipeName = `\\\\.\\pipe\\HexbotPsec-${fixtureId}`;
    const hostControls = hostPython(String.raw`import ctypes as c,json,sys,winreg
spec=json.loads(sys.argv[1]);k=c.WinDLL('kernel32',use_last_error=True)
k.OpenProcess.argtypes=[c.c_uint32,c.c_int32,c.c_uint32];k.OpenProcess.restype=c.c_void_p
k.CloseHandle.argtypes=[c.c_void_p];k.CloseHandle.restype=c.c_int32
opened=[]
for access in [2,8,16,32,64]:
    h=k.OpenProcess(access,False,spec['hostPid'])
    if not h:raise c.WinError(c.get_last_error())
    opened.append(access);k.CloseHandle(h)
with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,spec['key'],0,winreg.KEY_ALL_ACCESS) as key:
    winreg.SetValueEx(key,'secret',0,winreg.REG_SZ,spec['value'])
    assert winreg.QueryValueEx(key,'secret')[0]==spec['value']
print(json.dumps({'hostProcessAccess':opened,'registryCanaryReadable':True}))
`, [JSON.stringify({ hostPid: process.pid, key: registryKey, value: registryValue })]);
    registryFixture = { key: registryKey, value: registryValue };
    await fs.writeFile(path.join(evidence, 'token-host-controls.json'), hostControls);
    let pipeAccepts = 0;
    pipeHost = net.createServer(socket => { pipeAccepts++; socket.end('pipe-canary'); });
    pipeHost.listen(pipeName);
    await once(pipeHost, 'listening');
    const accepted = once(pipeHost, 'connection');
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      let text = '';
      socket.setTimeout(3_000, () => { socket.destroy(); reject(new Error('The private host pipe control timed out')); });
      socket.once('error', reject);
      socket.on('data', data => { text += data; });
      socket.once('end', () => {
        socket.destroy();
        if (text === 'pipe-canary') resolve();
        else reject(new Error('The private host pipe control returned an invalid canary'));
      });
    });
    await accepted;
    pipeAccepts = 0;
    const tokenPolicy = config();
    tokenPolicy.filesystem.readonlyPaths.push(path.dirname(tokenFixture));
    const tokenRun = await complete(start('token-process-registry-pipe', tokenPolicy, python, ['-B', tokenFixture, JSON.stringify({ hostPid: process.pid, hostRegistryKey: registryKey, hostRegistryValue: 'secret', pipeName })]));
    await fs.writeFile(path.join(evidence, 'token-child.stdout.json'), tokenRun.stdout);
    assert.equal(tokenRun.code, 0, JSON.stringify(tokenRun));
    const tokenReport = JSON.parse(tokenRun.stdout.trim());
    assert.equal(tokenReport.ok, true, JSON.stringify(tokenReport));
    assert.equal(tokenReport.marker, 'HEXBOT_PSEC_TOKEN_OK');
    assert.equal(tokenReport.pipe?.skipped, false, 'The named-pipe fixture must be tested');
    assert.equal(pipeAccepts, 0, 'The contained process opened the private host pipe');

  });
  let hostAccepts = 0;
  host = net.createServer(socket => { hostAccepts++; socket.destroy(); });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const hostPort = host.address().port;
  const controlAccepted = once(host, 'connection');
  assert(await hostConnection(hostPort), 'The host loopback control must be reachable outside the sandbox');
  await controlAccepted;
  hostAccepts = 0;
  for (const writable of [false, true]) {
    const mode = writable ? 'auto' : 'manual';
    await checked(`python-${mode}`, async () => {
      const signal = `${mode}-${randomUUID()}`;
      const run = start(`python-${mode}`, config(writable), python, ['-B', '-c', pythonProof, work, home, outputs, privateFile, mode, String(hostPort), signal]);
      const ready = await waitReady(run);
      trackProcess(ready.pid, ready.started);
      trackProcess(ready.parent, ready.parentStarted);
      assert.equal(hostAccepts, 0, 'The contained workload connected to the host');
      if (ready.port) assert.equal(await hostConnection(ready.port), false, 'The host reached a contained listener');
      await privateAtomicOutput(path.join(outputs, `${signal}.incoming`), 'native-output');
      await fs.writeFile(path.join(outputs, `${signal}.host-checked`), 'checked');
      const report = await complete(run);
      assert.equal(report.code, 0, JSON.stringify(report));
      assert(report.stdout.includes(`HEXBOT_PSEC_PYTHON_OK ${mode}`), 'A positive Python execution marker is required');
      await gone(ready.pid);
    });
  }

  await checked('kill-launcher', async () => {
    const cancellationId = `cancel-${randomUUID()}`;
    const cancellationScript = creationIdentity + `import json,os,pathlib,subprocess,sys,time; p=subprocess.Popen([sys.executable,'-B','-c','import time;time.sleep(300)'],creationflags=8|512); pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':p.pid,'started':identity(c.c_void_p(int(p._handle))),'parent':os.getpid(),'parentStarted':identity(c.c_void_p(-1))}));time.sleep(300)`;
    const cancellationPolicy = config(true);
    cancellationPolicy.process.timeout = 0;
    const cancellation = start('kill-launcher', cancellationPolicy, python, ['-B', '-c', cancellationScript, path.join(outputs, `${cancellationId}.json`)]);
    const cancelled = await waitFile(path.join(outputs, `${cancellationId}.json`), cancellation);
    trackProcess(cancelled.pid, cancelled.started);
    trackProcess(cancelled.parent, cancelled.parentStarted);
    cancellation.child.kill('SIGKILL');
    await complete(cancellation, 10_000);
    await gone(cancelled.pid);
    await gone(cancelled.parent);
    assert.equal(hostAccepts, 0, 'A contained process reached the host loopback listener');
  });
  await checked('powershell-manual', async () => {
    const psScript = `$ErrorActionPreference='Stop';if([IO.File]::ReadAllText(${psLiteral(path.join(work, 'plain.txt'))}) -ne 'ordinary'){throw 'read failed'};try{[IO.File]::ReadAllText(${psLiteral(path.join(work, '.env'))})|Out-Null;throw 'secret read permitted'}catch [System.UnauthorizedAccessException] {};[Console]::WriteLine('HEXBOT_PSEC_POWERSHELL_OK');exit 0`;
    const psRun = await complete(start('powershell-manual', config(), powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(psScript)]));
    assert.equal(psRun.code, 0, JSON.stringify(psRun));
    assert(psRun.stdout.includes('HEXBOT_PSEC_POWERSHELL_OK'), 'A positive PowerShell execution marker is required');

  });
  assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
} finally {
  for (const child of active) child.kill('SIGKILL');
  await Promise.allSettled(runs.map(run => complete(run, 10_000)));
  cleanupOwnedProcesses();
  await fs.writeFile(path.join(evidence, 'owned-process-cleanup.json'), JSON.stringify(cleanupObservations, null, 2));
  await fs.writeFile(path.join(evidence, 'failures.json'), JSON.stringify(failures, null, 2));
  await fs.writeFile(path.join(evidence, 'workloads.json'), JSON.stringify(reports, null, 2));
  await fs.writeFile(path.join(evidence, 'fixture.json'), JSON.stringify({ fixture, mxc, python, powershell }, null, 2));
  if (host) await new Promise(resolve => host.close(resolve));
  if (pipeHost) await new Promise(resolve => pipeHost.close(resolve));
  if (registryFixture) {
    hostPython(String.raw`import json,sys,winreg
spec=json.loads(sys.argv[1])
try:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,spec['key'],0,winreg.KEY_QUERY_VALUE) as key:
        assert winreg.QueryValueEx(key,'secret')[0]==spec['value'],'The host registry canary changed'
finally:
    winreg.DeleteKey(winreg.HKEY_CURRENT_USER,spec['key'])
`, [JSON.stringify(registryFixture)]);
  }
  const after = aclSnapshot();
  await fs.writeFile(path.join(evidence, 'acl-after.json'), JSON.stringify(after, null, 2));
  assert.deepEqual(after, before, 'PSEC changed a host filesystem DACL');
  assert.deepEqual(await fs.readdir(state), [], 'PSEC left host DACL recovery state');
  assert(!cleanupObservations.some(item => item.forcedCleanup), 'A sandbox descendant required trusted host cleanup');
  assert.equal(await fs.readFile(privateFile, 'utf8'), 'external-secret');
  assert.equal(await fs.readFile(path.join(work, '.env'), 'utf8'), 'project-secret');
  assert.equal(await fs.readFile(path.join(work, '.git/config'), 'utf8'), 'git-config');
  assert.equal(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'), 'home-config');
  if (reports.some(report => report.label === 'python-auto' && report.code === 0)) assert.equal(await fs.readFile(path.join(outputs, 'initial.txt'), 'utf8'), 'updated');
  // Keep the disposable fixture until the VM is destroyed so failed probes can
  // be investigated without changing the descriptors being measured.
}

console.log('PSEC candidate positive/negative process, filesystem, network and cancellation probes passed');
