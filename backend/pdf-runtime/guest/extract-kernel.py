#!/usr/bin/env python3
"""Convert authenticated Alpine EFI_ZBOOT to a bounded raw ARM64 Image.

Layout: Linux drivers/firmware/efi/libstub/zboot-header.S. Input authentication
against its locked APK is the caller's responsibility; this also records the
exact input hash. This is a build tool, never a PDF decoder on the host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

LIMIT = 64 * 1024 * 1024


def extract(data):
    if len(data) > LIMIT or len(data) < 64 or data[:2] != b"MZ" or data[4:8] != b"zimg":
        raise ValueError("expected bounded Alpine EFI_ZBOOT image")
    offset, size = struct.unpack_from("<II", data, 8)
    if data[24:32] != b"gzip\0\0\0\0" or offset < 64 or size < 18 or offset > len(data) or size > len(data) - offset:
        raise ValueError("invalid zboot gzip payload bounds")
    payload = data[offset:offset + size]
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    image = decoder.decompress(payload, LIMIT + 1)
    if len(image) > LIMIT or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("oversized or incomplete gzip payload")
    crc, declared_size = struct.unpack_from("<II", payload, len(payload) - 8)
    if crc != zlib.crc32(image) or declared_size != len(image) or image[0x38:0x3c] != b"ARM\x64":
        raise ValueError("invalid gzip checksum, size or ARM64 Image header")
    return image, {
        "sourceVmlinuzSha256": hashlib.sha256(data).hexdigest(),
        "format": "Linux EFI_ZBOOT gzip to ARM64 Image",
        "headerPayloadOffsetField": 8, "headerPayloadSizeField": 12,
        "payloadOffset": offset, "payloadBytes": size,
        "gzipCrc32": f"{crc:08x}", "gzipDeclaredBytes": declared_size,
        "outputBytes": len(image), "outputCapBytes": LIMIT,
        "arm64MagicOffset": 56, "arm64MagicHex": image[56:60].hex(),
        "sha256": hashlib.sha256(image).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    with args.source.open("rb") as source:
        data = source.read(LIMIT + 1)
    image, record = extract(data)
    args.destination.write_bytes(image)
    args.destination.with_suffix(".provenance.json").write_text(json.dumps(record, indent=2) + "\n")


if __name__ == "__main__":
    main()
