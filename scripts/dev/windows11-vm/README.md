# Windows 11 x64 VM check

This candidate-only workflow runs on the public repository's free
`ubuntu-24.04` runner. It installs a fresh Windows 11 Enterprise evaluation
guest with native x64 KVM, two CPUs, 6 GiB RAM, a sparse 64 GiB system disk,
Microsoft-key OVMF Secure Boot, and a TPM 2.0 emulator. It uses built-in SATA
and Ethernet drivers. It does not publish packages or enable a Hexbot backend.

The guest installs the pinned October 2026 cumulative update, restarts, then
runs the existing full PSEC candidate as a standard local user. Success requires
Windows 11's native AMD64 client kernel, build 26300.9711 or newer within the
same build, Secure Boot, a ready TPM, the trusted Microsoft MXC signature,
and every containment assertion in the candidate script.

GitHub does not guarantee nested VM compatibility. A successful guest run
provides Windows 11 x64 evidence; a Linux setup failure does not establish
anything about Windows containment.

Run the `Windows 11 x64 VM` workflow on `t3/verify-windows-readiness`. It also
runs when its files or the candidate probe change on that branch. The workflow
has a 140-minute limit and the running VM has a 115-minute limit. The first
run may spend much of that time on installation and servicing. No paid runner,
cloud account, Microsoft account, or activation key is configured.

The password is generated for each run. The temporary directory contains the
unattended answer file, VM disks, and firmware state and has private host
permissions. WinRM uses NTLM message encryption and a host forward bound to
`127.0.0.1`. The payload and installer DVDs are ejected after bootstrap. Only
the evidence directory is uploaded. It contains the guest report archive,
QEMU/TPM output, and a final display capture, with seven-day retention. VM
disks, answer files, credentials, and Windows installation media are excluded.

The setup uses the official 90-day evaluation for testing. Windows and its
license are not redistributed. Each run discards its installation.

## Download provenance

`downloads.json` pins every guest download by URL and SHA256. Availability was
checked on October 18, 2026. The ISO download returned HTTP 200 and a size of
8,225,329,152 bytes. It contains build 26300.9457, which needs the update before
MXC's documented PSEC support boundary for 26H2.

- [Microsoft evaluation download](https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise)
  and [Microsoft's published ISO SHA256](https://support.microsoft.com/en-us/servicing/os/windows/docs/2026/09/verify-the-authenticity-of-a-windows-11-enterprise-evaluation-iso-file).
- [KB5127648 installation instructions and exact MSU links](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/10/kb5127648-windows-11-24h2-25h2-26h2-security-update).
  The checkpoint is KB5043080. Both MSU SHA256 values come from the
  [Microsoft Update Catalog](https://www.catalog.update.microsoft.com/Search.aspx?q=KB5127648),
  update ID `3aa52c0d-45db-47a4-be28-4b0042c5ac78`, download dialog
  `downloadInformation[0].files[*].sha256`, decoded from base64.
  The guest uses Microsoft's method 2. DISM receives the target package and
  discovers required checkpoints in the same directory, avoiding a forced
  installation of a superseded checkpoint.
- [Node 26.12.0 SHA256 list](https://nodejs.org/dist/v26.12.0/SHASUMS256.txt),
  entry `win-x64/node.exe`.
- [Official Python 3.13.9 embedded distribution](https://www.python.org/ftp/python/3.13.9/).
  Its SHA256 was computed from the official HTTPS download.
- [Microsoft MXC 1.0.1 release](https://github.com/microsoft/mxc/releases/tag/v1.0.1).
  The archive and native executable hashes match the existing candidate
  workflow. The guest also verifies the executable's Microsoft signature.

## Host and setup references

- [GitHub's KVM availability announcement](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)
  and [nested VM support limitation](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).
- [Ubuntu OVMF package files](https://packages.ubuntu.com/noble/all/ovmf/filelist)
  and [QEMU TPM configuration](https://www.qemu.org/docs/master/specs/tpm.html).
- [Microsoft unattended local accounts](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-useraccounts-localaccounts),
  [online account screen setting](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-oobe-hideonlineaccountscreens),
  and [first logon commands](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-firstlogoncommands).
- [Pywinrm transport and message encryption](https://github.com/diyan/pywinrm#encryption).

For a local input check without downloads or a VM:

```sh
python3 scripts/dev/windows11-vm/run.py --check
```
