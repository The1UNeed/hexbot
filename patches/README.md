# Dependency security backports

These patches keep the installed major versions and their public APIs. Remove a
patch when its consumers support a release containing the fix. The package
versions still appear in registry audits; none of these advisories is suppressed.

- `glob@13.0.6.patch` and `glob@10.5.0.patch` backport the abort returns and resume adjustment from
  [upstream commit 4682e8c](https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7),
  fixing GHSA-3g3m-2fjr-6pw4. Expo's first-match and TypeScript discovery helpers
  use cancellation to stop directory traversal.
- `minimatch@10.2.6.patch` and `minimatch@9.0.9.patch` backport the expansion limit and large-set deduplication
  limit from [upstream commit 77a0f5c](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8),
  fixing GHSA-g3hv-75wg-m249. Glob selects optimization level 2, which enables
  the affected preprocessing. Direct default-level matching does not enable it.
- `deepmerge@4.3.1.patch` rejects `__proto__` keys in both input-copy loops,
  fixing the returned-object prototype poisoning demonstrated in
  [upstream issue 273](https://github.com/TehShrike/deepmerge/issues/273).
  It preserves ordinary `constructor` and `prototype` data keys. Expo uses this
  package to merge local app configuration and plugin options.
- `ts-deepmerge@6.2.0.patch` backports the built-in method guard from
  [upstream commit 305a058](https://github.com/voodoocreation/ts-deepmerge/commit/305a05831a462fb2c353d3cbbff55a0733286f8c),
  fixing GHSA-87mf-gv2c-c62c while preserving the default-export API EAS uses
  when generating local project configuration. The guard applies to keys the
  merge processes. Version 6 still copies a nested object by reference when no
  object exists at that key in the other input; this patch does not turn it into
  a recursive input sanitizer.

Joi uses the same-major security release 17.13.9. It fixes the multiple-email
whitespace split described in
[GHSA-4528-x5fx-h6hg](https://github.com/hapijs/joi/security/advisories/GHSA-4528-x5fx-h6hg).

Glob's default exports use its shipped unbundled build, also available upstream
as `glob/raw`. Its minified bundle embeds both vulnerable libraries and would
bypass the patched dependencies. Both CommonJS and ESM builds are patched.
Deepmerge's UMD build
and unbundled source have the same guard. Verify installed behavior with:

```sh
node --test scripts/desktop/dependency-security.test.mjs
```

The separately installed Pi runtime remains pinned to 1.0.1. It embeds a copy of
minimatch in its own bundle, so pnpm patches and npm overrides cannot change that
copy. Its model and resource matching callsites use optimization level 1, which
does not run the affected preprocessing. A later Pi upgrade must recheck both
the embedded code and its callsites.
