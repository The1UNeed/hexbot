# Windows build and install validation

Windows is not a supported Hexbot release target. The website, release matrix,
update publishing and installer bootstrap remain unchanged. This work prepares
local packages and native CI probes. It does not provide Windows confinement.
The fail-closed execution boundary and independent GPT 6.1 and Opus 5.5 approval
are required before merge or shipping, together with native validation.

## Runtime layout

Windows x64 uses `hexbot.exe`, `hexbot-cli.exe`, `node.exe`, `pi/launch.mjs`, the locked Pi
installation, `pi/search-tools.mjs`, `bin/rg.exe`, `bin/fd.exe`, `web/` and
`skills/`. `manifest.json` records the `win32-x64` target and SHA-256 hashes.
There is no command-shell daemon launcher. Rust invokes the bundled Node with
the absolute Pi JavaScript path. macOS and Linux keep their current launchers.

Full bootstrap and Headless both run the bundle's `hexbot.exe setup --activate`.
Setup verifies the files, copies them to an immutable directory under
`runtime/native/`, and atomically writes `runtime/native-current.json` while
holding `activate.lock`. Every Windows consumer resolves its `executable`
field to a real `hexbot.exe` inside that directory. No stable EXE is overwritten,
and installation requires no symlink privilege. Source chronology prevents an
older build replacing the selected build. Repair may select the same build.
Cleanup retains the selected, previous and still-running runtimes.

On POSIX, selection still commits through `native-executable`. Activation
metadata records the exact update manifest before that symlink changes. If
interrupted there, the same verified source may retry while the older runtime
is still selected. Lower builds, different sources and equal committed updates
remain refused. Legacy pending metadata without that source identity requires
repair or a newer update. Windows metadata is itself the committed selection
and has no pending-symlink retry exception.

Python and voice tools share a managed venv under
`runtime/tools/code-python/Scripts/`. The absolute Python and edge-tts paths
are used directly, rather than copying a Python EXE away from its libraries.
The voice lock is generated from exact pins in `edge-tts.requirements.in` by
`node scripts/desktop/voice-lock.mjs --write`. The generator verifies each
supported CPython 3.11 wheel against primary PyPI metadata and its downloaded
SHA-256; `--check` audits the committed lock. The Windows wheel audit is in
`edge-tts.windows-wheels.json`. The aiohttp 3.14.4 Windows wheel is
`aiohttp-3.14.4-cp311-cp311-win_amd64.whl`, SHA-256
`2efbdb87e79d596325c4eefaef0f4495d701145e882351310ebc538e854dc7a3`.
The yarl pin is 1.25.1 to satisfy aiohttp 3.14.4's declared minimum. Native CI
installs with `--require-hashes`, then imports all 13 pinned dependencies.

Both native and Electron provisioners explicitly set `UV_LINK_MODE=copy`, so
new package installs do not share uv cache inodes. This does not establish a
race-free hard-link boundary or change permissions on legacy Python files.

## Install and update contracts

Change to Client explicitly checks service ownership before downloading and again
under the installation lock before replacement. Read-only discovery hiding an
invalid task cannot authorize that destructive action.

Full NSIS artifacts begin with `Hexbot-`; Client artifacts begin with
`HexbotClient-`. The pinned builder names uninstallers from `win.executableName`:
`Uninstall Hexbot.exe` and `Uninstall HexbotClient.exe`, including Nightly under
its separate GUID. Product display names do not select executable filenames.
The installer runs NSIS, waits for it, and checks the expected
app EXE, `resources/app.asar` and the ownership marker packaged inside NSIS
before writing its receipt. The download remains verified against the signed
install manifest. That marker survives interruption
between NSIS completion and receipt publication. Unmarked apps are not owned. Repair runs NSIS
again. A matching receipt and packaged marker allow NSIS to restore a missing
EXE or app.asar at that exact destination. Receiptless recovery still requires
a complete, uniquely identified app and reads its installed track. The completion screen uses the receipt’s owned Windows app directory
for its location and Open Hexbot action; the Tauri launcher validates ownership
and the matching Full or Client executable again. Uninstall runs the installed
NSIS uninstaller before removing leftovers.

Native updates use a ZIP whose entrypoint is `hexbot.exe`. The daemon verifies
the release signature and archive digest, rejects unsafe ZIP paths, links,
collisions and expansion limits, checks the embedded runtime hashes and probes
the real EXE's version before selecting it. Windows electron-updater metadata
is `latest.yml` or `nightly.yml`, with no `-win` suffix.
`make-install-manifest --windows-probe --allow-missing` includes Windows only
for local test trees and labels the result experimental. Normal release
manifests continue to exclude Windows.

The per-user scheduled task uses the current user's SID in its name and
principal. The registered task also records its canonical Hexbot home in the
Description, so a missing script can be repaired or uninstalled only with a
matching home, principal and action. A legacy task with neither an owned script
nor that home binding fails closed. Its action and principal both use `Owner`, with `LeastPrivilege`
and `InteractiveToken`. Task state is read numerically, without localized
status text. A hidden PowerShell wrapper reads the selected EXE for each run
and waits for the old daemon to exit before starting an updated one. The new
daemon stays inside the task's job. No breakaway child races the home lock. Stop/restart waits for both task state
and the daemon home lock. Install and repair also stop an owned existing task
and wait for that lock before replacing its script/XML and starting the selected
runtime; updating a task definition alone would keep its old instance. Uninstall treats only the numeric task-not-found
error as absent; foreign task actions/principals and permission errors fail.
Uninstall checks ownership independently of discovery, so an ownership error
cannot become a successful cleanup of runtime files or the install receipt.
An interrupted owned script/XML install can therefore be removed even when
task creation never finished. The installer uses the verified scheduler definition
to remove a task even when its selected binary is missing or selection JSON is
damaged. A direct CLI install refuses an occupied home before script/XML/task
writes; the app uses its explicit ownership handoff first.
Full's service-install IPC first stops its owned daemon, then waits for the
task daemon's home lock and identity endpoint before reporting success. Failed
installation restores app ownership or attaches to an already started service.
Concurrent app start/stop operations wait for that handoff. App stop and Quit
retain an external task daemon.
A separate native forwarding component is installed as `.local/bin/hexbot.exe`,
with a hash-bound home record in `hexbot.json`. It passes argv directly to the
canonical selected daemon. It works from cmd and Restricted PowerShell without
copying a stable daemon or requiring symlinks. Setup adds that directory to the
user PATH; uninstall removes only an entry setup added. Registration persists
an intent containing the absent-entry registry snapshot before adding PATH, then
commits ownership. Repair and uninstall recognize the exact before/after images
after interruption. Preexisting entries remain unowned. A concurrent edit while
an intent is pending refuses recovery and retains the journal, rather than
guessing whether the changed entry belongs to the user. If an interrupted
install or uninstall leaves only the validated home/hash sidecar, cleanup still
removes that metadata and its recorded PATH entry. Foreign or malformed sidecars
and unverified existing EXEs are left alone. Existing terminals need
to reopen. A verified previous compatible forwarder can remain temporarily
when Windows locks it during its own setup child; direct installer/Full setup
refreshes it after that invocation exits. The old owned `.ps1` CLI is removed.
The task launcher reads JSON explicitly as UTF-8 and resolves Windows final
paths through open handles for the containment check. An outside build junction is rejected; a home junction is resolved on
both sides. `service logs [-f]` reads both streams and follows file creation,
truncation and rotation, including Windows PowerShell's UTF-16 log encoding.

Full's owned daemon receives quit through its inherited stdin pipe, then runs
normal App/Pi and tunnel cleanup. The app waits for process exit before reuse
of its home and has a bounded force fallback. A Windows daemon retains a
non-inheritable lifetime job until process teardown, without job breakaway,
so remaining ordinary child processes are reaped on exit. This is process
lifetime management, not Windows tool confinement. Each Pi also has its own
kill-on-close job: it starts suspended, joins that job before running, and its
cleanup waits for the job to have no active processes. Closing one section does
not terminate the daemon or another section. Native probes exercise real Pi
Bash descendants and section close/rebuild; new results are required before
counting this behavior as validated. GUI-owned setup, daemon,
Pi and tunnel children use hidden-console spawn options.

Windows Repair retains the known packaged marker identity and exact managed
directory. Valid ASAR metadata must corroborate that identity's track; a mixed
identity/version is refused before download or NSIS. GUI and terminal Repair
share this rule and the same unique complete-app recovery path. An exact
receipt and matching packaged marker also retain ownership when EXE/ASAR bytes
are missing, so detection, repair and uninstall agree. Receiptless incomplete,
foreign, linked and ambiguous apps remain refused.

Windows setup rechecks selection under its own activation lock. If another
updater won the installer's lock gap, or the requested track has an older build,
setup keeps the newer runtime only when its complete manifest, file hashes and
recorded chronology agree. It still finishes tools and CLI setup; the installer
then installs the service and writes the requested-track receipt. Damaged or
inconsistent newer selections refuse repair. Automatic updates still reject
lower and equal builds. Unix descriptor handoff is unchanged.

Full serializes bootstrap, service toggles, daemon start/stop and quit. Removing
a task first stops an app-owned daemon, removes only the verified task, then
starts the app-owned daemon again. A refused operation restores that owned
process and returns the error. After bootstrap, an owned running task using an
older executable is restarted and must acquire this home with a new PID and the
selected executable before startup completes. An already-current task is left
running. Missing and foreign tasks are not restarted.

## Verification and remaining gates

`windows-contract.yml` publishes nothing and uses commit-pinned actions. Its
Client job runs the pinned electron-builder CLI through the same pnpm
entrypoint, cwd and inherited environment as `dist.mjs`, for both editions.
Its startup probe records dependency paths, argv, package-manager discovery
and raw workspace-command output, resolves hooks within the desktop project
and executes the Windows ownership hook. Source hooks live inside that project;
they do not depend on the builder discovering the monorepo root. The startup
probe deliberately stops before packaging. The job then builds real NSIS and tests installation, repair and uninstall with
a signed local manifest. The native job checks unchanged production source
and requires Cargo's only error to be the exact unsupported-platform guard.
Any other compiler error fails the job. The security stage's shared helper
then prepares a disposable worktree from explicit immutable build and security
SHAs, records both source trees and guard hashes, and removes only the exact
guard there. No disposable binary is uploaded. The production guard remains.
Complete build/security trees select the exact event commit twice with
`--current-tree`, and the helper must preserve its exact guarded tree. A
standalone security commit or intermediate security squash instead records
exactly one trailer in its immutable commit message:

```text
Hexbot-Windows-Build: <full lowercase 40-character build commit SHA>
```

The recorded build must contain the build and refusal interfaces. Historical
combination also requires the reviewed dependency ancestry and a unique merge
base; any patch conflict fails. The workflow contains no particular build pin.
After that build exists, a metadata-only security commit can carry the trailer
without changing the security source tree. The same validated trailer must be
preserved in the security squash message. This avoids replaying full build
diffs onto stale source and avoids a self-referential workflow pin.
The disposable steps stage real Node/Pi, run Full bootstrap and Headless setup in temporary state, exercise
Pi RPC, Python, web serving and task lifecycle, install Full NSIS, and validate
a signed native ZIP update plus the pinned cloudflared executable. Exact ignored
NSIS and ZIP/Connect selections require one executed, passed test; zero matches
or an ignored result fail the job. Native UV repair also exercises the actual
installer replacing ordinary existing bytes with missing, malformed or stale
receipts. This does not claim replacement of a running or read-only executable. Native
regressions also exercise Unicode and junction homes, outside junction refusal,
the activation-lock rollback floor and both service log streams. Dedicated
probes also cover Restricted PowerShell/CMD argument propagation, real 8.3
aliases where the volume supplies them, interrupted task cleanup, foreign
actions, Tauri app detachment, and owned Full quit/EOF/force cleanup with a real
Runtime-owned Pi child and a descendant.
The shutdown fixture binds each run to a fresh mode/nonce, waits for descendant
startup and a real Pi RPC response, and retains kernel process handles before
Pi can reply or exit. Lifecycle/CIM/exit-code diagnostics distinguish startup
failure from cleanup; no production Pi stderr is captured or relaxed.
A separate native supervisor probe
starts/stops a local tunnel metrics fixture twice through real services cleanup.
It does not prove live Cloudflare enrollment. A volume without distinct 8.3 names
reports that case as unproved.

A cross-compile on macOS is only a compile check. It cannot establish native
NSIS, task, Electron GUI, job lifetime, console or standard-user behavior.
Windows CI must pass on the combined implementation and security changes.
The native matrix includes actual installed Client/Full GUI activation. Its
Rust probe requires the GUI harness, validates absolute regular files, and logs
bounded program/argv diagnostics. The harness passes its own running Node
`process.execPath`, rather than converting command-discovery output into an
environment path. A native preflight checks ordinary/verbatim Node paths and
Unicode/space/metacharacter argv before the GUI launch. It also includes a
version-changing signed ZIP update between two debug fixture daemons, followed
by task stop and process/home-lock assertions. The same two versions also
exercise the installer engine’s Headless update and repair path, checking that
each replaces the old task PID and runs the selected version. Both track
directions also perform real Full-to-Headless Change and repair while retaining
a verified newer runtime, checking the task, requested-track receipt and old app
removal. Installed Full relaunch uses distinct immutable builds of the same
binary version to check bundled chronology activation and task PID/executable
handoff; another unchanged launch must retain that PID. Separate native
installer probes cover config-only CLI cleanup and PATH retention for foreign
or malformed sidecars. The existing public test key
stays confined to debug builds; fixture versions use the version tool only in
the disposable source and restore the original bytes. These checks and the
security stage's standard-user probes must pass before any availability claim.

## Upstream tool pins

Windows SHA-256 values were checked against the primary release assets and
GitHub release metadata for [uv 0.12.18](https://github.com/astral-sh/uv/releases/tag/0.12.18),
[ripgrep 15.2.0](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0),
[fd 10.5.0](https://github.com/sharkdp/fd/releases/tag/v10.5.0) and
[cloudflared 2026.8.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.0).
Node uses the Windows x64 ZIP digest from
[Node 22.23.3 SHASUMS256](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt).
The uv ZIP is flat; rg and fd have a top-level release directory.

The 49f native run checked merge `0b6cb125` with the exact 49f source tree. It
passed the initial MSVC and task/PATH/CLI checks, then failed the final staging
directory rename with EPERM, before bootstrap or the new Pi fixture ran.
Publication now reports bounded directory metadata on failure and still throws
the original error; there is no retry or success fallback. The locking source is
not established. Staging publication, bootstrap, installed GUI, signed ZIP,
Connect, update/restart and lifecycle still need a successful native run.

The 659 native run passed initial MSVC/launcher checks, then failed the
foreign-task installer negative case because uninstall returned zero. The 2ce
run proved the correction: nonzero JSON refusal, unchanged scheduler definition,
script/XML/receipt/runtime, and successful owned-script/absent-task cleanup.
It then stopped before the occupied-home assertion because the fixture daemon
had no Pi launcher. The early fixture now receives the running CI Node, imports
the real locked Pi, checks its version and requires actual daemon readiness.
The new native activation/service, installed GUI, signed ZIP/Connect and later
lifecycle cases still require a successful run. Local host tests and Windows
cross-compilation do not establish those results.

The e203 run tested merge `302c30e1` with the exact e203 guarded/probe trees
`7e5a44b8` / `7e199796`. Foreign installer refusal and the absent-task control
passed, and the real pinned Pi fixture reached occupied-home readiness and
refusal. The first task became ready; later missing-script repair timed out
after a live definition replacement. That log does not establish whether the
scheduler state, task/child lifetime or lock probe caused the timeout. The
controller now asks the verified scheduler object to stop regardless of a prior
state snapshot; only the precise not-running HRESULT is harmless. Lock probes
share error classification rather than treating every I/O error as contention.
Opt-in CI snapshots record registered/live task instances, definition, current
process/parent/children/SID, Rust and PowerShell lock observations and retained
kernel-handle exit codes. A plain missing-script control runs before the live
re-registration case. Both must prove old-process exit before repair returns;
the timeout is unchanged. Actual Windows results remain pending.

Full startup uses the same repair-capable service install operation after its
scheduler/home/PID checks, so a verified task with a deleted script can recover.
The installed Full relaunch probe deletes that script and requires exact owned
script restoration, old PID exit and the new selected runtime. Foreign/unbound
refusals and the unchanged-build PID control remain mandatory.

Windows app readiness does not read the held lock's PID bytes. It probes the
lock range and retains a kernel process handle while checking the process
owner, HTTP install ID/PID and unchanged running/port metadata. The executable
must resolve inside this home's canonical managed runtime and match the live
process image. A held home with unreadable, stale or inconsistent evidence is
an error, never permission to spawn or stop a process. The daemon republishes
its running record after HTTP startup so event-based observers can check again.
The task fixture also binds that process to the verified scheduler instance and
excludes prior desktop/task PIDs. The a305 native run failed before either
repair because its old fixture accepted an exited PID from a retained record;
the historical log does not identify that PID as the desktop fixture. New
explicit desktop identity and retained-handle checks still need native execution.

Service ownership transitions revoke pending crash retries before entering the
serialized operation. Recovery retains the intent to own a daemon even during
backoff; dequeued callbacks must still hold the current retry generation. The
Windows terminal answer uses BOMless UTF-8 independently of the console code
page. Build commands recognize Corepack's explicit JavaScript entrypoint and
invoke it through Node with literal argument arrays, without executing shims.

The ee417 native run tested merge `8ab84b09` with the exact ee417 trees
`7701033e` / `87b09b82`. It proved desktop PID 2536 exited zero while leaving
its stale record, then authenticated task daemon 9036 through retained kernel
creation identity, task instance, SID, canonical image and HTTP home identity.
Plain missing-script repair stopped PowerShell 3464 but left the same daemon
9036 alive with its home locked. This establishes a service-creator lifetime
failure before any definition replacement. Later Full/NSIS/update/Connect
stages did not run.

A Windows service daemon now retains its actual creator's kernel handle after
checking canonical System32 PowerShell, owner SID, creation chronology and live
identity. An unverifiable creator fails startup. Creator exit enters the existing
App/Pi/tunnel cleanup; a ten-second watchdog can terminate only this daemon
with exit 124 if cleanup hangs. Normal cleanup must exit zero. The existing
daemon job reaps remaining owned descendants. Desktop and Unix shutdown paths
are unchanged. Native creator exit/kill/acquisition-race/watchdog controls,
actual scheduler missing-script repairs and real Pi/tool cleanup with a second
daemon alive remain required evidence.

Every service launch validates or creates an ordinary canonical log directory
before redirection, rejects linked or wrong-type log paths, and opens logs
without truncation while errors still terminate launch. Windows PowerShell 5.1
redirection explicitly uses UTF-8. Repair uses the exact receipt for ownership
and option, and the known marker identity for the track. Ordinary corrupt or
missing ASAR metadata allows an explicitly announced marker-track repair only
with that receipt. Access errors, wrong types/reparse points, mixed valid
identity/version and ambiguous ownership refuse. Explicit Change and signed
verification/rollback floors are unchanged.

NSIS GUIDs are verified against pinned app-builder-lib 26.16.1. The x64 template
reads the 64-bit registry view in HKCU/HKLM during initialization. Install and
uninstall now preflight both scopes read-only, requiring complete registrations
bound to the canonical exact identity directory and a quoted ordinary known
uninstaller with only /currentuser. Foreign, partial and machine/allusers
collisions refuse before NSIS; no keys or old uninstallers are manually removed.
Both operations pass /currentuser explicitly. Native Stable and Nightly Full and
Client probes require running-original refusal, registry-collision preservation,
corrupt-payload restoration, repeat Repair and normal NSIS registration removal.
These new identity cases remain pending actual native execution.

The earlier stable-marker/nightly-ASAR fixtures modeled a mixed install, not a
normal updater transition. Pinned electron-updater 6.8.9 only passes /D when
installDirectory is configured; Hexbot does not set it. A Settings track switch
can therefore install the other GUID under LocalAppData/Programs while leaving
the original install/receipt. That Programs install is outside this installer's
managed discovery and is not migrated or removed by Repair. This remains a
Windows unsupported-product limitation; no Settings, GUID or channel policy is
changed here.

Native 35f0 run 39876584756, job 120163547201, proved actual creator exit/kill
zero cleanup, the distinct watchdog124/acquisition101 controls, both scheduler
missing-script/re-registration repairs with old process exit before return,
removed-log-directory launch/restart and CLI/PATH recovery. The later Full
publication rename still failed with EPERM and an absent destination. Cause is
unproved. Publication still fails with its original error and no retry/copy
fallback. Read-only file/process/Restart Manager diagnostics and deterministic
held-CWD plus real pinned Node/Pi publication probes now run before Full build.
No fixture-leaf proof is counted as actual Pi/tool cleanup.

Native 5e985 tested merge `2a951db24f6583481b7edd9ca1d8a404174dde4a` with
its exact source/probe trees. Client job 120201571138 used libarchive 3.8.9;
runtime job 120201570931 used 3.8.4. In each job, the same 646-byte ZIP and
digest passed ASCII-filename extraction with Unicode cwd, exit zero, exact
entrypoint bytes, manifest hash and unpacked size. The diagnostic stdin ZIP
mode exited one with no write error and only `tar.exe: (null)` plus a delayed
error message. The third-party cause remains unproved; no stdin fix is claimed.

The required ZIP roundtrip follows product consumers: standalone Node and
desktop tool installs pass archive filenames; setup, installer and native
self-update use the shared Rust `ZipArchive` reader over a file. The separate
skill-history stdin call consumes Git TAR output, not ZIP. No product ZIP
consumer uses tar stdin, so that diagnostic mode is outside the required build contract.
The filename roundtrip retains Unicode, exit-zero, digest/bytes/size and
missing-entrypoint checks, along with bounded command capture. The real signed
native ZIP/update probe remains mandatory.

The 5e985 runtime job also passed all three real pinned Node/Pi version-process
publication rounds: PIDs 720, 6984 and 400 exited/closed zero before each verified
publication. That does not identify or resolve the earlier production Full
EPERM. The sole stdin assertion blocked Full build/bootstrap, actual Pi
descendants, NSIS, signed ZIP/Connect, private-route and Nightly stages; those
remain pending.

The unchanged actual-Pi chat-migration target passed three focused runs each on
35f0 core source and actual main 4ce with the same pinned Pi. The separate macOS
CI failure's cause remains unproved; its migration assertions/source are unchanged.

The dev runner also uses real Node plus an owned JavaScript launcher on Windows,
with the locked Pi CLI and verified search tools. It does not execute npm or pnpm
command shims. The production daemon support guard still applies to source builds;
the nonpublishing native probe uses the existing disposable source preparation.
Native installer tests retain both file locks while checking Windows delete sharing,
then exercise terminal Uninstall with and without data removal and a live foreign
lock. These tests do not relax daemon exclusion to remove data.

The outer Windows installer clears only the HKCU Registry64
`Software\Classes\hexbot\shell\open\command` default value when it is still
an exact `REG_SZ` command for the app it just successfully uninstalled.
Candidates come from the authenticated app directory before NSIS runs, including
its supported canonical drive spelling; a missing app EXE does not require reopening
that file. Other editions, tracks, commands, value types and named values stay.
Unsupported path spellings are left alone. Cleanup does not run during Repair or
before a failed/canceled uninstall. If it fails after NSIS, owned residual-file
removal still runs and the installer reports the partial result.

Empty registration keys and protocol marker values remain. Windows Settings or a
direct NSIS uninstall does not invoke this outer-installer cleanup. Comparing and
deleting a command value is not atomic against an unrelated same-user registry
writer. A handler replaced before cleanup is preserved; no race-free registry
transaction is claimed. The command format follows [pinned Electron 41.10.7](https://github.com/electron/electron/blob/v41.10.7/shell/browser/browser_win.cc#L430-L536).

The native three-round real-Pi publication probe retains strict exit/close and
atomic directory-rename assertions. Its prewarmed test-only observer requests
read-only Win32 information after a failed rename, without holding a staged-file
or child-process handle before failure. These post-failure observations cannot
recover the original Win32 error or prove which handle blocked that earlier call.

Windows finalization now inventories the complete original staging tree before
its real Node/Pi version probe. The sequential inventory includes directories,
empty directories, and every ordinary file's size and SHA256; links, junctions
and other types refuse. The original tree keeps its existing npm and Pi cwd and
relative imports. The version must match the pinned Pi version.

After that probe, one copy goes into a fresh `hexbot-native.staging-*` sibling.
Its complete inventory must match the pre-probe inventory before the unchanged
single-rename publisher runs. Nothing has executed in the fresh tree or used it
as cwd. Probe mutations and incomplete or corrupt copies refuse before touching
the old destination. Both owned staging trees must be removed; cleanup failure
after the rename still fails the build and says publication already completed.
There is no retry, copy-publication fallback or permission workaround. This does
not establish the original EPERM blocker or guarantee a fresh tree cannot be
scanned or locked. A fresh-copy rename failure remains a failure. Unix staging
keeps its existing symlink behavior and direct publication.

Windows service status distinguishes a registered scheduler task from recoverable
owned script metadata. A stopped verified task is installed; a script with no task
is not start-at-login. Repair can recreate it and Uninstall/Change still clean its
owned files through the same ownership checks. `HEXBOT_SERVICE_NO_LOAD` reports no
scheduler installation and marks that the scheduler was not queried.

## Missing Windows app directories and NSIS process checks

If an entire app directory is gone, Repair can restore only the one exact
managed release directory named by a valid Full or Client receipt. Its version
must belong to that receipt's Stable or Nightly track. Existing unmarked files,
directories, links, other paths and I/O errors do not gain ownership from a
receipt. The terminal's interactive Update or repair action and the windowed
installer use the same Repair engine. Explicit install options remain Apply.

The absent-directory exception accepts either no registry entry or the exact
stale HKCU registration for that identity, with both HKLM keys absent. Registry
paths are compared as bounded ordinary drive spellings, never resolved or
executed. A recoverable stale entry requires Repair before Apply, Change or
Uninstall can discard its receipt. Repair checks the absence and registration
class again under the installation lock after the verified download. A partial,
foreign or HKLM entry cannot authorize Repair. Uninstall may remove its known
outer state but leaves that registration unchanged and displays a warning. A
receiptless missing app with an entry cannot be identified automatically.

Pinned electron-builder 26.16.1's
`templates/nsis/include/allowOnlyOneInstallerInstance.nsh` uses two distinct
process predicates. `IS_POWERSHELL_AVAILABLE` probes `Get-CimInstance`, then
`Get-ExecutionPolicy -Scope Process` with `-NoProfile -NonInteractive`. If
available, `FIND_PROCESS` and `KILL_PROCESS` use raw
`Path.StartsWith($INSTDIR, CurrentCultureIgnoreCase)`, without a separator.
If unavailable or Restricted, the per-user fallback uses `tasklist`/`taskkill`
with `%USERNAME%` and `${APP_EXECUTABLE_FILENAME}`. Full's `Hexbot.exe` also
matches the native daemon's `hexbot.exe` on Windows.

Before every outer NSIS invocation, a read-only preflight repeats the two probes
without changing policy or their inherited environment. A bounded DOS/PE
machine read from the verified incoming installer, or authenticated known
uninstaller, selects trusted WOW64 PowerShell for I386 or System32 for AMD64.
This matters because the pinned NSIS stub/plugins use x86-unicode; changing
registry view does not disable filesystem redirection. Native diagnostics
record the actual PE machine and observed probe host architecture/image. They
do not claim to observe the NSIS child itself. Malformed or unsupported headers
and nonordinary system executables refuse rather than selecting another host.

In the available branch, the preflight refuses matching raw directory prefixes,
including sibling names, while preserving an independent daemon outside them.
In the fallback branch, it verifies process-owner names and SIDs against the
current identity before matching the edition image. It cannot safely proceed
beside a matching live app or daemon under that policy and refuses without
stopping it. Incomplete queries or uncertain ownership refuse. The displayed
match list is bounded only after complete enumeration; truncation cannot turn
matches into permission to proceed. Apostrophes, quotes, percent signs, control
characters and nonstandard drive paths are explicitly unsupported because the
pinned macro interpolates its directory into a PowerShell command.

The final check runs under the installer lock immediately before NSIS. Earlier
removal checks also protect Change before replacing another app. Concurrent
same-user process or policy changes between that check and NSIS remain outside
a compare-and-swap guarantee. There is no registry cleanup or identity migration
in this recovery path. Settings can still install another track under Programs,
outside this installer's discovery, as described above. Windows remains
unsupported and publishing stays disabled.

Windows task Stop now shares one completion boundary between the daemon CLI
and installer removal. Before asking the verified scheduler to stop, it captures
bounded running-instance engine IDs and retains handles only after System32
PowerShell, owner SID and pre-query creation-time checks. Access denied or a new
or uncertain live engine refuses. It does not need HTTP readiness, the selected
new build, a running-record PID or readable lock bytes. After retained engines
exit, two Toolhelp snapshots corroborate direct managed-runtime daemon children;
their retained handles must also signal before scheduler/home-idle success.
No witnessed process is terminated. Capture, scheduler calls and completion
share the existing 30-second deadline. Definitively absent or already-exited
engines cannot supply a new identity; concurrent scheduler replacement remains
a race rather than authority to attach to an unrelated process.

The native regression uses events to release a real file lock while its exact
child handle remains unsignalled. The previous lock/state predicate would finish
there; the retained-handle predicate must not. The original explicit CLI Stop
assertions still require OS exit zero at API return, and the missing-log/task
fixture also calls the shared boundary directly. These new native cases remain
pending execution. The 6665 snapshot passed the pre-fix assertion, so the earlier
f1f failure's cause remains inferred rather than proven by that run.
