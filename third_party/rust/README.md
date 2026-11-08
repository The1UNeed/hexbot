# Vendored Rust dependencies

## glib 0.18.5

The Linux Hexbot Installer uses the GTK 3 bindings through Tauri. Those bindings
require glib 0.18. This copy contains the complete published glib 0.18.5 crate,
with the two-line upstream fix for RUSTSEC-2024-0429 applied to
`glib/src/variant_iter.rs`. The fix makes the pointer passed to
`g_variant_get_child` a mutable out-argument. No public API or dependency version
was changed.

- Original archive: <https://static.crates.io/crates/glib/glib-0.18.5.crate>
- Archive SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Original source commit: `42b9caf98e03ded086362d9653ca58fe94dc8658`, also recorded
  in `glib/.cargo_vcs_info.json`.
- Upstream fix: <https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34>
- Advisory: <https://rustsec.org/advisories/RUSTSEC-2024-0429.html>
- Upstream license and attribution: `glib/LICENSE` and `glib/COPYRIGHT`.

The Tauri manifest patches crates.io resolution to this directory. Keep the
truthful 0.18.5 package version. Upstream 0.18.5 is still affected by the advisory.
`cargo audit` excludes local path packages, so it no longer reports this copy;
that omission does not verify the backport. There is no advisory ignore rule.
The exact source fix and this provenance record explain the remediation. Remove
the backport when the supported GTK/Tauri graph can use an upstream release
that contains the fix.

Iterator regressions must run with optimizations. The original code can pass
debug tests while crashing in a release build. Run the focused upstream tests
from a disposable copy so Cargo's standalone lockfile and build output do not
change the vendored source:

```sh
probe_dir=$(mktemp -d)
cp -R third_party/rust/glib "$probe_dir"
CARGO_TARGET_DIR="$probe_dir/target" cargo test --release \
  --manifest-path "$probe_dir/glib/Cargo.toml" --lib variant_iter::tests
rm -rf "$probe_dir"
```
