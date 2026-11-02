# Windows security status

The production daemon still does not build for Windows: `lib.rs` keeps its
unsupported-platform guard until native CI passes and review signs off. CI
builds a disposable copy without the guard to test what this document
describes. Release packaging is wired up, but this is not a support claim.

## What Auto and Manual run on Windows

In Auto and Manual the daemon runs local commands, such as scheduled scripts
and monitors, in an AppContainer, through its own executable: `hexbot
sandbox exec <policy> -- <program> [arguments]` (`windows_container.rs`).
Pi's own tools still refuse until the extension uses the same helper (see
[Shells and scripts](#shells-and-scripts)). The daemon builds the policy from the same
workspace scan the macOS and Linux sandboxes use (`windows_policy` in
`credentials.rs`). At startup it runs `cmd /c exit 0` in a throwaway
container. When that works, `hexbot.info` reports `sandbox: "appcontainer"`
and `hexbot status` reports the sandbox as available. When it does not, Auto
and Manual refuse local commands and file tools, scheduled scripts do not
run, and Settings, Approvals says so. They never fall back to an approval
that would run with the user's own permissions.

What is guaranteed:

- **One container per policy.** A container is named for its Hexbot home,
  its access level (Auto writes the workspace, Manual only reads it) and a
  digest of the roots it is granted. Grants are ACL entries for that
  container's SID alone, so a container never reaches a root that only
  another policy was granted.
- **No network.** A container has no capabilities: no internet, no local
  network, not even loopback.
- **Only granted files.** A container reads the roots its policy names and
  what Windows lets every AppContainer read, such as Program Files and the
  Windows folder. Auto writes the working folder and the bot's output
  folders. Manual reads them and writes nothing but an approved output
  folder in the Hexbot home. Every policy reads the managed Python and a Git
  for Windows installed for this user only. Each container has its own home,
  temp and AppData folders inside the Hexbot home, and its environment points
  there.
- **Credential isolation.** No root may be, contain or sit inside the
  user's profile, the Hexbot home, a credential store or the managed
  runtime; the helper refuses such a policy before anything changes. The
  stores come from `backend/pi-runtime/credential-policy.json`, which names
  the Windows ones too: browser profiles under AppData (Chrome, Edge, Brave,
  Vivaldi, Opera, Firefox), the Windows credential, vault and DPAPI folders,
  `.ssh`, `.aws`, `.kube`, `.azure`, `.docker`, the gcloud and GitHub CLI
  folders, `_netrc` and `pgpass.conf`. A root inside the Hexbot home, as
  output folders are, must not be, hold or sit inside one of the home's
  stores: its `.env` files, `users/<id>/passwords` and `approvals`,
  `runtime/provider-auth`, `desktop-data` or `connect.json`. Project secrets
  (`.env`, `.envrc`) and the home's own credential paths are
  denied outright.
- **Git metadata stays read-only.** `.git`, linked `gitdir` and `commondir`
  targets, bare repositories and configured hooks folders inside a writable
  root get a write deny, and a deny that misses an entry stops the command.
  As on Linux, a scan that stops early, a missing hooks target that would
  make a whole repository read-only, or a link on the way to Git metadata
  refuses the command.
- **Grants are recorded and reversible.** A journal names every container
  before it is created and every root before it changes. Grants are applied
  by walking each tree through handles without following links, so swapping
  a folder for a junction during the walk cannot redirect it. `hexbot
  sandbox reset` removes every entry for the journaled containers from every
  journaled root, then deletes the containers; other ACL entries are never
  touched. One lock file serializes changes across processes.
- **Contained process trees.** Each command runs in a job that ends its
  whole tree when the helper ends, with at most 512 processes. A scheduled
  script that times out ends its helper and so its tree.
- **Paths are judged before they are opened.** Working folders, scheduled
  script paths, policy roots and every path the Git scan follows must be
  plain local disk paths. Network shares, device and NT object paths,
  alternate data streams, reserved device names such as `CON`, `NUL` and
  `COM1`, and names ending in a dot or space are refused by their text, and
  a working folder or script must be on a local fixed drive. The Git scan
  reads metadata only from local disks and never through a final link. It
  reads Git settings with its own parser, checked against Git itself, rather
  than a Git executable it could only find through the PATH.

## Shells and scripts

Shell commands and `.sh` and `.bash` scheduled scripts run in Git Bash, found
where the Git for Windows installer recorded it or in its default folders,
never through the PATH. `.py` scripts run with the managed Python
(`runtime/tools/code-python`), `.exe` scripts run as themselves, and any
other script refuses. Bypass uses Pi's own Bash with no sandbox and no
credential protection: the same Git Bash, which the daemon names in each
bot's Pi settings (`shellPath`) because Pi's environment has no
`ProgramFiles` for its own search. Without Git for Windows, Pi searches the
PATH as it would. It does not substitute `cmd.exe` for Bash. Pi stops when
its input ends, the request Windows has instead of SIGTERM, and is ended
with its job after the same grace.

Pi asks the daemon for the policy of each of its commands through the
private `hexbot_sandbox_policy` bridge, which builds it from the section's
live working folder, outputs and approval mode, checked as session settings
are. Session settings name the sandbox, its helper and Git Bash. Until the
private extension runs its bash and read tools through that helper, Pi's
own tools still refuse in Auto and Manual on Windows (`isolation.ts`);
scheduled scripts and the daemon's other paths already use the sandbox.

## What still refuses

- **`full_access`.** An AppContainer has no network and reads only what it
  is granted, so an approved command cannot leave the workspace sandbox for
  the base layer alone. Bypass runs commands without a sandbox.
- **Copilot**, including its reviewer, in every mode. It runs with the base
  layer alone, which Windows does not have.
- **Pi's write and edit tools** in Auto and Manual. They use a private bridge
  on Unix directory handles, which Windows does not have yet.
- **The daemon's Python worker** (`execute_code`) and the file callbacks it
  reaches. Code runs on the bot's own computer.

## Residual risks

- **Hard links.** A file with more than one name is never granted, since its
  DACL is shared with names outside the tree. A link made later by a process
  outside the sandbox to a file a container was granted shares that grant.
- **Moved files.** Grants are written onto each file. A file moved out of a
  granted root keeps them until reset; a file moved in has none until the
  next command of that policy walks the root again.
- **New metadata and secrets.** `.git` folders and `.env` files created
  while a command runs inherit the root's allow. They are denied from the
  next command on.
- **Narrower reads than macOS and Linux.** Programs installed for one user
  outside the granted roots, such as a Python or Node.js in AppData, cannot
  be read, so commands cannot run them. Workspaces in OneDrive and other
  cloud-synced folders hold reparse points, which are never granted.
- **Files older than their private folder.** Windows does not check the
  folders on the way to a file, and a private folder's DACL is not
  propagated, so a file that existed before its folder became private keeps
  its own DACL. Hexbot makes its private folders private before it writes
  into them.
- **Named pipes and other objects.** A container can open named pipes and
  other kernel objects whose security admits every AppContainer.
- **MSYS arguments.** Arguments are quoted so MSYS expands no glob or `~`,
  but MSYS reads `\\` inside quotes as one backslash, so an argument with a
  doubled backslash reaches Git Bash changed.
- **No memory or CPU caps.** The job limits only the number of processes.
- **Policy size.** A policy is one command-line argument. A workspace with
  very many protected files refuses rather than drop protections.
- **Containers accumulate.** Each combination of working folder and outputs
  gets its own container and grants until `hexbot sandbox reset`.
- **First commands are slow in large workspaces.** A new container's grants
  are written file by file before its first command runs, and that time
  counts against a scheduled script's two minutes.

## Runtime contract

The daemon is a direct `hexbot.exe`. A validated selection in
`runtime/native-current.json` identifies an immutable build under
`runtime/native/<build>/hexbot.exe`, which is also the sandbox helper.
Bundled Node is an absolute sibling `node.exe`, launched with the sibling
`pi/launch.mjs`. Neither a `.cmd` daemon nor a symlink supplies this
contract. Managed Python lives under
`runtime/tools/code-python/Scripts/python.exe`.

Children inherit only the shared credential policy's explicit environment list.
Windows adds the OS/profile location names `SystemRoot`, `WINDIR`, `USERPROFILE`,
`APPDATA` and `LOCALAPPDATA`, matched case-insensitively. Provider keys and runtime
injection variables remain excluded. These locations support Windows runtime and
profile discovery; they grant no filesystem permission. A contained command's
home, profile, temp and AppData variables point at its container's own folders,
and it never sees `HEXBOT_HOME`. See Microsoft's
[environment block contract](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables)
and Node's [Windows home-directory lookup](https://nodejs.org/api/os.html#oshomedir).

Selection and installed runtimes are never writable to a container:
`runtime/native-current.json`, `runtime/native`, `runtime/tools`,
`runtime/bin`, `bin` and `python` may be read, never granted for writing,
and no root may contain them. Managed roots themselves must retain their
ordinary location beneath the resolved home. Restricted file writes and
command layouts reject symlinked runtime roots, including a root pointing
into an artifact output or a missing target. Aliases of the home remain
valid. This rejects a mutable runtime topology instead of treating an
output grant as permission to replace installed code.

On macOS and Linux these path rules do not contain shell and code writes
through hard-link aliases: a preexisting alias in a writable workspace or
output folder can modify the inode of a managed runtime file despite
protection of its original path. There is no managed-inode or workspace
scan, so legitimate uv cache hard links and large dependency trees do not
require reinstalling packages or making installed files read-only. See the
exact [tool-isolation assumptions](../SECURITY.md#tool-isolation).

Runtime reads the effective approval policy before resolving live workdirs or
creating outputs, and on Windows checks a working folder by its text and
drive before anything is created. Native file callbacks recheck policy and
destination after an approval. On Unix, restricted Pi write and edit use
Rust's directory-relative operations through the private extension UI bridge,
with final reads and atomic replacements on directory handles opened without
following symlinks. The bridge limits each encoded request and reply to
1 MiB. Windows refuses that bridge before any of these operations, with no
pathname fallback.

The daemon's own files keep the Unix boundaries (`osutil`). Removals and the
one-chat-per-bot backup never follow a link: a junction or directory link
is removed as itself, a linked `backups`, `runtime` or `runtime/sessions`
folder is refused, and links inside a copied tree are skipped. The home, the
passwords folder, MCP working folders and the local device token are
private: a protected DACL gives SYSTEM and the user the daemon runs as full
control and nothing else, and what is written into those folders afterwards
inherits it. The DACL is set on the folder alone, never propagated, so it
cannot walk into the containers' folders in the home or through a link.
Untrusted reads (`common::read_regular`) open only regular local disk files:
the path is judged by its text first, then opened without following a final
link, and pipes, devices and other reparse points are refused. Commands
the daemon looks up take the `PATHEXT` extensions in turn and either
separator, and the user's own folders are under the profile.

The Windows CLI contract also installs a separate native argument forwarder at
`<user-profile>/.local/bin/hexbot.exe`, with a `hexbot.json` home/hash ownership
sidecar. It selects the immutable daemon through `native-current.json`; it is
not a stable daemon or a command script. It sits in the user's profile, which
no container is granted.

## Verification

Two native jobs run as a newly created local standard user on
`windows-latest`, each in a disposable copy without the platform guard, and
publish nothing:

- `.github/workflows/windows-contract.yml`, job `sandbox`, runs
  `tests/windows_sandbox.rs` against real AppContainers, ACLs, sockets and
  processes: workspace writes with Git metadata, secrets, junctions and hard
  links kept out, read-only Manual, one container per policy, no network or
  loopback, Git Bash and Node inside, process trees that end with the
  helper, root refusals, journal and reset, and argument quoting.
- `.github/workflows/windows-security.yml` runs the production Pi extension
  probes and the compiled `tests/windows_security.rs` boundary probe, with
  the daemon binary as the sandbox helper. The probe checks that Auto writes
  the workspace and Manual writes nothing, that a project `.env` stays
  unreadable, that full access refuses, and that network, device, stream and
  reserved paths refuse by their text before any access. Through the real
  Runtime and a trusted Pi transport fixture it checks that session settings
  name the sandbox, that `hexbot_sandbox_policy` gives Pi a policy that runs
  in the container, that execute_code and the private write/edit bridge
  refuse before approval, and that an Auto `.sh` scheduled script writes the
  workspace while a Manual one writes nothing. Copilot refuses before path
  or command resolution. Runtime and selection files stay byte-identical,
  owned Pi processes stop, and no container profile is left registered.

The extension probes start before import and tool registration, with hostile
UNC `HOME` and `USERPROFILE` values. Only trusted module loading and the
explicit session config may access the filesystem. They cover Auto, Manual,
unknown modes, approved `full_access` attempts, parallel calls, direct
execution without a gate grant, the user-command hook, and a Bypass grant
invalidated by a mode change; the extension still refuses its own tools on
Windows. A second pass uses real OS entry points with a malicious `git.exe` on
`PATH` and verifies no marker or workspace file was written and runtime
selection was unchanged.

The combined job reads immutable inputs from the event commit. A complete
combined tree uses that exact commit for both inputs. A security-only commit
requires an immutable recorded pin. It uses the nearest recorded trailer along
the source commit's first-parent history, including the current commit. The
trailer is exactly `Hexbot-Windows-Build: <40 lowercase full SHA>` and identifies
the build commit.
A malformed/duplicate first recorded trailer, missing pin object or invalid
build interface refuses; routing never searches past bad metadata or follows a
second parent. Without any recorded first-parent pin, a security-only source
refuses. Routing logs the exact pin metadata commit SHA separately from the
source/build SHAs. The same validated trailer must survive a security squash
merge so ordinary subsequent core/Pi commits can inherit it. Combined build
markers still select the exact current tree without a historical pin; the
security markers are `pub const UNAVAILABLE:` in `windows_sandbox.rs` and
`pub fn require_native_worker(` in `credentials.rs`. A shared preparation
helper creates a detached worktree, applies the security diff, and records
both inputs and the combined Git tree. If the build already contains the
security commit, or the security delta is exactly empty because only commit
metadata changed, it keeps the build tree unchanged. It requires exactly one
occurrence of the exact unsupported-platform guard bytes, and removes only
those bytes in the disposable source. It logs the guard diff and before/after
hashes. Production source retains its guard, with no feature or compile option
that bypasses it. The workflow uploads no executable or artifact.
Explicit `--current-tree` mode verifies both build and security interfaces and
preserves the exact pinned source tree. It records original dependency ancestry
without requiring history removed by squash merges. Two-source preparation uses
one verified merge base and a shared reviewed dependency ancestor, either the
original #132 commit or its main squash. Conflicting patches abort.

The trusted fixture records command names, process exits and exception types
without recording prompts, tool arguments or environment values. On failure the
probe preserves the original error and reports cleanup separately. A bounded
loader-only diagnostic captures stderr from the fixed fixture; production Pi
continues to discard stderr that could contain credentials.

Other platforms run the extension gate probes with a simulated Windows platform,
which checks gate logic only, and the portable tests of the Windows rules:
path forms, root refusals, policies built from injected scans, and the Git
settings parser compared with `/usr/bin/git`. They cannot validate Windows
security APIs, ACL behavior or native containment.

## Before Windows is supported

- The private extension runs its bash, read, grep, find and ls tools through
  `hexbot_sandbox_policy` and the helper, and the extension probes prove it
  natively.
- Both native jobs pass on the combined tree, then a separate change removes
  the guard in `lib.rs`.
- GPT and Opus review approval and explicit parent approval, as for every
  shipping or production publishing decision.
