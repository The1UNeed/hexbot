# macOS PDF VM helper

`hexbot-pdf-vm` runs one PDF render in a fresh Linux guest using public
Virtualization.framework APIs. It targets macOS 12 or later. The helper and
guest assets must match the physical Mac's architecture. An Intel helper
running under Rosetta fails before starting a guest.

Build and ad-hoc sign a local helper:

```sh
backend/pdf-runtime/macos/build.sh /tmp/hexbot-pdf-vm arm64
# Intel build, also cross-compilable on Apple silicon:
backend/pdf-runtime/macos/build.sh /tmp/hexbot-pdf-vm-x86_64 x86_64
```

Release packaging must apply its Developer ID signature with
`entitlements.plist` before hashing the native bundle.

Place the helper beside `manifest.json`, `kernel`, `initramfs`, and `rootfs`,
or supply their directory explicitly:

```sh
/tmp/hexbot-pdf-vm --assets /absolute/path/to/assets \
  -png -r 150 -f 1 -l 25 -W 8193 -H 8193 /absolute/path/to/input.pdf
```

The manifest has version `1`, architecture `aarch64` or `x86_64`, and a `files`
mapping containing SHA-256 digests for those three fixed asset names. The helper
checks each regular file and its digest before boot. Installed asset directories
are trusted runtime files; these checks do not defend against their owner
replacing a path between verification and the framework opening it.

The input is a regular PDF file of at most 45 MiB. Its bytes cross the VM's
private vsock connection; its host path is never mounted inside the guest.
Stdin is unused. Stdout contains ordered, concatenated PNG pages, bounded at
99,090,240 bytes. Diagnostic stderr is limited to 16 KiB and cannot block the
VM queue. See the [guest protocol](../guest/PROTOCOL.md).

Each guest has 768 MiB RAM, one CPU, a read-only root disk, no network device,
and no shared host directories. Guest RAM is a parser allocation boundary;
the host also needs memory for VM services and its bounded output buffers.
Rendering stays at 150 dpi. The daemon validates the 8192-pixel page limit
against the renderer's 8193-pixel crop sentinel.

The same 120-second deadline covers validation, boot, transfer and stopping.
Success requires a complete successful terminal frame and a stopped VM. The
helper closes the response channel at that frame; subsequent guest bytes have
no meaning and are discarded during teardown. Signals and parent exit stop the
owned guest. At the hard deadline the helper exits;
VM service teardown on owner death is covered by the macOS integration probes.
There is no host-renderer fallback in this helper.

Exit statuses are fixed so the daemon can provide an actionable error without
parsing diagnostic text: `65` invalid input, `69` unsupported virtualization or
native architecture, `78` setup/assets/configuration failure, `80` output limit,
`1` guest render, protocol or cancellation failure, and `124` deadline. Malformed
transport frames remain protocol failures. Success exits `0`.

Run the focused boundary tests with disposable build output:

```sh
xcrun swift test --package-path backend/pdf-runtime/macos \
  --scratch-path /tmp/hexbot-pdf-swift-tests --triple arm64-apple-macosx12.0
```
