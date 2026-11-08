# PDF rendering guest

This Linux guest provides the macOS PDF rendering boundary.
[PROTOCOL.md](PROTOCOL.md) defines the single-job virtio socket exchange. The
helper is in `../macos/`. The daemon uses the VM by default on macOS; missing
assets produce a PDF runtime setup error. A custom host renderer requires
explicit `attachments.pdf_backend: host`; there is no automatic host fallback.
Linux keeps its native renderer. Raw builder output retains prototype source
and notice records until finalization succeeds.

The image contains an owned static Rust worker, pinned Poppler and libraries,
and DejaVu, Liberation and Noto CJK fonts. Root PID1 mounts a private 64 MiB
input tmpfs, forks one unprivileged worker, waits and powers off after any
worker exit. The worker accepts no command, executable, path or environment
from its peer. It runs the image-owned Poppler directly. Only bounded PNG
chunks cross back to the host. No renderer PNG files are written to disk.

The helper supplies 768 MiB RAM, one vCPU, an authenticated read-only ext4 root
image, no swap, no network device and no host directory/file mounts. It owns
the whole guest through completion and cancellation. Per-process Linux limits
are defense in depth, not substitutes for that whole-VM boundary.

## Build and verify

Use a disposable native Linux builder with 6 GiB RAM, two CPUs, PID limit 256,
core dumps disabled and no-new-privileges. No privileged container, VM access,
host home mount or filesystem mount is needed. The build uses ordinary root
inside that container only to run authenticated Alpine package tools in a
chroot. It creates ext4 with `mke2fs -d`, without mounting it.

Use Python 3.12 or newer. Install build tools
`musl-tools e2fsprogs cpio xz-utils python3 curl`, the pinned
Rust 1.97.1 toolchain and its architecture-matched `*-unknown-linux-musl`
standard library. Keep the repository layout, including this source directory,
`../macos/`, root `LICENSE` and `NOTICE`. This lets source verification compare
the actual build inputs. Then, from `backend/pdf-runtime/`:

```sh
cargo test --locked --manifest-path guest/Cargo.toml -- --test-threads=1
cargo clippy --locked --manifest-path guest/Cargo.toml --all-targets -- -D warnings
python3 -m unittest discover -s guest -p 'test_*.py' -v
python3 guest/build-assets.py --arch aarch64 --cache /work/apks --out /work/pdf-assets --kernel-config-out /work/pdf-kernel-config
```

The asset builder verifies exact byte lengths and SHA256 before extraction,
then every APK signature against keys in the authenticated minirootfs. It
refuses missing architecture locks, unknown mirrors and an input set over
200 MiB. Kernel/initramfs/rootfs caps are 64/32/192 MiB. The raw ARM64 kernel is
extracted from the locked Alpine EFI_ZBOOT image with checked offset/length,
bounded gzip decompression, CRC/size verification and ARM64 header validation.
It is not an unbounded decompression driven by the gzip size trailer.

Build each authenticated architecture lock on a matching native Linux builder;
the worker is a static architecture-matched ELF.
Intel uses the unchanged authenticated 64-bit bzImage, checked for boot/header
magic and 64-bit load flags. Each release target requires native VZ/PDF
qualification; cross compilation, QEMU and Rosetta do not establish it. Generated
assets and Cargo output are ignored. Do not commit them. Publish only finalized
and qualified runtime assets through the controlled release graph.

## Provenance and distribution status

`assets.lock.json` records official release hashes and each APK's SHA256,
version, license expression, upstream origin, Alpine source commit and pinned
APKBUILD URL. The complete package set is conservative: it includes build/init
inputs even when their executable files are pruned from the final root image.
Only the Rust worker and Poppler remain as root-image executable tools. The
initramfs uses trusted BusyBox shell for a fixed boot script, before any PDF
request is received. No shell is used in the request/render path.

The raw asset builder and collector emit **prototype** source and notice
records. A release-ready package lock does not replace source finalization or
architecture qualification. APK license metadata and source URLs alone are not
a complete license bundle or corresponding-source distribution. Before shipping,
collect license texts and complete corresponding sources, patches, build recipes
and kernel configuration for GPL/LGPL components, fonts and the static worker
toolchain. Record and retain the resulting source archive hash alongside the
runtime. Source byte verification and a successful VM boot do not certify legal
compliance. The controlled release graph must enforce the source, signing and
qualification gates for both targets.

`collect-sources.py` emits the companion source archive, candidate inventory and
full notices; `--require-rust-signatures` verifies both pinned Rust source
archives with an isolated trusted system GPG process. Pass the exported
`--kernel-config` file so the archive contains the exact authenticated kernel
configuration. See [SOURCE-COLLECTION.md](SOURCE-COLLECTION.md).

`finalize-assets.py --assets DIR --sources JSON --notices FILE --archive FILE
--lock assets.lock.json --arch ARCH --version VERSION --out NEWDIR` checks the actual companion
contents, pinned source recipes, build snapshot, kernel config and regenerated
notices before creating a separate finalized asset directory. It never promotes
the prototype inputs in place. `verify-sources.py` repeats the content and notice
checks for release staging. Source verification establishes recorded material
coverage and byte identity; architecture qualification and release signing remain
separate gates. The companion archive is published alongside Full and Headless
native runtimes with its immutable filename, hash, byte length and public URL.
Client packages contain no PDF runtime.

Release verification also requires `--version VERSION`, binding the companion's
filename and public update URL to that exact runtime version and architecture.
The version is supplied by the release graph, including its computed Nightly
version. The content-only `verify_materials` API checks prototype evidence without
making that release identity or completeness claim.
