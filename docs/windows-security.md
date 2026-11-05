# Windows security

Windows 10 or later, 64-bit, is a supported platform. In Auto and Manual the
daemon confines every local command and file tool, and refuses what it
cannot confine instead of asking. This document describes the guarantees,
what still refuses and the residual risks. CI builds and tests the
production source natively ([Verification](#verification)).

## What Auto and Manual run on Windows

In Auto and Manual every local command runs in an AppContainer, through the
daemon's own executable: `hexbot sandbox exec <policy> -- <program>
[arguments]` (`windows_container.rs`). That covers Pi's bash tool, the
user's own commands, scheduled scripts and monitors
([Shells and scripts](#shells-and-scripts)). Pi's read, grep, find and ls
judge each path before they open it ([Pi's read tools](#pis-read-tools)),
and its write and edit change files through the daemon's handle bridge
([Pi's write and edit](#pis-write-and-edit)). The daemon builds the policy
from the same workspace scan the macOS and Linux sandboxes use
(`windows_policy` in `credentials.rs`). At startup it runs `cmd /c exit 0`
in a throwaway container. When that works, `hexbot.info` reports `sandbox:
"appcontainer"` and `hexbot status` reports the sandbox as available. When it
does not, Auto and Manual refuse local commands and file tools, scheduled
scripts do not run, and Settings, Approvals says so. They never fall back to
an approval that would run with the user's own permissions. Shell commands
run in the shell the runtime ships, BusyBox, once a second probe has run it
inside a container ([Shells and scripts](#shells-and-scripts)).

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
  folder in the Hexbot home. Every policy reads the managed Python, the
  runtime's BusyBox and a Git for Windows installed for this user only. Each
  container has its own home,
  temp and AppData folders inside the Hexbot home, and its environment points
  there. Windows itself moves a contained command's LOCALAPPDATA, TEMP and
  TMP into a profile folder below the LOCALAPPDATA it is given, so that
  folder is one of the container's own. No folder on the way
  to what a container is granted carries an entry for it: its token keeps the
  right to bypass traverse checks, so it crosses folders it can neither list
  nor read.
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
  (`.env`, `.envrc`) and the home's own credential paths under a granted
  root keep no entry for the container at all.
- **Git metadata stays read-only.** `.git`, linked `gitdir` and `commondir`
  targets, bare repositories and configured hooks folders inside a writable
  root keep only a read entry, so a command can neither change them nor move
  them aside to plant others. As on Linux, a scan that stops early, a missing
  hooks target that would make a whole repository read-only, or a link on the
  way to Git metadata refuses the command.
- **Protection is the absence of an allow.** An AppContainer's access check
  ignores deny entries for its own SID, so Hexbot writes none: Git metadata
  and secrets are protected by what their allow entries leave out. No grant
  includes the right to delete a folder's entries, which Windows honours
  whatever an entry's own permissions say, so a command deletes or moves an
  entry only when that entry allows it, and Git metadata and secrets never
  do. A grant
  meets each protected path by its file identity while it walks, wherever it
  is, and writes only what that path keeps below it, so no grant ever opens
  one, not even for a moment while another command of the same container
  runs. A protected entry a walk cannot open, list or change, or a link
  inside a protected tree, stops the command.
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

In Auto and Manual, Pi's bash tool, the user's own commands and `.sh` and
`.bash` scheduled scripts run in the shell the Windows runtime ships:
[busybox-w32](https://frippery.org/busybox/), one `bin\busybox.exe` beside
the daemon (`windows_sandbox::bundled_shell`), whose `sh` is ash. A command
runs as `<busybox> sh -c <command>` and a script as `<busybox> sh <script>`,
never through the PATH. `.py` scripts run with the managed Python
(`runtime/tools/code-python`), `.exe` scripts run as themselves, and any
other script refuses. The pin and its checksum are in
`scripts/desktop/native-runtime.mjs`; the runtime's `THIRD_PARTY_NOTICES`
carries BusyBox's GPL-2.0 and where its source is.

ash is a POSIX shell with some Bash extensions, such as `[[ ]]`,
`${v//a/b}`, `$'...'`, `&>`, `local` and `set -o pipefail`, but it is not
Bash: it has no arrays, brace expansion or `declare`, so a command or a
`.bash` script that uses them fails. Commands such as `ls`, `grep`, `sed`,
`awk` and `find` are BusyBox's own, run by the same binary.

Git Bash cannot be that shell. Git for Windows' MSYS runtime creates its
shared objects under the global `\BaseNamedObjects` namespace, where no
AppContainer may create anything
(`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-…)` fails with
`STATUS_ACCESS_DENIED`). It also gives the objects it makes, such as the
ones that map process IDs and its signal pipes, to Everyone, which an
AppContainer's access check never counts. Preparing that namespace from
outside the container cannot help: the runtime's own processes still could
not open each other's objects, and a half-working runtime can return from
`fork` as the child in both processes, so a command would run twice. BusyBox
needs none of that. It starts each pipe stage and subshell as a new copy of
itself and hands it the shell's state in an unnamed file mapping the copy
inherits.

The shell runs in a container only after the daemon's probe ran it there,
once for each shell it finds: in a throwaway container that may read the
shell alone, `sh -c` pipes a fresh nonce into a second copy of the shell
inside a command substitution, and the output must be exactly that nonce
(`windows_container::probe_shell`). The probe's grant is journaled while it
lasts and taken back. While the probe fails, or when the runtime has no
shell, as a daemon built from source has none, Pi's bash tool, the user's
own commands and `.sh` and `.bash` scripts refuse with that reason before
anything starts; session settings carry it as `shellRefusal`. `.py` and
`.exe` scripts, Pi's read, write and edit tools and other contained programs
still run, and Bypass runs shell commands without a sandbox.

Every policy may read and run the shell, never change it. The helper grants
it as it grants the programs a policy reads, but leaves it out of the
container's name, since each runtime brings it at a new path
(`Policy::shell`). The helper starts it, like every contained program, with
`BB_GLOBBING=0`: started by anything but itself, BusyBox expands wildcards
in its own arguments as other Windows programs do, so a command such as
`ls *` could otherwise reach the shell as file names.

Bypass uses Pi's own Bash with no sandbox and no credential protection: Git
Bash, which the daemon names in each bot's Pi settings (`shellPath`) because
Pi's environment has no `ProgramFiles` for its own search. Without Git for
Windows, Pi searches the PATH as it would. It does not substitute `cmd.exe`
or BusyBox for Bash. Pi stops when its input ends, the request Windows has
instead of SIGTERM, and is ended with its job after the same grace.

Pi asks the daemon for the policy of each of its commands through the
private `hexbot_sandbox_policy` bridge, which builds it from the section's
live working folder, outputs and approval mode, checked as session settings
are. Session settings name the sandbox, its helper and the shell, its path
and kind (`busybox`), or why there is none (`shellRefusal`). The private
extension then starts the helper itself, never through a shell: `<helper>
sandbox exec <policy> -- <busybox> sh -c <command>`, with the sanitized
environment, stdin ignored and no window. The user's own commands and the
terminal tool take the same path. Execution rechecks the
live settings, so a command whose approval mode or working folder changed
after it was allowed starts nothing. A timeout or Stop kills the helper,
whose job ends the command's processes. A Windows command line holds at most
32,767 characters, policy included, so a longer command refuses and says to
run it from a script file. Without the sandbox every local tool refuses before it reads
a file, looks for a shell or asks for approval (`isolation.ts`).

## Pi's read tools

In Auto and Manual, Pi's read, grep, find and ls run in Pi itself, as on
macOS and Linux, and keep credential files private: the stores in
`credential-policy.json`, the Windows ones included, project secrets, SSH
private keys and the Hexbot home's own credential paths. On Windows they
also judge each path first:

- **Paths are judged by their text.** Network, device, NT object,
  drive-relative and stream paths, reserved names and names ending in a dot
  or space refuse before anything opens them.
- **Links resolve before they are checked.** A path resolves one name at a
  time, and a link is never followed to a form that refuses, so a junction
  to a network share is refused before it is followed. A mapped network
  drive refuses as it resolves.
- **Paths resolve as Pi reads them.** Git Bash drive paths such as `/c/x`
  and odd spaces resolve as Pi resolves them before it reads, so the check
  and the read name the same file.
- **A local profile is required.** With a profile folder on a network share
  the tools cannot tell which files are private, so they refuse.
- **Listings and searches stay quiet.** ls skips a link it cannot resolve,
  and grep hides the lines of a credential file.

## Pi's write and edit

In Auto and Manual, Pi's write and edit change files through a private
bridge to the daemon (`hexbot_pi_file`), never by path from Pi. Each request
carries the policy it was approved under, and the daemon checks the approval
mode, working folder, output folders and running tool call again before
anything is opened. It refuses credential files and stores, system
configuration files, project secrets, `.git`, `node_modules` and `.ssh`
anywhere on the path, the managed runtime, and the Hexbot home outside the
bot's output folders. It also refuses the repository's configured Git
metadata (a `core.hooksPath` folder, the folders a `gitdir:` or `commondir`
link names, included config files) by the same workspace scan commands use,
and refuses the change when that scan cannot finish. Bypass never uses the
bridge. On Windows the bridge works through handles
(`runtime_files_windows.rs`), as it does on macOS and Linux:

- **Paths are judged first.** Network, device, NT object and stream paths,
  reserved names, names ending in a dot or space, and paths on anything but
  a local fixed drive are refused by their text and drive.
- **No link is followed.** The walk opens the drive's root, then each folder
  relative to the one before it. A link, junction or other reparse point on
  the way or at the file is opened as itself and refused, so a folder
  swapped for a junction cannot redirect a write. Cloud-synced folders such
  as OneDrive's are reparse points too, so the tools do not change files
  there. Missing folders a write needs are created through the same handles.
- **Names are what the checks judged.** The folder and the file must be
  named on disk as the path names them, so an 8.3 short name such as
  `GIT~1` for `.git` refuses.
- **Files are replaced at once.** A write fills a temporary file in the
  target's folder, shared with no other handle, then renames it over the
  target through the folder's handle. A folder in the target's place
  refuses, as does a read-only file, and a failed write deletes the
  temporary file through its own handle.
- **An edit commits to the file it read.** The read returns the file's raw
  bytes and its identity, the volume serial number and 128-bit file ID. The
  commit refuses unless the name still has that file, so a file replaced,
  deleted or moved in between is never overwritten.
- **Limits and Stop.** Each encoded request and reply is at most 1 MiB,
  about 767 KiB of file data. Stop waits for a running request to finish
  before it acknowledges.

Residual risks:

- **Hard links.** A write or edit replaces the name it was given, so other
  names of a hard-linked file keep the old content. The container's rule
  that a file with several names is never granted does not apply here: a
  file that also has a name outside the tree is read through the name an
  edit was given, as on macOS and Linux.
- **Check, then rename.** The bridge checks the file, then renames over it,
  as on Unix: a file put at the name in between is replaced.
- **Permissions.** A replaced file takes its folder's inherited permissions.
  Explicit entries, attributes and alternate streams on the old file are not
  carried over, where Unix keeps the old file's mode.
- **Open files.** On NTFS and ReFS a file another program holds open is
  replaced all the same: that program keeps the old content until it closes,
  and the write succeeds. Only a file system without the extended rename
  (FAT, exFAT) fails the write when the destination is held open without
  sharing deletion.

## What still refuses

- **`full_access`.** An AppContainer has no network and reads only what it
  is granted, so an approved command cannot leave the workspace sandbox for
  the base layer alone. Bypass runs commands without a sandbox.
- **Shell commands and shell scripts, when the runtime's shell is missing
  or cannot start inside the sandbox**
  ([Shells and scripts](#shells-and-scripts)). Bypass runs them in Git
  Bash.
- **Copilot**, including its reviewer, in every mode. It runs with the base
  layer alone, which Windows does not have.
- **The daemon's retired Python worker** (`execute_code`) and the file
  callbacks it reaches. Code runs on the bot's own computer (Computer use).

## Residual risks

- **cmd.exe's del.** The bundled shell removes a file the container may delete;
  cmd's own del and rmdir refuse some of the same files with "Access is
  denied" even though the ACL allows the deletion and the file carries no
  read-only flag. Commands run through cmd /c may need `rm` from the bundled
  shell for those deletions.

- **Hard links.** A file with more than one name is never granted, since its
  DACL is shared with names outside the tree. A link made later by a process
  outside the sandbox to a file a container was granted shares that grant.
- **Moved files.** Grants are written onto each file. A file moved out of a
  granted root keeps them until reset; a file moved in has none, so a command
  can neither read, change nor delete it until the next command of that
  policy walks the root again.
- **New metadata and secrets.** `.git` folders and `.env` files created
  while a command runs inherit the root's allow. They lose it from the next
  command on.
- **Permissions applied again.** A tool that applies inheritance again across
  a workspace, such as `icacls /reset /t` or Explorer's "Replace all child
  object permission entries", gives protected entries the workspace's allow
  until the next command of that policy finds the change and caps them
  again.
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
- **The shell's dialect.** ash is not Bash: arrays, brace expansion and
  `declare` fail, in commands and in `.bash` scripts alike. Bypass runs Bash.
- **MSYS programs.** Git for Windows' MSYS programs, Git Bash and the tools
  in its `usr\bin` such as `less`, cannot start in a container. `git` itself
  can, but a hook or alias that needs Git's own `sh` fails.
- **The shell is a third-party binary.** Every Windows build downloads
  BusyBox from frippery.org at its pinned checksum and fails while that site
  is down; the pin must move before frippery.org deletes the build, about
  three years after its release. Some antivirus software flags busybox.exe,
  and Windows Security scans every copy the shell starts, which slows
  commands that start many processes.
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
`pi/launch.mjs`, and the shell contained commands run in is the sibling
`bin/busybox.exe`. Neither a `.cmd` daemon nor a symlink supplies this
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
1 MiB. On Windows it walks handles that follow no reparse point and renames
over the target through its folder's handle
([Pi's write and edit](#pis-write-and-edit)), with no pathname fallback.

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
link, and pipes, devices and other reparse points are refused — including
files in OneDrive and other cloud-synced folders, even fully downloaded
ones, which are reparse points. Commands
the daemon looks up take the `PATHEXT` extensions in turn and either
separator, and the user's own folders are under the profile.

The Windows CLI contract also installs a separate native argument forwarder at
`<user-profile>/.local/bin/hexbot.exe`, with a `hexbot.json` home/hash ownership
sidecar. It selects the immutable daemon through `native-current.json`; it is
not a stable daemon or a command script. It sits in the user's profile, which
no container is granted.

## Verification

Two native jobs build the production source on `windows-latest`, run its
probes as a newly created local standard user, and publish nothing:

- `.github/workflows/windows-contract.yml`, job `sandbox`, runs
  `tests/windows_sandbox.rs` against real AppContainers, ACLs, sockets and
  processes: workspace writes with Git metadata, secrets, junctions and hard
  links kept out, Git metadata that cannot be moved aside, ACL entries that
  never deny and leave secrets none, read-only Manual, one container per
  policy, no network or loopback, Node inside, process trees that end with
  the helper, root refusals, journal and reset, and argument quoting. The
  startup probe must run. The job stages the pinned BusyBox beside the
  daemon binary (`scripts/desktop/stage-busybox.mjs`), so the shell probe
  must run it in a container, print its nonce and take its grant back, and
  the shell must run a pipe inside a policy, write the workspace, leave Git
  metadata and the secret unchanged, hold only a read-and-run entry on its
  own file, keep the container's name, and take every quoting case as
  given. Run without a staged shell, those checks say they were skipped.
- `.github/workflows/windows-security.yml` runs the production Pi extension
  probes and the compiled `tests/windows_security.rs` boundary probe, with
  the daemon binary as the sandbox helper. The probe checks that Auto writes
  the workspace and Manual writes nothing, that a project `.env` stays
  unreadable, that full access refuses, and that network, device, stream and
  reserved paths refuse by their text before any access. Through the real
  Runtime and a trusted Pi transport fixture it checks that session settings
  name the sandbox, that `hexbot_sandbox_policy` gives Pi a policy that runs
  in the container, that execute_code refuses before approval, that the
  private write/edit bridge writes and edits the workspace with a live policy
  snapshot, commits an edit only to the file it read, and refuses Bypass, a
  stale snapshot, protected names and network, device, stream and
  missing-drive paths by their text, and that an Auto `.sh` scheduled script
  runs in BusyBox and writes the workspace while a Manual one writes nothing.
  The job stages the pinned BusyBox beside the helper, so a shell refusal
  fails it; without one, both scripts refuse with the daemon's reason and
  session settings carry it. Copilot refuses
  before path or command resolution. Runtime and selection files stay
  byte-identical, owned Pi processes stop, and no container profile is left
  registered.

The `native-runtime` job of `windows-contract.yml` also runs
`tests/windows_file_tools.rs`, which drives the bridge's handles directly:
writes that create folders and replace files without following a junction or
file link and leave other hard-link names alone, edits that refuse a
replaced, deleted or moved file, a folder or read-only file at the target,
oversized requests, and paths that reach an entry by an 8.3 short name.

The extension probes start before import and tool registration, with hostile
UNC `HOME` and `USERPROFILE` values. Only trusted module loading and the
explicit session config may access the filesystem. They cover Auto, Manual,
unknown modes, approved `full_access` attempts, parallel calls, direct
execution without a gate grant, the user-command hook, and a Bypass grant
invalidated by a mode change. Without the sandbox every local tool refuses
before file access, shell discovery, approval or spawn; with it, the probes
check the helper's command line and environment, the rechecks, timeouts and
Stop, path refusals by text, reads through junctions and credential files
kept private, and that write and edit reach the daemon's bridge. A second
pass uses real OS entry points with a malicious `git.exe` on `PATH` and
verifies no marker or workspace file was written and runtime selection was
unchanged.

Both jobs build the checked-out commit itself: the daemon has no platform
guard, so the probes test the source that ships. They upload no executable
or artifact.

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
