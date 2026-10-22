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

Python and voice tools share a managed venv under
`runtime/tools/code-python/Scripts/`. The absolute Python and edge-tts paths
are used directly, rather than copying a Python EXE away from its libraries.
Both native and Electron provisioners explicitly set `UV_LINK_MODE=copy`, so
new package installs do not share uv cache inodes. This does not establish a
race-free hard-link boundary or change permissions on legacy Python files.

## Install and update contracts

Full NSIS artifacts begin with `Hexbot-`; Client artifacts begin with
`HexbotClient-`. The installer runs NSIS, waits for it, and checks the expected
app EXE, `resources/app.asar` and the ownership marker packaged inside NSIS
before writing its receipt. The download remains verified against the signed
install manifest. That marker survives interruption
between NSIS completion and receipt publication. Unmarked apps are not owned. Repair runs NSIS
again. The completion screen uses the receipt’s owned Windows app directory
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
principal. Its action and principal both use `Owner`, with `LeastPrivilege`
and `InteractiveToken`. Task state is read numerically, without localized
status text. A hidden PowerShell wrapper reads the selected EXE for each run
and waits for the old daemon to exit before starting an updated one. The new
daemon stays inside the task's job. No breakaway child races the home lock. Stop/restart waits for both task state
and the daemon home lock. Install and repair also stop an owned existing task
and wait for that lock before replacing its script/XML and starting the selected
runtime; updating a task definition alone would keep its old instance. Uninstall treats only the numeric task-not-found
error as absent; foreign task actions/principals and permission errors fail.
An interrupted owned script/XML install can therefore be removed even when
task creation never finished.
A separate native forwarding component is installed as `.local/bin/hexbot.exe`,
with a hash-bound home record in `hexbot.json`. It passes argv directly to the
canonical selected daemon. It works from cmd and Restricted PowerShell without
copying a stable daemon or requiring symlinks. Setup adds that directory to the
user PATH; uninstall removes only an entry setup added. If an interrupted
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
lifetime management, not Windows tool confinement. GUI-owned setup, daemon,
Pi and tunnel children use hidden-console spawn options.

## Verification and remaining gates

`windows-contract.yml` publishes nothing and uses commit-pinned actions. Its
Client job checks the pinned builder’s package-metadata workspace fallback
and hook containment for both editions, then builds real NSIS and tests installation, repair and uninstall with
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
a signed native ZIP update plus the pinned cloudflared executable. Native
regressions also exercise Unicode and junction homes, outside junction refusal,
the activation-lock rollback floor and both service log streams. Dedicated
probes also cover Restricted PowerShell/CMD argument propagation, real 8.3
aliases where the volume supplies them, interrupted task cleanup, foreign
actions, Tauri app detachment, and owned Full quit/EOF/force cleanup with a real
Runtime-owned Pi child and a descendant. A separate native supervisor probe
starts/stops a local tunnel metrics fixture twice through real services cleanup.
It does not prove live Cloudflare enrollment. A volume without distinct 8.3 names
reports that case as unproved.

A cross-compile on macOS is only a compile check. It cannot establish native
NSIS, task, Electron GUI, job lifetime, console or standard-user behavior.
Windows CI must pass on the combined implementation and security changes.
The native matrix includes actual installed Client/Full GUI activation and a
version-changing signed ZIP update between two debug fixture daemons, followed
by task stop and process/home-lock assertions. The same two versions also
exercise the installer engine’s Headless update and repair path, checking that
each replaces the old task PID and runs the selected version. Separate native
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
