#!/usr/bin/env python3
"""Build pinned PDF guest assets inside a disposable native Linux builder.

Requires root only inside that builder for chroot, never --privileged, mounts or
VM access. Downloads are HTTPS, exact-length/SHA256 checked and cached. This
prototype intentionally refuses architectures without a complete package lock.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import posixpath
import shutil
import subprocess
import struct
import tarfile
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
INPUT_BUDGET = 200 * 1024 * 1024
ROOTFS_BYTES = 192 * 1024 * 1024
INITRAMFS_LIMIT = 32 * 1024 * 1024


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for data in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def source_snapshot():
    result = {}
    for path in HERE.rglob("*"):
        relative = path.relative_to(HERE)
        if set(relative.parts) & {"target", "assets", "build", "__pycache__", ".build", ".swiftpm"}:
            continue
        if path.is_symlink():
            raise ValueError("owned source/build paths must not be symlinks: " + str(relative))
        if path.is_file():
            result[relative.as_posix()] = sha256(path)
    return result


def fetch(asset, cache):
    url = asset["url"]
    if not url.startswith("https://dl-cdn.alpinelinux.org/alpine/v3.24/"):
        raise ValueError("asset URL must use the reviewed official Alpine branch")
    name = url.rsplit("/", 1)[-1]
    if not name or name in {".", ".."} or "/" in name:
        raise ValueError("invalid asset filename")
    digest = asset["sha256"]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or not 0 < asset["bytes"] <= INPUT_BUDGET:
        raise ValueError("invalid locked asset digest or byte bound")
    directory = cache / digest
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    if path.is_file() and path.stat().st_size == asset["bytes"] and sha256(path) == digest:
        return path
    legacy = cache / name
    use_legacy = legacy.is_file() and legacy.stat().st_size == asset["bytes"] and sha256(legacy) == digest
    descriptor, temporary_name = tempfile.mkstemp(prefix=name + ".", suffix=".partial", dir=directory)
    temporary = Path(temporary_name)
    try:
        count = 0
        with os.fdopen(descriptor, "wb") as target:
            source = legacy.open("rb") if use_legacy else urllib.request.urlopen(url, timeout=30)
            with source:
                if not use_legacy and not source.url.startswith("https://dl-cdn.alpinelinux.org/"):
                    raise ValueError("unexpected download redirect")
                while data := source.read(min(1024 * 1024, asset["bytes"] - count + 1)):
                    count += len(data)
                    if count > asset["bytes"]:
                        raise ValueError("download exceeds locked byte length")
                    target.write(data)
        if count != asset["bytes"] or sha256(temporary) != digest:
            raise ValueError("download length or SHA256 mismatch")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def copy_x86_kernel(source, destination):
    with source.open("rb") as file:
        image = file.read(64 * 1024 * 1024 + 1)
    if not 0x238 <= len(image) <= 64 * 1024 * 1024 or image[510:512] != b"\x55\xaa" or image[0x202:0x206] != b"HdrS" or struct.unpack_from("<H", image, 0x206)[0] < 0x020C or not struct.unpack_from("<H", image, 0x236)[0] & 1:
        raise ValueError("expected bounded native 64-bit Linux x86 bzImage")
    destination.write_bytes(image)
    record = {"format": "Linux x86_64 bzImage (authenticated bytes unchanged)",
              "sourceVmlinuzSha256": sha256(source), "sha256": sha256(destination),
              "outputBytes": len(image), "outputCapBytes": 64 * 1024 * 1024,
              "bootFlagOffset": 510, "bootFlagHex": image[510:512].hex(),
              "headerMagicOffset": 0x202, "headerMagic": "HdrS",
              "xloadflags": struct.unpack_from("<H", image, 0x236)[0]}
    destination.with_suffix(".provenance.json").write_text(json.dumps(record, indent=2) + "\n")


def rootfs_filter(member, destination):
    # Alpine BusyBox applets use absolute links, valid inside a chroot. Convert
    # them to equivalent relative links before the standard safe data filter.
    if member.issym() and member.linkname.startswith("/"):
        member = copy.copy(member)
        parent = posixpath.dirname("/" + member.name.lstrip("/"))
        member.linkname = posixpath.relpath(posixpath.normpath(member.linkname), parent)
    return tarfile.data_filter(member, destination)


def run(*args, **options):
    print("+", *map(str, args), flush=True)
    subprocess.run(list(map(str, args)), check=True, **options)


def prune(root):
    run("chroot", root, "/usr/bin/fc-cache", "-f")
    for relative in ["packages", "boot", "lib/modules", "usr/share/mkinitfs", "etc/apk",
                     "var/cache/apk", "lib/apk", "var/lib/apk", "hexbot-init",
                     "etc/resolv.conf", "etc/shadow"]:
        path = root / relative
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    for relative in ["bin", "sbin", "usr/bin", "usr/sbin"]:
        for path in (root / relative).iterdir():
            if relative == "usr/bin" and path.name == "pdftoppm":
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
    (root / "etc/passwd").write_text("root:x:0:0:root:/nonexistent:/nonexistent\nnobody:x:65534:65534:nobody:/nonexistent:/nonexistent\n")
    (root / "etc/group").write_text("root:x:0:\nnobody:x:65534:\n")
    for relative in ["dev", "proc", "sys", "tmp"]:
        (root / relative).mkdir(exist_ok=True)


def build(args):
    if not hasattr(tarfile, "data_filter"):
        raise ValueError("builder requires Python 3.12 or newer with safe tar extraction filters")
    if platform.system() != "Linux" or platform.machine() != args.arch or os.geteuid() != 0:
        raise ValueError("run as container root on a matching native Linux builder")
    if args.out.exists():
        raise ValueError("output already exists; choose a new owned output directory")
    rustc = subprocess.check_output(["rustc", "-Vv"], text=True)
    if rustc.splitlines()[0] != "rustc 1.97.1 (8bab26f4f 2026-07-14)":
        raise ValueError("PDF guest build requires the pinned Rust 1.97.1 toolchain")
    source_files = source_snapshot()
    lock = json.loads((HERE / "assets.lock.json").read_text())
    spec = lock["architectures"][args.arch]
    packages = spec["packages"]
    if not packages:
        raise ValueError("this architecture has no complete reviewed package lock")
    if sum(p["bytes"] for p in [spec["minirootfs"], *packages]) > INPUT_BUDGET:
        raise ValueError("locked input assets exceed the 200 MiB budget")
    args.cache.mkdir(parents=True, exist_ok=True)
    inputs = [fetch(p, args.cache) for p in [spec["minirootfs"], *packages]]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hexbot-pdf-build-", dir=args.out.parent) as temporary:
        work = Path(temporary)
        root = work / "root"
        root.mkdir()
        with tarfile.open(inputs[0], "r:gz") as archive:
            archive.extractall(root, filter=rootfs_filter)
        keys = {p.name: sha256(p) for p in (root / "etc/apk/keys").iterdir() if p.is_file()}
        if keys != spec["trustedApkKeys"]:
            raise ValueError("trusted APK keys differ from reviewed minirootfs")
        (root / "packages").mkdir()
        paths = []
        for package, source in zip(packages, inputs[1:]):
            destination = root / "packages" / package["filename"]
            shutil.copyfile(source, destination)
            paths.append("/packages/" + package["filename"])
        run("chroot", root, "/sbin/apk", "verify", *paths)
        run("chroot", root, "/sbin/apk", "add", "--no-network", "--no-scripts", *paths)
        shutil.copyfile(HERE / "boot/init", root / "hexbot-init")
        (root / "hexbot-init").chmod(0o755)
        shutil.copyfile(HERE / "boot/hexbot.modules", root / "etc/mkinitfs/features.d/hexbot.modules")
        versions = list((root / "lib/modules").iterdir())
        if len(versions) != 1 or not versions[0].name.endswith("-virt"):
            raise ValueError("expected exactly one reviewed virt kernel")
        output = work / "output"
        output.mkdir()
        # Keep generated initramfs outside the immutable root image.
        run("chroot", root, "/sbin/mkinitfs", "-F", "base virtio ext4 hexbot", "-i", "/hexbot-init",
            "-o", "/initramfs", versions[0].name)
        shutil.move(root / "initramfs", output / "initramfs")
        if (output / "initramfs").stat().st_size > INITRAMFS_LIMIT:
            raise ValueError("initramfs exceeds 32 MiB")
        if args.arch == "aarch64":
            run("python3", HERE / "extract-kernel.py", root / "boot/vmlinuz-virt", output / "kernel")
        else:
            copy_x86_kernel(root / "boot/vmlinuz-virt", output / "kernel")
        transform_path = output / "kernel.provenance.json"
        transform = json.loads(transform_path.read_text())
        kernel_package = next(p for p in packages if p["name"] == "linux-virt")
        transform["sourceApk"] = {key: kernel_package[key] for key in ["name", "version", "url", "sha256"]}
        transform_path.write_text(json.dumps(transform, indent=2) + "\n")
        configs = list((root / "boot").glob("config-*-virt"))
        if len(configs) != 1:
            raise ValueError("authenticated kernel config is missing or ambiguous")
        config_copy = work / "kernel.config"
        shutil.copyfile(configs[0], config_copy)
        config_provenance = {"sha256": sha256(config_copy), "bytes": config_copy.stat().st_size,
                             "sourcePackage": kernel_package["name"] + "=" + kernel_package["version"]}
        target = args.arch + "-unknown-linux-musl"
        environment = os.environ.copy()
        environment.update(CARGO_TARGET_DIR=str(work / "target"), CARGO_BUILD_JOBS="2",
                           **{f"CARGO_TARGET_{target.upper().replace('-', '_')}_LINKER": "musl-gcc"})
        run("cargo", "build", "--locked", "--release", "--target", target,
            "--manifest-path", HERE / "Cargo.toml", env=environment)
        binary = work / "target" / target / "release/hexbot-pdf-worker"
        for collection, cmap in [("Adobe-GB1", "UniGB-UCS2-H"), ("Adobe-Japan1", "UniJIS-UCS2-H"), ("Adobe-Korea1", "UniKS-UCS2-H")]:
            if not (root / "usr/share/poppler/cMap" / collection / cmap).is_file():
                raise ValueError("required Poppler CMap data missing: " + collection)
        prune(root)
        shutil.copyfile(binary, root / "sbin/hexbot-pdf-worker")
        (root / "sbin/hexbot-pdf-worker").chmod(0o755)
        (root / "usr/share/hexbot-pdf").mkdir(exist_ok=True)
        (root / "usr/share/hexbot-pdf/PACKAGES.json").write_text(json.dumps(packages, indent=2) + "\n")
        with (output / "rootfs").open("wb") as image:
            image.truncate(ROOTFS_BYTES)
        run("mke2fs", "-q", "-F", "-t", "ext4", "-b", "4096", "-m", "0", "-O", "^has_journal",
            "-E", "root_owner=0:0,lazy_itable_init=0", "-L", "hexbot-pdf", "-d", root, output / "rootfs")
        run("e2fsck", "-fn", output / "rootfs")
        manifest = {"version": 1, "architecture": args.arch,
                    "files": {name: sha256(output / name) for name in ["kernel", "initramfs", "rootfs"]}}
        manifest["kernelTransform"] = transform
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        inventory = {"version": 1, "architecture": args.arch,
                     "completeCorrespondingSourceArchive": False, "archive": None,
                     "packages": [{key: p[key] for key in ["name", "version", "license", "origin", "sourceCommit", "sourceRecipe", "upstream"]} for p in packages],
                     "worker": {"source": "backend/pdf-runtime/guest", "license": "Apache-2.0", "rustc": rustc.splitlines()[0], "libc": "0.2.190"},
                     "outstanding": ["Collect complete corresponding-source archive and license texts", "Inventory static Rust standard-library/musl attribution", "Validate Intel architecture before distribution"]}
        (output / "SOURCES.json").write_text(json.dumps(inventory, indent=2) + "\n")
        if source_snapshot() != source_files:
            raise ValueError("PDF guest source changed during the build")
        notices = "PROTOTYPE PDF RUNTIME: NOT RELEASE READY\n\nThis file records declared package license metadata only. Full license texts\nand corresponding-source materials are incomplete; do not distribute this\nprototype as a release. See SOURCES.json and PROVENANCE.json.\n\n"
        notices += "\n".join(f"{p['name']} {p['version']}: {', '.join(p['license'])}" for p in packages) + "\n"
        (output / "THIRD_PARTY_NOTICES").write_text(notices)
        provenance = {"version": 1, "architecture": args.arch,
                      "status": "prototype-not-release-ready", "packages": packages,
                      "sourceFiles": source_files, "workerSha256": sha256(binary),
                      "toolchain": rustc, "kernelConfig": config_provenance,
                      "sourceArchiveComplete": False, "noticesComplete": False, "sourceArchive": None,
                      "note": "Corresponding-source archive and complete license texts remain required before distribution."}
        (output / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
        config_out = args.kernel_config_out or args.out.with_name(args.out.name + ".kernel.config")
        if config_out.exists() or args.out == config_out or args.out in config_out.parents:
            raise ValueError("kernel config output must be a new file outside the runtime asset directory")
        config_out.parent.mkdir(parents=True, exist_ok=True)
        with config_out.open("xb") as destination, config_copy.open("rb") as source:
            shutil.copyfileobj(source, destination)
        output.rename(args.out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=["aarch64", "x86_64"], required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--kernel-config-out", type=Path)
    build(parser.parse_args())


if __name__ == "__main__":
    main()
