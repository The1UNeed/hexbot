#!/usr/bin/env python3
"""Validate actual source/notice materials before creating a finalized asset set.

Inputs are immutable. All checks happen before a new output directory appears;
there is no in-place readiness promotion and no completeness bypass flag.
"""
import argparse
import copy
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pdf_source_verifier", HERE / "verify-sources.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
MIB = 1024 * 1024
CAPS = {"kernel": 64 * MIB, "initramfs": 32 * MIB, "rootfs": 192 * MIB,
        "manifest.json": 128 * 1024, "kernel.provenance.json": 2 * MIB,
        "PROVENANCE.json": 2 * MIB, "SOURCES.json": 8 * MIB,
        "THIRD_PARTY_NOTICES": 8 * MIB}


def publish_new(source, destination):
    """Atomically publish without replacing even a concurrently created directory."""
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "linux":
        rename = library.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)  # RENAME_NOREPLACE
    elif sys.platform == "darwin":
        rename = library.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = rename(os.fsencode(source), os.fsencode(destination), 4)  # RENAME_EXCL
    else:
        raise ValueError("PDF asset finalization requires Linux or macOS atomic no-replace rename")
    if result != 0:
        raise OSError(ctypes.get_errno(), "cannot publish finalized PDF assets without replacement", destination)


def record(data, limit):
    encoded = (json.dumps(data, indent=2) + "\n").encode()
    if len(encoded) > limit:
        raise ValueError("PDF metadata exceeds its byte cap")
    return encoded


def finalize(args):
    if args.out.resolve() == args.assets.resolve() or args.assets.resolve() in args.out.resolve().parents:
        raise ValueError("finalized PDF output must be outside the immutable input asset directory")
    if args.out.exists():
        raise ValueError("finalized PDF output already exists; choose a new owned directory")
    manifest_bytes = verifier.read_regular(args.assets / "manifest.json", CAPS["manifest.json"])
    manifest = json.loads(manifest_bytes)
    provenance = verifier.load(args.assets / "PROVENANCE.json", CAPS["PROVENANCE.json"])
    sources = verifier.load(args.sources)
    lock = verifier.load(args.lock)
    verifier.check_release_identity(sources, args.arch, args.version)
    if manifest.get("version") != 1 or manifest.get("architecture") != args.arch or set(manifest.get("files", {})) != {"kernel", "initramfs", "rootfs"}:
        raise ValueError("PDF manifest version, architecture or VM file set mismatch")
    input_hashes = {name: verifier.digest(args.assets / name, CAPS[name], minimum=1) for name in
                    ["kernel", "initramfs", "rootfs", "kernel.provenance.json"]}
    input_hashes["manifest.json"] = hashlib.sha256(manifest_bytes).hexdigest()
    for name, expected in manifest["files"].items():
        if input_hashes[name] != expected:
            raise ValueError("PDF VM asset hash mismatch: " + name)
    if provenance.get("version") != 1 or provenance.get("architecture") != args.arch or provenance.get("packages") != lock["architectures"][args.arch]["packages"]:
        raise ValueError("PDF build provenance does not match the exact architecture package lock")
    if sources.get("outstanding") != []:
        raise ValueError("PDF source review remains incomplete: " + json.dumps(sources["outstanding"]))
    materials = sources.get("materials", [])
    indexed = {item["path"]: item for item in materials}
    if provenance.get("sourceFiles") != verifier.owned_snapshot(HERE):
        raise ValueError("PDF build snapshot differs from the complete current worker source set")
    for name, expected in provenance.get("sourceFiles", {}).items():
        if indexed.get("worker/" + name, {}).get("sha256") != expected:
            raise ValueError("PDF source archive differs from the actual build snapshot: " + name)
    if not provenance.get("sourceFiles"):
        raise ValueError("PDF build snapshot is missing")
    kernel_config = provenance.get("kernelConfig", {})
    kernel = next(p for p in provenance["packages"] if p["name"] == "linux-virt")
    component = "alpine:" + ":".join([kernel["repository"], kernel["origin"][0], kernel["sourceCommit"][0]])
    if not kernel_config or not any(item["role"] == "config" and item["component"] == component
                                    and item["sha256"] == kernel_config.get("sha256")
                                    and item["bytes"] == kernel_config.get("bytes") for item in materials):
        raise ValueError("PDF source archive lacks the actual authenticated kernel build config")
    license_texts = {}
    proof = verifier.verify_materials(args.archive, sources, lock, args.arch, license_texts)
    notices = verifier.read_regular(args.notices, CAPS["THIRD_PARTY_NOTICES"])
    if notices != verifier.notice_bytes(sources, license_texts):
        raise ValueError("PDF full notices differ from the actual source-archive license/copyright bytes")
    # Only validated material can reach these output records. Candidate flags
    # are not used as evidence, and the prototype inputs remain untouched.
    sources = copy.deepcopy(sources)
    sources["completeCorrespondingSourceArchive"] = True
    sources["notices"] = {"file": "THIRD_PARTY_NOTICES", "bytes": len(notices),
                          "sha256": hashlib.sha256(notices).hexdigest()}
    provenance = copy.deepcopy(provenance)
    provenance.update(status="release-ready", sourceArchiveComplete=True, noticesComplete=True,
                      sourceArchive=sources["archive"], notices=sources["notices"], sourceVerification=proof)
    source_bytes = record(sources, CAPS["SOURCES.json"])
    provenance_bytes = record(provenance, CAPS["PROVENANCE.json"])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hexbot-pdf-finalize-", dir=args.out.parent) as temporary:
        staging = Path(temporary) / "assets"
        staging.mkdir()
        for name in ["kernel", "initramfs", "rootfs", "manifest.json", "kernel.provenance.json"]:
            if verifier.copy_regular(args.assets / name, staging / name, CAPS[name]) != input_hashes[name]:
                raise ValueError("PDF asset changed while finalizing: " + name)
        (staging / "SOURCES.json").write_bytes(source_bytes)
        (staging / "PROVENANCE.json").write_bytes(provenance_bytes)
        (staging / "THIRD_PARTY_NOTICES").write_bytes(notices)
        publish_new(staging, args.out)
    return {"finalized": str(args.out), "architecture": args.arch, **proof}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--notices", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--arch", choices=["aarch64", "x86_64"], required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = finalize(args)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, "PDF runtime finalization failed: " + str(error) + "\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
