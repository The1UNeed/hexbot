# Windows build and install validation

Windows is not a supported Hexbot release target. The website, release matrix,
update publishing and installer bootstrap remain unchanged. This work prepares
local packages and native CI probes. It does not provide Windows confinement.
The fail-closed execution boundary and independent GPT 6.1 and Opus 5.5 approval
are required before merge or shipping, together with native validation.

## Runtime layout

Windows x64 uses `hexbot.exe`, `node.exe`, `pi/launch.mjs`, the locked Pi
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

## Install and update contracts

Full NSIS artifacts begin with `Hexbot-`; Client artifacts begin with
`HexbotClient-`. The installer runs NSIS, waits for it, and checks the expected
app EXE and `resources/app.asar` before writing its receipt. Repair runs NSIS
again. Uninstall runs the installed NSIS uninstaller before removing leftovers.

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
daemon stays inside the task's job. No breakaway child races the home lock.
The CLI forwarding script is `.local/bin/hexbot.ps1`.

## Verification and remaining gates

`windows-contract.yml` publishes nothing and uses commit-pinned actions. Its
Client job builds real NSIS and tests installation, repair and uninstall with
a signed local manifest. The separate native job first compiles the daemon;
it intentionally fails until the Windows platform guard and credential
compile dependency are resolved by the security work. Later steps stage real
Node/Pi, run Full bootstrap and Headless setup in temporary state, exercise
Pi RPC, Python, web serving and task lifecycle, install Full NSIS, and validate
a signed native ZIP update plus the pinned cloudflared executable.

A cross-compile on macOS is only a compile check. It cannot establish native
NSIS, task, Electron GUI, job lifetime, console or standard-user behavior.
Windows CI must pass on the combined implementation and security changes.
Native task restart during an actual version-changing update, packaged app
GUI activation, and the security stage's standard-user adversarial probes
remain required before any Windows availability claim.

## Upstream tool pins

Windows SHA-256 values were checked against the primary release assets and
GitHub release metadata for [uv 0.12.18](https://github.com/astral-sh/uv/releases/tag/0.12.18),
[ripgrep 15.2.0](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0),
[fd 10.5.0](https://github.com/sharkdp/fd/releases/tag/v10.5.0) and
[cloudflared 2026.8.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.0).
Node uses the Windows x64 ZIP digest from
[Node 22.23.3 SHASUMS256](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt).
The uv ZIP is flat; rg and fd have a top-level release directory.
