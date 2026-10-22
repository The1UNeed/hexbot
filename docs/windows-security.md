# Windows security status

Windows is unsupported. The build and installation ports do not supply the
containment that Auto and Manual promise on macOS and Linux. No Windows
release or production publishing is enabled by this security foundation.

Auto and Manual refuse local commands, Python code and Pi's read, write,
edit, grep, find and ls tools. Refusal happens before approval, shell discovery,
workspace scanning, file access or process creation. `full_access`, a user
approval, an Auto model review and an Allow for now grant cannot override it.
Unattended scripts refuse in every mode. The lower-level Windows Git metadata
reader and Unix path walker also refuse instead of using incomplete path checks
or a blocking file open followed by a metadata check.
Copilot ACP, including its reviewer and Bypass paths, refuses before workspace,
environment-file or executable resolution. Its base isolation remains mandatory.

Bypass removes approval and containment. Its shell is upstream Pi Bash, such
as Git Bash, with Bash syntax and Pi's normal error if Bash is absent. It does
not use `cmd.exe` under a Bash label. Files, credentials and the network are
accessible with the daemon user's permissions in Bypass. It supplies no security
signoff for Windows support.

## Runtime contract

The daemon is a direct `hexbot.exe`. A validated selection in
`runtime/native-current.json` identifies an immutable build under
`runtime/native/<build>/hexbot.exe`. Bundled Node is an absolute sibling
`node.exe`, launched with the sibling `pi/launch.mjs`. Neither a `.cmd` daemon
nor a symlink supplies this contract. Managed Python lives under
`runtime/tools/code-python/Scripts/python.exe`.

Children inherit only the shared credential policy's explicit environment list.
Windows adds the OS/profile location names `SystemRoot`, `WINDIR`, `USERPROFILE`,
`APPDATA` and `LOCALAPPDATA`, matched case-insensitively. Provider keys and runtime
injection variables remain excluded. These locations support Windows runtime and
profile discovery; they grant no filesystem permission. See Microsoft's
[environment block contract](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables)
and Node's [Windows home-directory lookup](https://nodejs.org/api/os.html#oshomedir).

The base home-write restriction protects selection and installed runtimes.
Output exceptions must not overlap `runtime/native-current.json`,
`runtime/native`, `runtime/tools`, `runtime/bin`, `bin`, or `python`. A future
Windows boundary must enforce this on handles and child processes too. A
validated launcher path alone does not contain agent code.

There is no managed trusted Windows Git scanner yet, so metadata scanning
refuses. Do not fall back to `git` from `PATH`. Rust resolves Windows executable
names before calling CreateProcess and can search the parent's `PATH` even
after `env_clear`. Rust does not automatically search the child's working
directory. A malicious Git is relevant when an untrusted directory is actually
on one of the searched paths. See [Rust's executable resolution](https://doc.rust-lang.org/std/process/struct.Command.html#method.new).

## Verification

`.github/workflows/windows-security.yml` installs pinned Pi dependencies and
executes the production extension on `windows-latest` as a newly created local
standard user. The test verifies that the account has no administrator token.
The workflow grants access only to a disposable test directory and publishes
nothing.

The extension probes start before import and tool registration, with hostile
UNC `HOME` and `USERPROFILE` values. Only trusted module loading and the explicit
session config may access the filesystem. The probes cover Auto, Manual,
unknown modes, approved `full_access` attempts,
parallel calls, direct execution without a gate grant, the user-command hook,
and a Bypass grant invalidated by a mode change. Filesystem and process entry
points throw if reached during these probes. A second pass uses real OS entry
points with a malicious `git.exe` on `PATH` and verifies no marker or workspace
file was written and runtime selection was unchanged. Device, pipe, drive,
UNC and alternate stream path inputs are refused before the Unix path walker.
No command starts, so these refusals allocate no AppContainer profile, ACL
grant or process tree to clean up. These tests do not exercise a sandbox.

The combined job pins the build commit and checks out the security commit. A
shared preparation helper creates a detached worktree, applies the security
diff, and records both inputs and the combined Git tree. If the build already
contains the security commit, it keeps that tree unchanged. It requires exactly
one occurrence of the exact unsupported-platform guard bytes, and removes only
those bytes in the disposable source. It logs the guard diff and before/after
hashes. Production source retains its guard, with no feature or compile option
that bypasses it. The workflow uploads no executable or artifact.

The compiled integration probe invokes the actual Rust Runtime through a trusted
Pi transport fixture. It verifies code refusal before approval in Auto and
Manual, refusal at every isolated-command level, and rejection of stored script
and monitor paths before workspace revalidation or script access in every mode.
It checks runtime/selection integrity and owned-fixture shutdown. The separate
extension probes use the production Pi implementation. These are refusal tests,
not successful sandbox execution or a complete daemon feature test.
The native bridge probe starts trusted runner Python in Bypass, synchronizes over
a socket, then changes the live mode to Auto or Manual. That same worker's
read/write/patch callbacks must refuse before approval or path resolution.

Other platforms run the extension gate probes with a simulated Windows platform.
That checks gate logic only. It cannot validate Windows paths, Windows security
APIs, ACL behavior or native containment. The compiled native test runs only in
the disposable combined source and requires `HEXBOT_WINDOWS_NODE` pointing to a
trusted absolute Node executable. A standalone extension pass does not establish
that the combined daemon builds or enforces every entry point.

## Requirements before enabling isolation

A replacement must support workspace writes in Auto, read-only Manual,
secret read denial and separate metadata/runtime write denial. It must deny
network access by default and preserve one documented shell dialect.
Unsupported filesystems, reparse paths, scan errors, resource exhaustion and
missing trusted executables must fail closed. Runtime executables need execute
access and the directory/DLL access their Python and Node dependencies require.

Do not grant recursive access to the whole user profile or rewrite its ACLs for
each command. AppContainer access uses the intersection of user and package
permissions, and explicit capabilities govern resources including the network.
An allow grant to a workspace also needs a complete treatment of protected
descendants, replacement/rename races and inherited permissions. If a design
changes host ACLs, it needs bounded cross-process serialization, SID-specific
cleanup that preserves other ACEs, and crash recovery before it can run
untrusted commands. See Microsoft's [AppContainer implementation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

Untrusted Windows files need a disk-only, handle-based open policy, covering
reparse ancestors, devices, pipes and alternate streams before reads can block
or reach a different target. Merely opening and checking metadata afterward is
insufficient. Microsoft's [CreateFile contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
describes device/pipe opens and reparse-point flags; those flags alone do not
establish this file boundary.

Before support is enabled, native standard-user tests must demonstrate working
quoted shell and Python commands, allowed workspace writes, denied reads of
`connect.json`, workspace `.env` and SSH credentials, denied writes to Git hooks
and config and installed runtime/selection files, and denied network access.
They must cover scan failures and limits, hostile executable search paths,
parallel commands, Stop, timeout and crash recovery, with no leaked profiles,
ACE grants or orphaned children. The complete combined daemon needs the same
validation. GPT and Opus review approval and explicit parent approval are still
required before shipping or production publishing.
