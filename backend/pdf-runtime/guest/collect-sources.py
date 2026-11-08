#!/usr/bin/env python3
"""Collect source bytes without executing APKBUILDs, source hooks or compilers.

The result is an evidence collection, never a distribution-compliance verdict.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import selectors
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
MAX_DOWNLOAD = 1024 * 1024 * 1024
MAX_RECIPE = 4 * 1024 * 1024
MAX_LICENSE = 2 * 1024 * 1024
MAX_SCAN = 4 * 1024 * 1024 * 1024
MAX_TAR_METADATA = 64 * 1024 * 1024
RUST_VERSION = "1.97.1"
RUST_COMMIT = "8bab26f4f68e0e26f0bb7960be334d5b520ea452"
RUST_KEY = "108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE"
RUST_SOURCE_HASHES = {
    "rustc-1.97.1-src.tar.xz": "0ed06fdaffd4722a7702e0b4eebfafc897ab8f513e8e1b247cdd7e5c6df6ded2",
    "rust-src-1.97.1.tar.xz": "e9a1e616d04c6845895c827a178b9227f7c7199f3f4a80af81ab3aff7b80156b",
}
LIBC_HASH = "ce5d3ddc6d3fa000eb1536d85e147bfe31aacaba692ed6a876f95cb7c855be78"
MUSL_HASH = "a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4"
MUSL_CROSS_COMMIT = "3635262e4524c991552789af6f36211a335a77b3"
MUSL_CROSS_HASH = "60bed670d689d5c2164020960df36b80189dc5617e9763e023672f98a99d567e"
EXCLUDED = {"target", "assets", "build", "__pycache__", ".build", ".swiftpm"}
LICENSE_HASHES = {
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt": "b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5",
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/curl.txt": "272d1239bdcef73bb98bac206168ca1040bd4a31296755fadfb7515bcea18df3",
    "https://www.mozilla.org/media/MPL/2.0/index.txt": "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04",
    "https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/LICENSE": "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2",
}
REVIEWED_NOTICE_ABSENCES = {
    "alpine:main:alpine-keys:b9f23becced4d7b3ccc0fa0f28530243ccd314a0",
    "alpine:main:alpine-base:105b835acd9971b9770fb61f5a1ddcc133c180dc",
}


def digest(data, algorithm="sha256"):
    return hashlib.new(algorithm, data).hexdigest()


def file_hash(path, algorithm="sha256"):
    result = hashlib.new(algorithm)
    with path.open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            result.update(data)
    return result.hexdigest()


def trusted_gpg():
    path = Path("/usr/bin/gpg")
    if not path.is_file():
        return None
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not os.access(path, os.X_OK):
        raise ValueError("system GPG must be a root-owned executable without group/world write access")
    return str(path.resolve())


def bounded_command(command, environment, timeout=30, limit=1024 * 1024):
    """Capture trusted-tool output while enforcing a deadline and combined cap."""
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment, bufsize=0)
    captured = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline, count = time.monotonic() + timeout, 0
    try:
        with selectors.DefaultSelector() as ready:
            for stream in captured:
                ready.register(stream, selectors.EVENT_READ)
            while ready.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ValueError("trusted tool timed out")
                for key, _events in ready.select(left):
                    chunk = os.read(key.fileobj.fileno(), min(65536, limit - count + 1))
                    if not chunk:
                        ready.unregister(key.fileobj)
                        continue
                    count += len(chunk)
                    if count > limit:
                        raise ValueError("trusted tool exceeded bounded output")
                    captured[key.fileobj].extend(chunk)
        try:
            code = process.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise ValueError("trusted tool timed out") from None
        if code:
            raise ValueError("Rust source detached-signature verification failed")
        return bytes(captured[process.stdout])
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in captured:
            stream.close()


def safe_name(name):
    path = PurePosixPath(name)
    if (not name or path.as_posix() == "." or path.is_absolute() or name != path.as_posix()
            or any(part in {".", "..", ""} for part in path.parts)
            or "\\" in name or ":" in name or len(name.encode()) > 255
            or any(ord(character) < 32 or ord(character) == 127 for character in name)):
        raise ValueError("unsafe collection path")
    return path


def bounded_tar(path, limit=MAX_SCAN, members=500000, mode="r|*"):
    """Gate raw and extended headers before tarfile processes their payloads.

    Normal PAX and GNU long names are needed by the retained upstream sources.
    Sparse formats are unnecessary for source/license collection and rejected
    before their additional map blocks can be processed.
    """
    counts = {"headers": 0, "metadata": 0}

    class CheckedTarInfo(tarfile.TarInfo):
        @classmethod
        def fromtarfile(cls, bundle):
            offset = bundle.fileobj.tell()
            if offset + tarfile.BLOCKSIZE > limit:
                raise ValueError("source archive scan limit")
            data = bundle.fileobj.read(tarfile.BLOCKSIZE)
            item = cls.frombuf(data, bundle.encoding, bundle.errors)
            item.offset = offset
            counts["headers"] += 1
            padded = (item.size + 511) // 512 * 512
            if item.size < 0 or counts["headers"] > members or offset + 512 + padded > limit:
                raise ValueError("source archive scan limit")
            if item.type in {tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                             tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK}:
                # Limit metadata bytes that tarfile may parse/allocate. Tar
                # padding is already covered by the physical archive bound.
                counts["metadata"] += item.size
                if item.size > MAX_LICENSE or counts["metadata"] > MAX_TAR_METADATA:
                    raise ValueError("source archive extension metadata limit")
            result = item._proc_member(bundle)
            if result.size < 0 or result.offset_data + (result.size + 511) // 512 * 512 > limit:
                raise ValueError("source archive effective payload limit")
            return result

        def reject_sparse(self, *_args):
            raise ValueError("sparse source archives are unsupported")

        _proc_sparse = reject_sparse
        _proc_gnusparse_00 = reject_sparse
        _proc_gnusparse_01 = reject_sparse
        _proc_gnusparse_10 = reject_sparse

    return tarfile.open(path, mode, tarinfo=CheckedTarInfo)


def render_notices(components, materials, texts):
    """Return deterministic UTF-8 notices; texts maps raw SHA256 to full bytes.

    The companion verifier can reproduce this independently while streaming
    license materials, without trusting an asserted notices-complete flag.
    """
    lines = ["PDF VM third-party licenses and copyrights\n\n",
             "Full collected license and copyright texts follow. Exact original bytes are retained\n",
             "in the companion archive. Identical byte sequences appear once below; every\n",
             "component/path reference is listed. SOURCES.json records remaining review gaps.\n\n"]
    for component in components:
        lines.append(component["id"] + ": " + ", ".join(component.get("licenses", [])) + "\n")
    unique = {}
    for item in materials:
        if item["role"] == "license":
            unique.setdefault(item["sha256"], []).append(item)
    for checksum, entries in sorted(unique.items()):
        lines.append("\n" + "=" * 72 + "\nSHA256 " + checksum + "\n")
        for item in entries:
            lines.append(item["component"] + " / " + item["path"] + "\n")
            if item.get("attribution"):
                lines.append("  " + item["attribution"] + "\n")
        data = texts[checksum]
        if digest(data) != checksum:
            raise ValueError("notice text differs from its material digest")
        try:
            body = data.decode("utf-8")
        except UnicodeDecodeError:
            body = data.decode("latin-1")
            lines.append("[Original text decoded as Latin-1; exact bytes remain in archive.]\n")
        lines.append("\n" + body + ("" if body.endswith("\n") else "\n"))
    return "".join(lines).encode("utf-8")


class Collector:
    def __init__(self, output, budget):
        resolved = output.resolve()
        for folder in [HERE.resolve(), (HERE.parent / "macos").resolve()]:
            if resolved == folder or folder in resolved.parents:
                raise ValueError("source collection output must be outside guest/helper sources")
        self.output = output
        self.stage = output / "materials"
        self.cache = output / "cache"
        for path in (self.stage, self.cache):
            path.mkdir(parents=True, exist_ok=True)
        self.ledger_path = output / "downloads.json"
        self.ledger = json.loads(self.ledger_path.read_text()) if self.ledger_path.exists() else {}
        self.budget = budget
        self.materials = {}
        self.components = []
        self.gaps = []
        self.notes = []

    def save_ledger(self):
        self.ledger_path.write_text(json.dumps(self.ledger, indent=2) + "\n")

    def fetch(self, url, sha512=None, sha256=None, limit=MAX_DOWNLOAD):
        if urllib.parse.urlparse(url).scheme != "https":
            raise ValueError("collection downloads require HTTPS")
        key = digest(url.encode())
        destination = self.cache / key
        recorded = self.ledger.get(url)
        used = sum(row["bytes"] for row in self.ledger.values())
        if used > self.budget:
            raise ValueError("cached inputs exceed the current unique source download budget")
        if recorded and destination.is_file() and destination.stat().st_size > limit:
            raise ValueError("cached source exceeds the current per-request download limit")
        if (recorded and destination.is_file() and destination.stat().st_size == recorded["bytes"]
                and file_hash(destination) == recorded["sha256"]
                and (not sha512 or file_hash(destination, "sha512") == sha512)
                and (not sha256 or file_hash(destination) == sha256)):
            return destination
        remaining = self.budget - sum(row["bytes"] for key, row in self.ledger.items() if key != url)
        bound = min(limit, remaining)
        if bound < 1:
            raise ValueError("unique source download budget exhausted")
        fd, name = tempfile.mkstemp(dir=self.cache, suffix=".partial")
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as target, urllib.request.urlopen(url, timeout=30) as response:
                if urllib.parse.urlparse(response.url).scheme != "https":
                    raise ValueError("non-HTTPS source redirect")
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > bound:
                    raise ValueError(f"source exceeds remaining download budget: {declared} bytes")
                count = 0
                while data := response.read(min(1024 * 1024, bound - count + 1)):
                    count += len(data)
                    if count > bound:
                        raise ValueError("source exceeded bounded download")
                    target.write(data)
            observed = file_hash(temporary)
            if ((sha512 and file_hash(temporary, "sha512") != sha512)
                    or (sha256 and observed != sha256)):
                raise ValueError("source checksum mismatch")
            temporary.replace(destination)
            self.ledger[url] = {"bytes": count, "sha256": observed,
                                "sha512": file_hash(destination, "sha512")}
            self.save_ledger()
            return destination
        finally:
            temporary.unlink(missing_ok=True)

    def put(self, path, component, role, data=None, source=None, url=None, upstream_file=None):
        destination = self.stage / safe_name(path)
        if (data is None) == (source is None):
            raise ValueError("exactly one material byte source is required")
        incoming = digest(data) if data is not None else file_hash(source)
        previous = self.materials.get(path)
        if previous and (previous["component"] != component or previous["role"] != role
                         or previous["sha256"] != incoming):
            raise ValueError("conflicting collection path")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if data is not None:
            destination.write_bytes(data)
        elif source is not None:
            shutil.copyfile(source, destination)
        row = {"path": path, "component": component, "role": role,
               "bytes": destination.stat().st_size, "sha256": file_hash(destination),
               "sha512": file_hash(destination, "sha512")}
        if url:
            row["url"] = url
        if upstream_file:
            row["upstreamFile"] = upstream_file
        self.materials[path] = row
        return row

    def licenses(self, archive, component, prefix, selected=None):
        found, total = [], 0
        selected = dict(selected or {})
        try:
            zipped = zipfile.is_zipfile(archive)
            with (zipfile.ZipFile(archive) if zipped else bounded_tar(archive, MAX_SCAN)) as bundle:
                members = bundle.infolist() if zipped else bundle
                for count, member in enumerate(members, 1):
                    size = member.file_size if zipped else member.size
                    name_in_archive = member.filename if zipped else member.name
                    regular = not member.is_dir() if zipped else member.isfile()
                    total += size
                    if count > 500000 or total > MAX_SCAN:
                        raise ValueError("source archive scan limit")
                    if not zipped:
                        # TarInfo is not retained for large source distributions.
                        # Each selected license is read at its current stream position.
                        bundle.members.clear()
                    parts = PurePosixPath(name_in_archive).parts
                    name = parts[-1] if parts else ""
                    is_license = (re.match(r"(?i)^(copying|copyright|licen[cs]e|notice|ofl|ftl)([.\-_]|$)", name)
                                  or any(part.lower() in {"licenses", "licences"} for part in parts))
                    extra = selected.get(name_in_archive)
                    if not (is_license or extra) or not regular:
                        continue
                    safe_name(name_in_archive)
                    if size > MAX_LICENSE:
                        raise ValueError("oversized license text")
                    with (bundle.open(member) if zipped else bundle.extractfile(member)) as source:
                        data = source.read()
                    if is_license:
                        path = prefix + "/" + name_in_archive
                        self.put(path, component, "license", data=data)
                        found.append(path)
                    if extra:
                        path, owner, role = extra
                        row = self.put(path, owner, role, data=data)
                        row["archiveMember"] = name_in_archive
                        selected.pop(name_in_archive)
        except (tarfile.TarError, ValueError) as error:
            self.gaps.append({"component": component, "kind": "license_scan", "error": str(error)})
        if selected:
            self.gaps.append({"component": component, "kind": "missing_source_members",
                              "members": sorted(selected)})
        return found

    def alpine(self, repository, origin, commit, packages, recipes_only):
        if repository not in {"main", "community"} or origin in {".", ".."} or not re.fullmatch(r"[a-zA-Z0-9+_.-]+", origin):
            raise ValueError("unsupported Alpine recipe origin")
        component = f"alpine:{repository}:{origin}:{commit}"
        prefix = f"alpine/{repository}/{origin}/{commit}"
        self.components.append({"id": component, "kind": "alpine", "origin": origin,
                                "sourceCommit": commit, "repository": repository,
                                "packages": sorted(p["name"] + "=" + p["version"] for p in packages),
                                "licenses": sorted({v for p in packages for v in p["license"]})})
        url = (f"https://gitlab.alpinelinux.org/alpine/aports/-/archive/{commit}/"
               f"aports-{commit}.tar.gz?path={repository}/{origin}")
        recipe_archive = self.fetch(url, limit=MAX_RECIPE)
        self.put(prefix + "/aports.tar.gz", component, "build", source=recipe_archive, url=url)
        files, links = {}, {}
        with bounded_tar(recipe_archive, 64 * 1024 * 1024, 10000) as archive:
            total = 0
            for count, member in enumerate(archive, 1):
                archive.members.clear()
                total += member.size
                if count > 10000 or total > 64 * 1024 * 1024:
                    raise ValueError("recipe directory exceeds scan limit")
                parts = PurePosixPath(member.name).parts
                if member.isdir():
                    continue
                if (len(parts) < 4 or parts[0] != f"aports-{commit}-{repository}-{origin}"
                        or parts[1:3] != (repository, origin)):
                    raise ValueError("recipe member outside expected directory")
                name = str(safe_name("/".join(parts[3:])))
                if name in files or name in links:
                    raise ValueError("duplicate recipe member")
                if member.issym():
                    links[name] = member.linkname
                    continue
                if not member.isfile():
                    self.gaps.append({"component": component, "kind": "nonregular_recipe_member",
                                      "member": member.name})
                    continue
                data = archive.extractfile(member).read()
                files[name] = data
                role = "recipe" if name == "APKBUILD" else "patch" if name.endswith(".patch") else "config"
                self.put(prefix + "/aports/" + name, component, role, data=data, upstream_file=name)
        for name, target in links.items():
            resolved = str(safe_name(posixpath.normpath(str(PurePosixPath(name).parent / target))))
            if resolved not in files:
                raise ValueError("recipe symlink target is not a collected regular member")
            files[name] = files[resolved]
            row = self.put(prefix + "/aports/" + name, component, "config",
                           data=files[name], upstream_file=name)
            row["archiveLink"] = target
        if "APKBUILD" not in files:
            raise ValueError("recipe archive lacks APKBUILD")
        recipe = files["APKBUILD"].decode()
        checksums = [pair for _, block in re.findall(r"(?ms)^sha512sums=([\"'])(.*?)\1", recipe)
                     for pair in re.findall(r"(?m)^\s*([a-f0-9]{128})\s+([^\n\r]+)$", block)]
        license_paths = []
        for checksum, name in checksums:
            safe_name(name)
            if name in files:
                if digest(files[name], "sha512") != checksum:
                    raise ValueError("local recipe input checksum mismatch: " + name)
                continue
            if recipes_only:
                continue
            errors = []
            for branch in ("v3.24", "edge", "v3.23"):
                source_url = f"https://distfiles.alpinelinux.org/distfiles/{branch}/{urllib.parse.quote(name)}"
                try:
                    source = self.fetch(source_url, sha512=checksum)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    errors.append(str(error))
            else:
                self.gaps.append({"component": component, "kind": "missing_distfile",
                                  "upstreamFile": name, "sha512": checksum, "errors": errors})
                continue
            role = "patch" if re.search(r"\.(patch|diff)(\.(gz|xz|bz2))?$", name) else "source"
            self.put(prefix + "/distfiles/" + name, component, role, source=source,
                     url=source_url, upstream_file=name)
            if any(name.endswith(suffix) for suffix in (".tar.gz", ".tar.xz", ".tar.bz2", ".tgz", ".crate", ".zip")):
                license_paths.extend(self.licenses(source, component, prefix + "/licenses/" + name))
            elif role == "source" and source.stat().st_size < MAX_LICENSE:
                data = source.read_bytes()
                if b"copyright" in data.lower() or b"permission to use" in data.lower():
                    path = prefix + "/licenses/" + name
                    self.put(path, component, "license", data=data, url=source_url)
                    license_paths.append(path)
        if not checksums or all(name in files for _, name in checksums):
            # Metadata-only/local-source packages still need their actual source bytes.
            self.put(prefix + "/local-source.tar.gz", component, "source", source=recipe_archive, url=url)
        if not license_paths:
            self.gaps.append({"component": component, "kind": "full_license_text_not_yet_collected"})

    def inventory(self, architecture, archive=None):
        result = {"version": 1, "architecture": architecture,
                  "completeCorrespondingSourceArchive": False, "archive": archive,
                  "components": self.components, "materials": list(self.materials.values()),
                  "outstanding": self.gaps, "upstreamNotes": self.notes,
                  "uniqueDownloadBytes": sum(p["bytes"] for p in self.ledger.values())}
        (self.output / "SOURCES.json").write_text(json.dumps(result, indent=2) + "\n")
        return result

    def supplement_licenses(self):
        """Keep full canonical terms alongside upstream's actual attribution.

        Two Alpine metadata/key packages have no explicit copyright notice in
        their exact source directories. Preserve that limitation; a maintainer
        name is not a copyright assignment.
        """
        roots = {component["origin"]: component for component in self.components if component["kind"] == "alpine"}
        for origin in ("alpine-baselayout", "lddtree", "mkinitfs"):
            if origin not in roots:
                continue
            component = roots[origin]
            reference = next((p for p in self.materials.values() if p["role"] == "license"
                              and p["path"].endswith("/LICENSES/preferred/GPL-2.0")), None)
            if reference is None:
                raise ValueError("collected Linux source lacks canonical GPL-2.0 terms")
            row = self.put("supplemental/" + origin + "/GPL-2.0.txt", component["id"], "license",
                           source=self.stage / reference["path"])
            row["copiedFrom"] = reference["path"]
        mit_url = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt"
        mit = self.fetch(mit_url, sha256=LICENSE_HASHES[mit_url], limit=MAX_LICENSE)
        for origin in ("alpine-keys", "alpine-base", "ca-certificates"):
            if origin not in roots:
                continue
            row = self.put("supplemental/" + origin + "/MIT.txt", roots[origin]["id"], "license", source=mit, url=mit_url)
            row["attribution"] = "Canonical SPDX MIT template; placeholder text is not a package copyright notice."
            if origin != "ca-certificates":
                if roots[origin]["id"] in REVIEWED_NOTICE_ABSENCES:
                    self.notes.append({"component": roots[origin]["id"], "kind": "upstream_notice_absence",
                                       "detail": "Reviewed exact package source and ancestor notice candidates provide no explicit copyright notice; exact source and canonical MIT template retained, with no holder inferred.",
                                       "reviewProof": "upstream-notice-absence-review.json"})
                else:
                    self.gaps.append({"component": roots[origin]["id"], "kind": "copyright_attribution_review",
                                      "detail": "This source commit is outside the reviewed upstream-notice absence records."})
        if "ca-certificates" in roots:
            component = roots["ca-certificates"]["id"]
            mpl_url = "https://www.mozilla.org/media/MPL/2.0/index.txt"
            self.put("supplemental/ca-certificates/MPL-2.0.txt", component, "license",
                     source=self.fetch(mpl_url, sha256=LICENSE_HASHES[mpl_url], limit=MAX_LICENSE), url=mpl_url)
            source = next(p for p in self.materials.values() if p["component"] == component and p["role"] == "source")
            with bounded_tar(self.stage / source["path"], MAX_SCAN) as archive:
                for member in archive:
                    if member.isfile() and PurePosixPath(member.name).name in {"c_rehash.c", "update-ca.c", "certdata.txt", "mk-ca-bundle.pl"}:
                        if member.size > 2 * MAX_LICENSE:
                            raise ValueError("oversized certificate attribution input")
                        # Original source headers retain the actual author/year.
                        self.put("supplemental/ca-certificates/" + PurePosixPath(member.name).name,
                                 component, "license", data=archive.extractfile(member).read())
            # The retained source bundle also includes curl's certificate-generation script.
            curl = next((p for p in self.materials.values() if p["role"] == "license"
                         and ":curl:" in p["component"] and p["path"].endswith("/COPYING")), None)
            if curl:
                self.put("supplemental/ca-certificates/curl-COPYING", component, "license",
                         source=self.stage / curl["path"])
            else:
                url = "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/curl.txt"
                self.put("supplemental/ca-certificates/curl.txt", component, "license",
                         source=self.fetch(url, sha256=LICENSE_HASHES[url], limit=MAX_LICENSE), url=url)
        if "font-noto-cjk" in roots:
            component = roots["font-noto-cjk"]["id"]
            commit = "523d033d6cb47f4a80c58a35753646f5c3608a78"
            url = f"https://raw.githubusercontent.com/notofonts/noto-cjk/{commit}/LICENSE"
            row = self.put("supplemental/font-noto-cjk/LICENSE", component, "license",
                           source=self.fetch(url, sha256=LICENSE_HASHES[url], limit=MAX_LICENSE), url=url)
            row["upstreamTag"] = "Sans2.004"
            row["sourceCommit"] = commit
        available = {p["component"] for p in self.materials.values() if p["role"] == "license"}
        self.gaps = [g for g in self.gaps if not (g["kind"] == "full_license_text_not_yet_collected"
                                                and g["component"] in available)]

    def toolchain(self, signature_proof=None, require_signatures=False):
        self.components.extend([
            {"id": "rust-std", "kind": "toolchain", "version": RUST_VERSION, "sourceCommit": RUST_COMMIT,
             "licenses": ["MIT OR Apache-2.0", "Apache-2.0 WITH LLVM-exception"]},
            {"id": "libc", "kind": "cargo", "version": "0.2.190", "licenses": ["MIT OR Apache-2.0"]},
            {"id": "musl", "kind": "static-libc", "version": "1.2.5+rust-1.97.1-patches", "licenses": ["MIT"]},
        ])
        scripts = ["musl-toolchain.sh", "musl.sh", "musl-cve-2026-6042.diff", "musl-cve-2026-40200.diff"]
        selected = {
            "rustc-1.97.1-src/git-commit-hash": ("rust/git-commit-hash", "rust-std", "build"),
            **{f"rustc-1.97.1-src/src/ci/docker/scripts/{name}":
               ("musl/rust-build/" + name, "musl", "patch" if name.endswith(".diff") else "build") for name in scripts},
            **{f"rustc-1.97.1-src/src/ci/docker/host-x86_64/{name}/Dockerfile":
               ("musl/rust-build/" + name + ".Dockerfile", "musl", "build")
               for name in ["dist-arm-linux-musl", "dist-x86_64-musl"]},
            **{f"rustc-1.97.1-src/src/bootstrap/src/core/build_steps/{name}":
               ("rust/bootstrap/" + name, "rust-std", "build") for name in ["compile.rs", "llvm.rs"]},
        }
        for name, expected in RUST_SOURCE_HASHES.items():
            url = "https://static.rust-lang.org/dist/" + name
            checksum = self.fetch(url + ".sha256", limit=4096)
            if not re.fullmatch(expected + r"\s+\*?" + re.escape(name) + r"\s*", checksum.read_text()):
                raise ValueError("official Rust checksum record differs from reviewed pin")
            source = self.fetch(url, sha256=expected)
            self.put("rust/" + name, "rust-std", "source", source=source, url=url, upstream_file=name)
            self.put("rust/" + name + ".sha256", "rust-std", "build", source=checksum, url=url + ".sha256")
            self.put("rust/" + name + ".asc", "rust-std", "build", source=self.fetch(url + ".asc", limit=65536), url=url + ".asc")
            self.licenses(source, "rust-std", "rust/licenses/" + name, selected if name.startswith("rustc-") else None)
        if (self.stage / "rust/git-commit-hash").read_text().strip() != RUST_COMMIT:
            raise ValueError("Rust source commit differs from the actual compiler")
        url = "https://static.rust-lang.org/rust-key.gpg.ascii"
        self.put("rust/rust-key.gpg.ascii", "rust-std", "build", source=self.fetch(url, limit=65536), url=url)
        self.signature_receipts(signature_proof, require_signatures)
        url = "https://static.crates.io/crates/libc/libc-0.2.190.crate"
        source = self.fetch(url, sha256=LIBC_HASH)
        self.put("worker/vendor/libc-0.2.190.crate", "libc", "source", source=source, url=url,
                 upstream_file="libc-0.2.190.crate")
        self.licenses(source, "libc", "worker/vendor/licenses")
        url = "https://www.musl-libc.org/releases/musl-1.2.5.tar.gz"
        source = self.fetch(url, sha256=MUSL_HASH)
        self.put("musl/musl-1.2.5.tar.gz", "musl", "source", source=source, url=url, upstream_file="musl-1.2.5.tar.gz")
        self.licenses(source, "musl", "musl/licenses")
        url = "https://codeload.github.com/richfelker/musl-cross-make/tar.gz/" + MUSL_CROSS_COMMIT
        source = self.fetch(url, sha256=MUSL_CROSS_HASH, limit=MAX_RECIPE)
        self.put("musl/musl-cross-make-" + MUSL_CROSS_COMMIT + ".tar.gz", "musl", "build", source=source, url=url)
        self.licenses(source, "musl", "musl/cross-make/licenses")
        with bounded_tar(source, MAX_SCAN, mode="r:*") as archive:
            root = "musl-cross-make-" + MUSL_CROSS_COMMIT + "/"
            members = {m.name: m for m in archive if m.isfile()}
            checksum = archive.extractfile(members[root + "hashes/musl-1.2.5.tar.gz.sha1"]).read().decode().split()[0]
            if checksum != file_hash(self.stage / "musl/musl-1.2.5.tar.gz", "sha1"):
                raise ValueError("musl source differs from the Rust-pinned toolchain checksum")
            for name, member in members.items():
                relative = name.removeprefix(root)
                if relative == "Makefile" or relative.startswith("patches/musl-1.2.5/") or relative == "hashes/musl-1.2.5.tar.gz.sha1":
                    if member.size > MAX_RECIPE:
                        raise ValueError("oversized musl build input")
                    self.put("musl/cross-make/" + relative, "musl", "patch" if relative.endswith(".diff") else "build",
                             data=archive.extractfile(member).read())

    def signature_receipts(self, proof, required=False):
        gpg = trusted_gpg()
        if gpg:
            results = self.check_rust_signatures(gpg)
        elif required:
            raise ValueError("trusted gpg is required to verify Rust source signatures")
        elif proof:
            results = json.loads((proof / "results.json").read_text())
        else:
            self.gaps.append({"component": "rust-std", "kind": "detached_signature_verification_pending",
                              "trustedPrimaryFingerprint": RUST_KEY})
            return
        for name, checksum in RUST_SOURCE_HASHES.items():
            records = [row for row in results if row.get("file") == name]
            if len(records) != 1:
                raise ValueError("Rust signature receipt is absent or duplicated")
            row = records[0]
            if (row.get("exit") != 0 or row.get("sha256") != checksum
                    or file_hash(self.stage / "rust" / name) != checksum
                    or row.get("bytes") != (self.stage / "rust" / name).stat().st_size
                    or row.get("trustedPrimaryFingerprint") != RUST_KEY
                    or not any(line.startswith("[GNUPG:] VALIDSIG " + RUST_KEY + " ")
                               and line.split()[-1] == RUST_KEY for line in row.get("validsig", []))):
                raise ValueError("Rust detached-signature receipt does not bind the pinned archive and key")
            for field, path in [("signature", self.stage / "rust" / (name + ".asc")),
                                ("publicKey", self.stage / "rust/rust-key.gpg.ascii")]:
                material = row.get(field, {})
                if (material.get("file") != path.name or material.get("bytes") != path.stat().st_size
                        or material.get("sha256") != file_hash(path)):
                    raise ValueError("Rust signature receipt does not bind actual " + field + " bytes")
            if row.get("trustedSigningFingerprint") != RUST_KEY:
                raise ValueError("Rust signature receipt signing fingerprint differs from the trusted pin")
        self.put("rust/signature-verification.json", "rust-std", "build",
                 data=(json.dumps(results, sort_keys=True, indent=2) + "\n").encode())

    def check_rust_signatures(self, gpg):
        results = []
        with tempfile.TemporaryDirectory(prefix="rust-gpg-", dir=self.output) as directory:
            home = Path(directory)
            home.chmod(0o700)
            command = [gpg, "--no-options", "--batch", "--no-tty", "--homedir", str(home),
                       "--no-auto-key-retrieve", "--no-auto-key-import", "--no-autostart"]

            def run(arguments):
                return bounded_command(command + arguments,
                                       {"PATH": os.defpath, "LC_ALL": "C", "GNUPGHOME": str(home)}).decode("utf-8", "strict")

            run(["--import", str(self.stage / "rust/rust-key.gpg.ascii")])
            primary, awaiting = [], False
            for line in run(["--with-colons", "--fingerprint", "--list-keys"]).splitlines():
                fields = line.split(":")
                if fields[0] in {"pub", "sub"}:
                    awaiting = fields[0] == "pub"
                elif fields[0] == "fpr" and awaiting:
                    primary.append(fields[9])
                    awaiting = False
            if primary != [RUST_KEY]:
                raise ValueError("Rust public key primary fingerprint differs from the trusted pin")
            for name in RUST_SOURCE_HASHES:
                source = self.stage / "rust" / name
                status = run(["--status-fd", "1", "--verify", str(source) + ".asc", str(source)])
                valid = [line for line in status.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
                results.append({"file": name, "bytes": source.stat().st_size, "sha256": file_hash(source),
                                "exit": 0, "validsig": valid, "trustedPrimaryFingerprint": RUST_KEY,
                                "trustedSigningFingerprint": RUST_KEY,
                                "signature": {"file": name + ".asc", "bytes": Path(str(source) + ".asc").stat().st_size,
                                              "sha256": file_hash(Path(str(source) + ".asc"))},
                                "publicKey": {"file": "rust-key.gpg.ascii", "bytes": (self.stage / "rust/rust-key.gpg.ascii").stat().st_size,
                                              "sha256": file_hash(self.stage / "rust/rust-key.gpg.ascii")}})
        return results

    def own_sources(self, kernel_config):
        for folder, component, prefix in [(HERE, "hexbot-pdf-worker", "worker"),
                                           (HERE.parent / "macos", "hexbot-pdf-vm", "macos")]:
            self.components.append({"id": component, "kind": "owned", "version": "0.1.0",
                                    "licenses": ["Apache-2.0"]})
            for source in sorted(folder.rglob("*")):
                relative = source.relative_to(folder)
                if set(relative.parts) & EXCLUDED:
                    continue
                if source.is_symlink():
                    raise ValueError("owned source snapshot contains a symlink")
                if not source.is_file():
                    continue
                self.put(prefix + "/" + relative.as_posix(), component, "source", source=source)
            for name in ["LICENSE", "NOTICE"]:
                self.put(prefix + "/" + name, component, "license", source=HERE.parents[2] / name)
        # The host integration is Apache-2.0; retain its source as useful context.
        integration = HERE.parents[1] / "hexbot-core/src/pdf_runtime.rs"
        if integration.is_file():
            self.put("macos/daemon/pdf_runtime.rs", "hexbot-pdf-vm", "source", source=integration)
        cargo = tomllib.loads((HERE / "Cargo.lock").read_text())
        packages = cargo.get("package", [])
        owned = [p for p in packages if p.get("name") == "hexbot-pdf-worker" and not p.get("source")]
        dependencies = [p for p in packages if p.get("name") != "hexbot-pdf-worker"]
        if (len(packages) != 2 or len(owned) != 1 or len(dependencies) != 1 or dependencies[0].get("name") != "libc"
                or dependencies[0].get("version") != "0.2.190"
                or dependencies[0].get("source") != "registry+https://github.com/rust-lang/crates.io-index"
                or dependencies[0].get("checksum") != LIBC_HASH):
            raise ValueError("worker Cargo.lock no longer matches the reviewed libc source")
        linux = next((c for c in self.components if c.get("origin") == "linux-lts"), None)
        if kernel_config is None:
            self.gaps.append({"component": linux["id"] if linux else "kernel", "kind": "actual_kernel_configuration_missing"})
        elif not linux or not kernel_config.is_file() or kernel_config.stat().st_size > MAX_RECIPE:
            raise ValueError("invalid actual kernel configuration input")
        else:
            self.put("runtime-configs/" + kernel_config.name, linux["id"], "config", source=kernel_config)

    def notices(self):
        unique = {}
        for item in self.materials.values():
            if item["role"] == "license":
                unique.setdefault(item["sha256"], []).append(item)
        destination = self.output / "THIRD_PARTY_NOTICES"
        texts = {checksum: (self.stage / entries[0]["path"]).read_bytes() for checksum, entries in unique.items()}
        destination.write_bytes(render_notices(self.components, self.materials.values(), texts))
        return {"bytes": destination.stat().st_size, "sha256": file_hash(destination),
                "licenseMaterials": sum(len(entries) for entries in unique.values()),
                "uniqueLicenseTexts": len(unique)}

    def companion(self, architecture, version, url_base):
        if architecture not in {"aarch64", "x86_64"}:
            raise ValueError("unsupported source companion architecture")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,100}", version):
            raise ValueError("invalid source companion version")
        url = urllib.parse.urlparse(url_base)
        if (url.scheme != "https" or url.hostname != "updates.hexbot.app" or url.username or url.password
                or url.port not in (None, 443) or url.query or url.fragment):
            raise ValueError("source companion URL base must be durable HTTPS")
        fd, name = tempfile.mkstemp(dir=self.output, suffix=".tar.gz.partial")
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as target, gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0, compresslevel=1) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
                    for path, item in sorted(self.materials.items()):
                        source = self.stage / safe_name(path)
                        if source.is_symlink() or source.stat().st_size != item["bytes"] or file_hash(source) != item["sha256"]:
                            raise ValueError("material bytes changed before companion assembly")
                        header = tarfile.TarInfo(path)
                        header.size, header.mode, header.mtime = item["bytes"], 0o644, 0
                        with source.open("rb") as material:
                            archive.addfile(header, material)
            checksum = file_hash(temporary)
            filename = f"hexbot-pdf-sources-{version}-{architecture}-{checksum}.tar.gz"
            temporary.replace(self.output / filename)
            return {"file": filename, "sha256": checksum, "bytes": (self.output / filename).stat().st_size,
                    "url": url_base.rstrip("/") + "/" + filename}
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=HERE / "assets.lock.json")
    parser.add_argument("--arch", choices=["aarch64", "x86_64"], required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--budget", type=int, default=MAX_DOWNLOAD)
    parser.add_argument("--recipes-only", action="store_true")
    parser.add_argument("--version", default="0.0.0-prototype")
    parser.add_argument("--url-base", default="https://updates.hexbot.app/pdf-sources")
    parser.add_argument("--kernel-config", type=Path)
    parser.add_argument("--rust-signature-proof", type=Path)
    parser.add_argument("--require-rust-signatures", action="store_true")
    args = parser.parse_args()
    collector = Collector(args.out, min(args.budget, MAX_DOWNLOAD))
    packages = json.loads(args.lock.read_text())["architectures"][args.arch]["packages"]
    if not packages:
        raise ValueError("architecture package lock is empty")
    grouped = {}
    for package in packages:
        if len(package["origin"]) != 1 or len(package["sourceCommit"]) != 1:
            raise ValueError("package must have exactly one source origin and commit")
        origin, commit = package["origin"][0], package["sourceCommit"][0]
        if not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise ValueError("invalid source commit")
        grouped.setdefault((package["repository"], origin, commit), []).append(package)
    for index, (key, group) in enumerate(grouped.items(), 1):
        try:
            collector.alpine(*key, group, args.recipes_only)
        except Exception as error:
            collector.gaps.append({"component": "alpine:" + ":".join(key), "kind": "collection_failure",
                                   "error": str(error)})
        collector.inventory(args.arch)
        print(json.dumps({"origin": key[1], "progress": f"{index}/{len(grouped)}",
                          "downloadBytes": sum(p["bytes"] for p in collector.ledger.values()),
                          "gaps": len(collector.gaps)}), flush=True)
    if args.recipes_only:
        return
    collector.supplement_licenses()
    collector.toolchain(args.rust_signature_proof, args.require_rust_signatures)
    collector.own_sources(args.kernel_config)
    notices = collector.notices()
    archive = collector.companion(args.arch, args.version, args.url_base)
    result = collector.inventory(args.arch, archive)
    print(json.dumps({"archive": archive, "notices": notices, "components": len(result["components"]),
                      "materials": len(result["materials"]), "outstanding": result["outstanding"],
                      "uniqueDownloadBytes": result["uniqueDownloadBytes"]}), flush=True)


if __name__ == "__main__":
    main()
