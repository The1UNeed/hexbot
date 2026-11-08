# PDF VM source companion

`collect-sources.py` collects real source inputs and full license texts. It
never evaluates an APKBUILD, runs a source hook, builds downloaded code, or
extracts an upstream archive onto the filesystem. Upstream archives remain
ordinary files inside the companion. Small recipe, patch, configuration and
license files are copied through bounded archive reads.

The output is evidence for review. It is not a legal clearance. The collector
always writes `completeCorrespondingSourceArchive: false`; release code must
not promote that value merely because files exist or a VM booted. The guest
lock and release provenance have their own readiness gates.

## Collect

Use Python 3.12 or newer in the disposable native builder. Keep its output
outside the checkout and the runtime asset directory. The asset builder's
`--kernel-config-out` provides the actual configuration from the authenticated
selected kernel APK before pruning.

```sh
python3 guest/collect-sources.py \
  --arch aarch64 \
  --out /pdf-sources \
  --version "$VERSION" \
  --url-base "https://updates.hexbot.app/daemon/native/$VERSION/macos-aarch64" \
  --kernel-config /proof/aarch64-kernel.config \
  --require-rust-signatures
```

The x86_64 command uses that architecture's reviewed package lock and actual
kernel configuration. An empty package lock is rejected. `--recipes-only`
collects a deliberately incomplete recipe inventory without downloading the
toolchain and upstream distfiles.

Install trusted system `gpg` at `/usr/bin/gpg` in that builder. The collector
requires a root-owned regular executable without group/world write access.
It does not select an executable from the caller's ambient PATH.
`--require-rust-signatures`
requires fresh detached-signature verification inside the collector, using a
temporary isolated keyring and the pinned primary fingerprint. It refuses to
substitute an external JSON receipt if GPG is unavailable. No source hooks or
downloaded executables are run. Without that flag, available system GPG is
still used to perform the same verification. Child stdout and stderr share a
hard 1 MiB capture limit and a 30-second deadline. An overflowing or timed-out
owned child is killed and waited on; source bytes are never printed.

For incomplete audit collections on hosts without GPG,
`--rust-signature-proof` names a directory containing `results.json` from an
actual isolated GPG verification of both pinned Rust source archives. Each
record binds the file, byte length, SHA256, successful exit, `VALIDSIG` status
and exact trusted signing/primary fingerprints, plus the actual signature and
public-key SHA256/byte lengths. The pinned full fingerprint is
`108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE`. The collector checks those bindings
and retains a canonical receipt. It retains the actual archives, detached
signatures and official public key so the check can be repeated. A receipt
is an audit record, not a substitute for running cryptographic verification.
Missing receipts remain an explicit gap.

Use a new temporary GPG home, `--no-options`, batch mode and disabled automatic
key retrieval/import. Check the primary fingerprint before accepting a
signature. Do not import these keys into a person's existing keyring. The
trusted fingerprint is documented in the Rust project's maintained rustup
issue [3757](https://github.com/rust-lang/rustup/issues/3757); release layout
and detached-signature conventions are documented by
[Rust infrastructure](https://forge.rust-lang.org/infra/channel-layout.html).

## Materials and provenance

- Every locked Alpine package is grouped by its exact repository, origin and
  aports commit. The original directory archive, APKBUILD and all local files
  are retained. Every literal SHA512 input in APKBUILD must have actual bytes
  matching its checksum, including patches and architecture configurations.
  The collector obtains those inputs from Alpine's official distfile mirrors.
- Metadata-only and local-source packages retain their complete aports source
  archive. Recipes are read as text, including their original build/install
  instructions; they are never executed by this collector.
- Rust 1.97.1 full source, standard-library source, official checksum files,
  detached signatures and public key are retained. The full source includes
  compiler-builtins, libunwind, vendored inputs and build recipes. Its commit
  file must match `8bab26f4f68e0e26f0bb7960be334d5b520ea452`.
- The worker's actual Cargo-locked libc 0.2.190 crate is retained unchanged,
  with its Apache and MIT texts. `Cargo.lock` must still contain its reviewed
  version and checksum.
- Rust's static musl is a separate component from Alpine's shared musl. Its
  source is musl 1.2.5 plus the Rust release's actual CVE patches. The exact
  Rust build scripts, target Dockerfiles, pinned musl-cross-make source and
  patch inputs are retained. The musl source SHA256 is pinned and its SHA1 is
  cross-checked against that exact toolchain commit's checksum file. Source
  metadata is paired with the builder's actual selected-archive linker trace;
  the collector alone does not prove which archive a compiler linked.
- Guest source, locks, boot files, build/verification scripts, tests and docs
  are copied under `worker/`. Native helper source/build files are under
  `macos/`, with the daemon's PDF integration source as context. Generated
  assets, Cargo output, Swift output and Python caches are excluded. Both
  components retain the repository's real Apache-2.0 `LICENSE` and `NOTICE`.

The Noto CJK source snapshot omits its full OFL text, so the collector also
retains the exact `Sans2.004` upstream commit's license. Where a source names
GPL-2.0 but does not contain its full text, the canonical GPL-2.0 file from the
collected kernel source supplies the full terms. Certificate source headers
retain their actual attribution alongside full MPL-2.0, MIT and curl terms.

Alpine's `alpine-base` and `alpine-keys` exact source directories declare MIT
but do not provide an explicit copyright notice. Their actual source and full
canonical MIT terms are retained. The inventory records this attribution
note rather than treating a maintainer name as a copyright assignment. The
reviewed absence is recorded as `upstream_notice_absence`, not as an omitted
available source or license material. Canonical MIT files are explicitly
labelled as templates in the inventory and generated notices. The factual
review proof is retained as `upstream-notice-absence-review.json` in the local
audit collection; this does not certify legal clearance.

## Output and verification

The collector emits:

- `hexbot-pdf-sources-<version>-<arch>-<sha256>.tar.gz`: deterministic USTAR
  inside gzip, with regular files only. No source inventory is embedded in
  this archive, avoiding a recursive archive hash.
- `SOURCES.json`: each component, path, role, byte length, SHA256, SHA512 and
  upstream checksum filename, companion descriptor, download count and
  unresolved gaps. The URL is the requested durable destination; producing
  this file does not publish it.
- `THIRD_PARTY_NOTICES`: complete collected license/copyright text with every
  component/path/hash reference. Exact duplicate byte sequences appear once.
  Non-UTF-8 originals remain unchanged in the archive and are represented as
  Latin-1 in the UTF-8 notices. No license body or attribution is truncated.
- `downloads.json`, `cache/` and `materials/`: local reproducibility state,
  not runtime assets or automatic publication inputs.

The pure function `render_notices(components, materials, texts)` accepts a
SHA256-to-original-bytes map and returns the deterministic notice bytes.
Release verification can regenerate these notices from checked companion
materials instead of trusting a flag or a prebuilt text file.

`verify-sources.py` checks the actual companion's full material set and hashes,
recipe input coverage and current owned source bytes. It rejects incomplete
prototype inventories. The outer archive admits no links, PAX/GNU extension
headers or special files. Current bounds are 8 MiB each for the source
inventory and full notices, 8 GiB for the material set, 4 GiB/500,000 members
per scanned upstream archive, and 2 MiB per copied license file. Raw tar
headers and padded payload ends are checked before extension processing;
ordinary PAX/GNU metadata is limited to 2 MiB per record and 64 MiB in total.
That allocation bound counts declared metadata payload bytes; 512-byte tar
padding remains covered by the separate physical archive-size bound.
Effective PAX sizes are checked again before yielding a member. Sparse
formats are rejected before their map blocks are processed. The collector
limits successful unique download URLs to 1 GiB by default and rehashes cached
bytes before reuse. A missing cache object may be fetched again without
double-counting its unchanged URL in that unique-input budget.

Run the focused collector and archive-verifier regressions with:

```sh
python3 -m unittest discover -s guest -p 'test_*.py' -v
```

Before producing the final companion, freeze the guest/helper source and all
build/verification files, then collect again. Any later owned-source edit
invalidates that companion's source correspondence and requires a new hash.
