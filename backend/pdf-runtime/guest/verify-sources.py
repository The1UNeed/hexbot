#!/usr/bin/env python3
"""Verify a PDF runtime's actual companion source materials without extraction.

This checks byte identity and declared source coverage. It does not replace
review of licensing or whether upstream material is sufficient to rebuild a
component. Incomplete prototype records always fail release verification.
Outer archives use USTAR+gzip; original upstream archives remain regular files.
"""
import argparse
from contextlib import contextmanager
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import tomllib
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
LIMIT = 8 * 1024**3
MAX_ARCHIVE_ENTRIES = 50_000
ROLES = {"recipe", "source", "patch", "config", "license", "build"}
STATIC_SOURCE_PINS = {
    "rust-std": {"0ed06fdaffd4722a7702e0b4eebfafc897ab8f513e8e1b247cdd7e5c6df6ded2", "e9a1e616d04c6845895c827a178b9227f7c7199f3f4a80af81ab3aff7b80156b"},
    "libc": {"ce5d3ddc6d3fa000eb1536d85e147bfe31aacaba692ed6a876f95cb7c855be78"},
    "musl": {"a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4"},
}
MUSL_CROSS_HASH = "60bed670d689d5c2164020960df36b80189dc5617e9763e023672f98a99d567e"


def fail(message):
    raise ValueError("PDF corresponding sources: " + message)


@contextmanager
def regular_file(path, limit):
    """Open once without following the final symlink or blocking on a FIFO."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 <= info.st_size <= limit:
            fail("file is not regular or its byte length exceeds the cap: " + str(path))
        yield file, info.st_size


def hash_stream(file, limit, expected_size):
    result = hashlib.sha256()
    count = 0
    while chunk := file.read(min(65536, limit - count + 1)):
        count += len(chunk)
        if count > limit:
            fail("file grew beyond its byte cap")
        result.update(chunk)
    if count != expected_size:
        fail("file changed size while being read")
    return result.hexdigest()


def digest(path, limit=LIMIT, minimum=0):
    with regular_file(path, limit) as (file, size):
        if size < minimum:
            fail("file is shorter than its required minimum: " + str(path))
        return hash_stream(file, limit, size)


def read_regular(path, limit):
    with regular_file(path, limit) as (file, size):
        data = file.read(limit + 1)
        if len(data) > limit or len(data) != size:
            fail("file changed size or exceeded its byte cap while being read")
        return data


def copy_regular(source, destination, limit):
    with regular_file(source, limit) as (file, size), destination.open("xb") as target:
        count = 0
        result = hashlib.sha256()
        while chunk := file.read(min(65536, limit - count + 1)):
            count += len(chunk)
            if count > limit:
                fail("file grew beyond its byte cap while being copied")
            target.write(chunk)
            result.update(chunk)
        if count != size:
            fail("file changed size while being copied")
        return result.hexdigest()


def load(path, limit=8 * 1024 * 1024):
    return json.loads(read_regular(path, limit))


def owned_snapshot(folder):
    result = {}
    for path in folder.rglob("*"):
        relative = path.relative_to(folder)
        if set(relative.parts) & {"target", "assets", "build", "__pycache__", ".build", ".swiftpm"}:
            continue
        if path.is_symlink():
            fail("owned source/build paths must not be symlinks: " + str(relative))
        if path.is_file():
            result[relative.as_posix()] = digest(path)
    return result


class ExpandedArchive:
    def __init__(self, file):
        self.file, self.count = file, 0

    def read(self, count):
        data = self.file.read(min(count, LIMIT - self.count + 1))
        self.count += len(data)
        if self.count > LIMIT:
            fail("expanded archive including headers/padding exceeds 8 GiB")
        return data


class PhysicalArchive:
    """Expose only the hashed compressed prefix, even if the file grows."""
    def __init__(self, file, size):
        self.file, self.size, self.count = file, size, 0
        self.sha256 = hashlib.sha256()

    def read(self, count=-1):
        requested = 65536 if count < 0 else min(count, 65536)
        data = self.file.read(min(requested, self.size - self.count))
        self.count += len(data)
        self.sha256.update(data)
        return data


def canonical(name):
    path = PurePosixPath(name)
    if not name or name == "." or len(name.encode()) > 255 or path.is_absolute() or ".." in path.parts or "\\" in name or str(path) != name:
        fail("noncanonical archive path " + repr(name))
    return name


def read_exact(file, count):
    parts = []
    while count:
        chunk = file.read(count)
        if not chunk:
            fail("truncated source archive")
        parts.append(chunk)
        count -= len(chunk)
    return b"".join(parts)


def check_archive(path, metadata, materials, license_texts=None):
    if not isinstance(metadata, dict):
        fail("source archive metadata is missing")
    expected = metadata.get("sha256", "")
    name = metadata.get("file", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or name != path.name or not re.fullmatch(r"hexbot-pdf-sources-[A-Za-z0-9][A-Za-z0-9.+_-]*-(?:aarch64|x86_64)-" + expected + r"\.tar\.gz", name):
        fail("companion filename must bind its version and content hash")
    url = urlparse(metadata.get("url", ""))
    if url.scheme != "https" or url.hostname != "updates.hexbot.app" or url.username or url.password or url.port not in (None, 443) or url.query or url.fragment or PurePosixPath(url.path).name != name:
        fail("companion URL must be durable HTTPS with the immutable filename")
    size = metadata.get("bytes")
    if type(size) is not int or not 0 < size <= LIMIT:
        fail("companion archive byte length or SHA256 mismatch")
    if sum(item["bytes"] for item in materials.values()) > LIMIT:
        fail("material set exceeds the reviewed 8 GiB verifier bound")
    seen = set()
    entries = set()
    directories = {str(parent) for name in materials for parent in PurePosixPath(name).parents if str(parent) != "."}
    if len(materials) + len(directories) > MAX_ARCHIVE_ENTRIES:
        fail("source archive has too many entries")
    recipes = {}
    license_bytes = 0 if license_texts is None else sum(map(len, license_texts.values()))
    # Parse fixed USTAR headers before any payload read. In particular, reject
    # PAX/GNU extension headers before tarfile can allocate their claimed size.
    with regular_file(path, size) as (raw, actual_size):
        if actual_size != size or hash_stream(raw, size, size) != expected:
            fail("companion archive byte length or SHA256 mismatch")
        raw.seek(0)
        physical = PhysicalArchive(raw, size)
        with gzip.GzipFile(fileobj=physical, mode="rb") as compressed:
            file = ExpandedArchive(compressed)
            while True:
                header = read_exact(file, 512)
                if not any(header):
                    if any(read_exact(file, 512)):
                        fail("invalid archive terminator")
                    trailing = file.read(65537)
                    if len(trailing) > 65536 or any(trailing):
                        fail("trailing archive data")
                    break
                if header[257:263] != b"ustar\0" or header[263:265] != b"00":
                    fail("unsupported source archive format; USTAR is required")
                try:
                    member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
                except (tarfile.HeaderError, UnicodeError) as error:
                    fail("invalid USTAR header: " + str(error))
                name = canonical(member.name.rstrip("/") if member.isdir() else member.name)
                if name in entries or len(entries) >= MAX_ARCHIVE_ENTRIES:
                    fail("duplicate or excessive source archive entries")
                entries.add(name)
                if member.isdir():
                    if name not in directories or member.size != 0:
                        fail("directory has a payload")
                    continue
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or name in seen or name not in materials:
                    fail("unexpected, linked, special or duplicate material " + name)
                item = materials[name]
                if member.size != item["bytes"]:
                    fail("material byte length mismatch: " + name)
                seen.add(name)
                sha256, sha512 = hashlib.sha256(), hashlib.sha512()
                recipe = bytearray()
                collect_license = license_texts is not None and item["role"] == "license" and item["sha256"] not in license_texts
                license_data = bytearray()
                if collect_license and member.size > 8 * 1024 * 1024 - license_bytes:
                    fail("unique full license texts exceed the reviewed 8 MiB notice bound")
                left = member.size
                while left:
                    data = read_exact(file, min(left, 65536))
                    sha256.update(data)
                    sha512.update(data)
                    if collect_license:
                        license_data.extend(data)
                    if item["role"] == "recipe":
                        if len(recipe) + len(data) > 1024 * 1024:
                            fail("recipe exceeds 1 MiB")
                        recipe.extend(data)
                    left -= len(data)
                if sha256.hexdigest() != item["sha256"] or item.get("sha512", sha512.hexdigest()) != sha512.hexdigest():
                    fail("material digest mismatch: " + name)
                if collect_license:
                    license_texts[item["sha256"]] = bytes(license_data)
                    license_bytes += len(license_data)
                if item["role"] == "recipe":
                    recipes[name] = recipe.decode("utf-8")
                if any(read_exact(file, (-member.size) % 512)):
                    fail("nonzero material padding")
        if physical.count != size or physical.sha256.hexdigest() != expected or os.fstat(raw.fileno()).st_size != size:
            fail("compressed archive byte length or contents changed during verification")
    if seen != set(materials):
        fail("missing archive materials: " + ", ".join(sorted(set(materials) - seen)[:8]))
    return recipes


def check_source_pins(by_component, expected, lock):
    for key in expected:
        pin = lock.get("sourceRecipePins", {}).get(key)
        entries = by_component[key]
        if not pin or not any(p["role"] == "recipe" and p["sha256"] == pin["recipeSha256"] for p in entries) or not any(p["role"] == "build" and p["sha256"] == pin["aportsArchiveSha256"] for p in entries):
            fail("source recipe/archive differs from the reviewed source pin: " + key)
    for key, required in STATIC_SOURCE_PINS.items():
        present = {p["sha256"] for p in by_component[key] if p["role"] == "source"}
        if not required.issubset(present):
            fail("actual pinned upstream source archives are missing for " + key)
    if not any(p["role"] == "build" and p["sha256"] == MUSL_CROSS_HASH for p in by_component["musl"]):
        fail("actual pinned musl-cross-make build recipes/patches archive is missing")


def check_worker_dependencies():
    cargo = tomllib.loads(read_regular(HERE / "Cargo.lock", 1024 * 1024).decode())
    expected = [
        {"name": "hexbot-pdf-worker", "version": "0.1.0", "dependencies": ["libc"]},
        {"name": "libc", "version": "0.2.190", "source": "registry+https://github.com/rust-lang/crates.io-index",
         "checksum": next(iter(STATIC_SOURCE_PINS["libc"]))},
    ]
    if cargo.get("version") != 4 or cargo.get("package") != expected:
        fail("worker Cargo.lock differs from the reviewed libc-only dependency set")


def verify_materials(archive, sources, lock, arch, license_texts=None):
    """Content-only evidence check. Never promotes readiness flags."""
    if sources.get("version") != 1 or sources.get("architecture") != arch:
        fail("source inventory version or architecture mismatch")
    if lock != load(HERE / "assets.lock.json"):
        fail("supplied lock differs from the accepted build/source lock")
    check_worker_dependencies()
    packages = lock["architectures"][arch]["packages"]
    if not packages:
        fail("architecture has no reviewed package lock")
    components = {}
    for component in sources.get("components", []):
        name = component.get("id")
        if not isinstance(name, str) or name in components:
            fail("invalid or duplicate component")
        components[name] = component
    expected = {}
    for package in packages:
        key = "alpine:" + ":".join([package["repository"], package["origin"][0], package["sourceCommit"][0]])
        expected.setdefault(key, set()).add(package["name"] + "=" + package["version"])
    for key, package_set in expected.items():
        component = components.get(key, {})
        if component.get("kind") != "alpine" or set(component.get("packages", [])) != package_set:
            fail("missing or mismatched locked component " + key)
    required = {"hexbot-pdf-worker", "hexbot-pdf-vm", "libc", "rust-std", "musl"}
    if not required.issubset(components):
        fail("missing worker/helper/static toolchain components")
    if components["rust-std"].get("version") != "1.97.1" or components["libc"].get("version") != "0.2.190":
        fail("static dependency versions do not match the pinned worker")
    if components["musl"].get("version") != "1.2.5+rust-1.97.1-patches":
        fail("exact statically linked musl source version does not match the reviewed toolchain")
    materials = {}
    for item in sources.get("materials", []):
        name = canonical(item.get("path", ""))
        if name in materials or item.get("component") not in components or item.get("role") not in ROLES or type(item.get("bytes")) is not int or not 0 <= item["bytes"] <= LIMIT or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")):
            fail("invalid or duplicate material " + name)
        materials[name] = item
    by_component = {key: [p for p in materials.values() if p["component"] == key] for key in components}
    for key, entries in by_component.items():
        roles = {p["role"] for p in entries if p["bytes"] > 0}
        if not {"source", "license"}.issubset(roles) or key in expected and "recipe" not in roles:
            fail("actual source/license/recipe material missing for " + key)
    check_source_pins(by_component, expected, lock)
    # Own source bytes must match the checkout that builds the runtime. Source
    # obligations are not satisfied by a placeholder source archive and flags.
    for folder, component, prefix in [(HERE, "hexbot-pdf-worker", "worker"), (HERE.parent / "macos", "hexbot-pdf-vm", "macos")]:
        for relative, expected_hash in owned_snapshot(folder).items():
            name = prefix + "/" + relative
            item = materials.get(name, {})
            if item.get("component") != component or item.get("sha256") != expected_hash:
                fail("own source/build file missing or changed: " + name)
    for name in ["LICENSE", "NOTICE"]:
        item = materials.get("worker/" + name, {})
        if item.get("sha256") != digest(HERE.parents[2] / name):
            fail("repository license/notice bytes missing or changed")
    if "-" + arch + "-" not in sources.get("archive", {}).get("file", ""):
        fail("companion filename does not match its architecture")
    recipes = check_archive(archive, sources.get("archive"), materials, license_texts)
    for key in expected:
        entries = by_component[key]
        for recipe in [p for p in entries if p["role"] == "recipe"]:
            # Keep every checksum-locked APKBUILD input, including local
            # patches/configs and architecture-specific selections. No eval.
            checksums = re.findall(r'(?:^|\n|["\x27])([a-f0-9]{128})[ \t]+([^\n"\x27]+)', recipes[recipe["path"]])
            for checksum, filename in checksums:
                if not any(p.get("upstreamFile") == filename.strip() and p.get("sha512") == checksum for p in entries):
                    fail("checksum-locked recipe input missing: " + key + "/" + filename.strip())
    return {"verified": True, "architecture": arch, "components": len(components), "materials": len(materials), "archiveSha256": sources["archive"]["sha256"]}


def notice_bytes(sources, license_texts):
    # This formatter is our own reviewed source, already compared against the
    # companion by verify_materials. No upstream build hooks are executed.
    if sys.version_info < (3, 12):
        fail("full notice verification requires the documented Python 3.12 or newer builder")
    spec = importlib.util.spec_from_file_location("pdf_source_collector", HERE / "collect-sources.py")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    result = collector.render_notices(sources["components"], sources["materials"], license_texts)
    if len(result) > 8 * 1024 * 1024:
        fail("full notices exceed 8 MiB")
    return result


def check_release_identity(sources, arch, version):
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        fail("an exact runtime release version is required")
    archive = sources.get("archive", {})
    name = f"hexbot-pdf-sources-{version}-{arch}-{archive.get('sha256', '')}.tar.gz"
    url = f"https://updates.hexbot.app/daemon/native/{version}/macos-{arch}/{name}"
    if archive.get("file") != name or archive.get("url") != url:
        fail("companion filename/URL does not match the exact runtime version and architecture")


def verify(archive, sources, lock, arch, notices=None, version=None):
    if sources.get("completeCorrespondingSourceArchive") is not True:
        fail("prototype or incomplete source inventory cannot be released")
    check_release_identity(sources, arch, version)
    texts = {}
    result = verify_materials(archive, sources, lock, arch, texts)
    if notices is None:
        fail("full notice file is required for release verification")
    actual = read_regular(notices, 8 * 1024 * 1024)
    if actual != notice_bytes(sources, texts):
        fail("full license/copyright notices differ from actual companion materials")
    result["noticesSha256"] = hashlib.sha256(actual).hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--sources", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--arch", required=True, choices=["aarch64", "x86_64"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--notices", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.archive, load(args.sources), load(args.lock), args.arch,
                        args.notices or args.sources.with_name("THIRD_PARTY_NOTICES"), args.version)
    except (ValueError, KeyError, OSError, TypeError) as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
