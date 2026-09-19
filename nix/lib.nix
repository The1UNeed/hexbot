# nix/lib.nix — Shared helpers for nix stuff
#
# All Node packages in this repo are pnpm workspace members sharing a single
# root pnpm-lock.yaml.  buildPnpmPackage provides the shared pnpmDeps and
# pnpmConfigHook so individual .nix files don't duplicate them.
#
# Source filters (pythonSrc, per-package node srcs) reduce rebuild scope so
# that e.g. a .tsx change doesn't trigger a Python venv rebuild, and a .py
# change doesn't trigger a TUI/Web/Desktop rebuild.  Each derivation gets a
# filtered src that only includes files it actually needs, while keeping
# the repo-root directory layout intact for pnpmConfigHook workspace
# resolution.
#
# buildPnpmPackage returns packageJsonPath (e.g. "ui-tui/package.json")
# instead of a per-package devShellHook.  The root devshell hook
# (mkNpmDevShellHook) collects all package.json paths, stamps them,
# and if any changed, runs a single `pnpm install --lockfile-only` from
# root to update the lockfile, then `pnpm install --frozen-lockfile` if
# the lockfile changed.
{
  lib,
  stdenv,
  writeShellScriptBin,
  writeShellScript,
  coreutils,
  callPackage,
  nodejs_26,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
}:
let
  repoRoot = ./..;

  node_gyp_11_4_0 = callPackage ./node-gyp-11-4-0.nix { };

  nodejs = nodejs_26;

  # nixpkgs' pnpm 10.  The exact pin is the `packageManager` field of the
  # root package.json; any 10.x satisfying `engines.pnpm` reads the lockfile.
  pnpm = pnpm_10;

  # ── pnpm workspace discovery ───────────────────────────────────────
  # Single source of truth: the `packages` list of pnpm-workspace.yaml.
  # Everything below (workspace package.json discovery, the Python
  # source's JS-dir exclusions) is derived from this so the
  # topology is never duplicated.  Add a workspace to pnpm-workspace.yaml
  # and the nix build picks it up automatically.
  #
  # Nix has no YAML reader, so the list is taken by line: the `  - <glob>`
  # entries that follow the top-level `packages:` key, up to the next
  # top-level key.
  workspacePatterns =
    let
      lines = lib.splitString "\n" (builtins.readFile (repoRoot + "/pnpm-workspace.yaml"));
      step =
        acc: line:
        if line == "packages:" then
          acc // { inList = true; }
        else if !acc.inList || line == "" || lib.hasPrefix "#" line then
          acc
        else if lib.hasPrefix "  - " line then
          acc // { out = acc.out ++ [ (lib.removeSuffix "'" (lib.removePrefix "'" (lib.removePrefix "  - " line))) ]; }
        else
          acc // { inList = false; };
    in
    (lib.foldl' step {
      inList = false;
      out = [ ];
    } lines).out;

  # Expand a workspace glob (e.g. "apps/*") into concrete member dirs
  # relative to the repo root.  Only trailing "*" globs are supported —
  # that's all the workspace uses here.  Literal patterns (e.g. "ui-tui")
  # pass through unchanged.
  expandWorkspace =
    pattern:
    let
      parts = lib.splitString "/" pattern;
    in
    if lib.last parts == "*" then
      let
        parent = lib.concatStringsSep "/" (lib.init parts);
        entries = builtins.readDir (repoRoot + "/${parent}");
        dirs = lib.filterAttrs (_: t: t == "directory") entries;
      in
      map (d: "${parent}/${d}") (builtins.attrNames dirs)
    else
      [ pattern ];

  # All workspace member directories (relative paths), filtered to those
  # that actually carry a package.json — a glob like apps/* may match a
  # dir that isn't really a package.
  workspaceMemberDirs = builtins.filter (d: builtins.pathExists (repoRoot + "/${d}/package.json")) (
    lib.concatMap expandWorkspace workspacePatterns
  );

  # Top-level directory of each workspace member, deduplicated.  Used to
  # exclude JS/TS workspace trees from the Python source filter.  E.g.
  # apps/desktop + apps/shared + ui-tui + web → [ "apps" "ui-tui" "web" ].
  jsWorkspaceTopDirs = lib.unique (
    map (d: builtins.head (lib.splitString "/" d)) workspaceMemberDirs
  );

  # ── Source filters for reducing rebuild scope ──────────────────────
  # Changing a .tsx/.mjs file should NOT trigger a Python venv rebuild,
  # and changing a .py file should NOT trigger a TUI/Web/Desktop rebuild.

  # Python source: everything except JS/TS/docs/infra directories.
  pythonSrc = lib.cleanSourceWith {
    src = repoRoot;
    name = "hermes-python-source";
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString repoRoot + "/") (toString path);
        components = lib.splitString "/" relPath;
        topComponent = if components == [ ] then "" else builtins.head components;
        excludedDirs =
          # JS/TS workspace directories — derived from the pnpm workspace
          # so a new workspace member is excluded from the Python source
          # without touching this list.
          jsWorkspaceTopDirs ++ [
            # Documentation
            "docs"
            "website"
            # CI/infra
            "docker"
            ".github"
            # Content/examples
            "infographic"
            "datagen-config-examples"
            # unused packaging infra
            "packaging"
            # Test infrastructure
            "tests"
            # Plan/temp files
            "plans"
            # Nix build definitions (Python build doesn't need these)
            "nix"
            # Skills are shipped via HERMES_BUNDLED_SKILLS /
            # HERMES_OPTIONAL_SKILLS (see hermes-agent.nix), not via the
            # wheel's data_files — setup.py's _data_file_tree returns []
            # for a missing dir, so the wheel builds fine without them.
            # This keeps SKILL.md edits from rebuilding the Python venv.
            "skills"
            "optional-skills"
            # locales/ and optional-mcps/ are bare data dirs (no
            # __init__.py) shipped via symlinks + HERMES_BUNDLED_LOCALES
            # / HERMES_OPTIONAL_MCPS, not via the wheel. Excluding them
            # keeps catalog edits from rebuilding the Python venv.
            "locales"
            "optional-mcps"
          ];
        excludedFiles = [
          # JS root manifests
          "package.json"
          "pnpm-lock.yaml"
          "pnpm-workspace.yaml"
          # Docker files
          "Dockerfile"
          "docker-compose.yml"
          "docker-compose.windows.yml"
          # Nix build definitions — editing the flake shouldn't rebuild
          # the venv.  (Input changes rebuild regardless, via the lock.)
          "flake.nix"
          "flake.lock"
          # Root docs the wheel doesn't consume.  README.md and LICENSE
          # must stay — pyproject.toml references them (readme /
          # license-files).
          "AGENTS.md"
          "CONTRIBUTING.md"
          "SECURITY.md"
          "README.zh-CN.md"
          ".gitignore"
          "setup-hermes.sh"
        ];
      in
      if relPath == "" then
        true
      else if builtins.elem relPath excludedFiles then
        false
      else if builtins.elem topComponent excludedDirs then
        false
      else
        true;
  };

  # Common workspace resolution files needed by all Node builds.
  # A frozen pnpm install requires all workspace package.json files to
  # resolve workspace: protocol dependencies correctly.  Discovered from
  # pnpm-workspace.yaml — root manifests + every member's package.json.
  npmWorkspaceFiles = lib.fileset.unions (
    [
      (repoRoot + "/package.json")
      (repoRoot + "/pnpm-lock.yaml")
      (repoRoot + "/pnpm-workspace.yaml")
    ]
    ++ map (d: repoRoot + "/${d}/package.json") workspaceMemberDirs
  );

  # pnpm deps source: just what fetchPnpmDeps needs (root manifests +
  # workspace member package.jsons).  Much smaller than the full repo,
  # so changing source files won't invalidate the pnpmDeps derivation.
  npmDepsSrc = lib.fileset.toSource {
    root = repoRoot;
    fileset = npmWorkspaceFiles;
  };

  # pnpm dependencies for the whole workspace, shared by all members.  This
  # is a fixed-output fetch, so the hash must change whenever pnpm-lock.yaml
  # does.  lib.fakeHash is a placeholder: replace it with the `got:` hash nix
  # reports on the first build (`nix build .#web`), and again after every
  # lockfile change (`nix run .#update-pnpm-lockfile` rebuilds to surface it).
  pnpmDeps = fetchPnpmDeps {
    pname = "hermes-workspace";
    version = "0";
    src = npmDepsSrc;
    inherit pnpm;
    fetcherVersion = 3;
    hash = lib.fakeHash;
  };

  # Build a per-package node source: workspace resolution files + the
  # package's own directory tree(s).  Source ROOT is always the repo
  # root, preserving the workspace layout that pnpmConfigHook expects.
  # Callers pass the dirs they need (relative to
  # the repo root), so each package owns its own source scope.
  testFileFilter = lib.fileset.fileFilter (file: lib.hasInfix ".test." file.name) repoRoot;
  mkNpmSrc =
    dirs:
    lib.fileset.toSource {
      root = repoRoot;
      fileset = lib.fileset.difference (lib.fileset.union npmWorkspaceFiles (
        lib.fileset.unions (map (d: repoRoot + "/${d}") dirs)
      )) testFileFilter;
    };

  # Returns a mkDerivation-compatible function.

  # `dirs` is the single source of truth for what the package contains:
  # its first entry is the package's own folder (→ packageJsonPath), and
  # all entries scope the filtered src.  Packages that import source from
  # another workspace member (workspace: deps) must list that member's dir too,
  # e.g. apps/desktop depends on apps/shared.
  #
  # Usage:
  #   hermesNpmLib.buildPnpmPackage {
  #     dirs = [ "apps/desktop" "apps/shared" ];
  #     buildPhase = '' ... '';
  #     installPhase = '' ... '';
  #   }
  buildPnpmPackage =
    { dirs, ... }@attrs:
    let
      # The package's own folder is the first dir; it carries the
      # package.json that names the package.
      folder = builtins.head dirs;

      # Read package.json from the repo (the filtered src is a store path, but we can read the original)
      packageJson = builtins.fromJSON (builtins.readFile (repoRoot + "/${folder}/package.json"));
      defaultPname = packageJson.name or "unknown";
      defaultVersion = packageJson.version or "0.0.0";

      common = {
        inherit pnpmDeps;
        # No sourceRoot — the workspace root (with the single pnpm-lock.yaml)
        # is auto-detected as sourceRoot by nix, so pnpmConfigHook finds the
        # lockfile there.
        src = mkNpmSrc dirs;
        nativeBuildInputs = [
          nodejs
          pnpm
          pnpmConfigHook
        ];
        # Install only this member and the workspace packages it depends on.
        pnpmWorkspaces = [ "${defaultPname}..." ];
        ELECTRON_SKIP_BINARY_DOWNLOAD = 1;
        passthru = {
          packageJsonPath = "${folder}/package.json";
        };
      };

      # Remove `dirs` from the passed attrs (mkDerivation doesn't need it)
      attrsWithoutDirs = removeAttrs attrs [ "dirs" ];

      finalAttrs =
        common
        // attrsWithoutDirs
        // {
          pname = attrs.pname or defaultPname;
          version = attrs.version or defaultVersion;
        };
    in
    stdenv.mkDerivation finalAttrs;
in
{
  inherit pythonSrc nodejs pnpm buildPnpmPackage;
  node-gyp = node_gyp_11_4_0;

  # Regenerate the shared root lockfile and verify all Node packages still
  # build.  Exposed as a runnable package — `nix run
  # .#update-pnpm-lockfile` — so it's actually usable, unlike a bin buried
  # in a build sandbox's PATH.  All workspace packages share one lockfile,
  # so there's a single script (not one per package).
  updateNpmLockfile = writeShellScriptBin "update-pnpm-lockfile" ''
    set -euo pipefail
    # DEBUG=1 nix run .#update-pnpm-lockfile — trace every command
    [ -n "''${DEBUG:-}" ] && set -x

    REPO_ROOT=$(git rev-parse --show-toplevel)
    cd "$REPO_ROOT"

    export PATH="${lib.makeBinPath [ nodejs ]}:$PATH"
    rm -rf node_modules/
    ${lib.getExe pnpm} install --no-frozen-lockfile

    # pnpmDeps is a fixed-output fetch — rebuild every Node package to
    # verify the new lockfile resolves offline.
    if ! nix build .#tui .#web .#desktop; then
      echo "If the failure is a hash mismatch, copy the 'got:' hash into pnpmDeps in nix/lib.nix and rerun." >&2
      exit 1
    fi
    echo "Lockfile updated and all Node packages built."
  '';

  # Single devshell hook for all pnpm workspace packages.
  #
  # Takes a list of package.json relative paths (from buildPnpmPackage .passthru.packageJsonPath),
  # stamps all of them, and if any changed:
  #   1. Runs `pnpm install --lockfile-only` from root to update the lockfile
  #   2. If the lockfile changed, runs `pnpm install --frozen-lockfile`
  mkNpmDevShellHook =
    packageJsonPaths:
    writeShellScript "pnpm-dev-hook" ''
      REPO_ROOT=$(git rev-parse --show-toplevel)

      # Stamp all workspace package.jsons into one file.
      STAMP_DIR=".nix-stamps"
      STAMP="$STAMP_DIR/npm-package-jsons"
      STAMP_VALUE=$(
        ${coreutils}/bin/sha256sum ${
          lib.concatMapStringsSep " " (p: "\"$REPO_ROOT/${p}\"") packageJsonPaths
        } 2>/dev/null | ${coreutils}/bin/sort | ${coreutils}/bin/sha256sum | awk '{print $1}'
      )

      PKG_CHANGED=false
      if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$STAMP_VALUE" ]; then
        PKG_CHANGED=true
        echo "pnpm: package.json changed, updating lockfile..."
        ( cd "$REPO_ROOT" && ${lib.getExe pnpm} install --lockfile-only --reporter=silent 2>/dev/null )
        mkdir -p "$STAMP_DIR"
        echo "$STAMP_VALUE" > "$STAMP"
      fi

      # Check if lockfile changed (either from the install above or from an
      # external edit).  Runs a frozen install if so.
      LOCK_STAMP="$STAMP_DIR/root-lockfile"
      LOCK_STAMP_VALUE=$(sha256sum "$REPO_ROOT/pnpm-lock.yaml" 2>/dev/null | awk '{print $1}')
      if [ ! -f "$LOCK_STAMP" ] || [ "$(cat "$LOCK_STAMP")" != "$LOCK_STAMP_VALUE" ]; then
        echo "pnpm: pnpm-lock.yaml changed, running pnpm install --frozen-lockfile..."
        ( cd "$REPO_ROOT" && CI=true ${lib.getExe pnpm} install --frozen-lockfile --reporter=silent 2>/dev/null )
        mkdir -p "$STAMP_DIR"
        echo "$LOCK_STAMP_VALUE" > "$LOCK_STAMP"
      fi
    '';
}
