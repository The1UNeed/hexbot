import gzip
import importlib.util
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("kernel", Path(__file__).with_name("extract-kernel.py"))
kernel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kernel)


def zboot(image):
    payload = gzip.compress(image, mtime=0)
    header = bytearray(64)
    header[:2] = b"MZ"
    header[4:8] = b"zimg"
    struct.pack_into("<II", header, 8, 64, len(payload))
    header[24:32] = b"gzip\0\0\0\0"
    return bytes(header) + payload


class KernelExtraction(unittest.TestCase):
    def setUp(self):
        self.image = bytearray(128)
        self.image[56:60] = b"ARM\x64"

    def test_checked_transform_records_hash_and_offsets(self):
        image, record = kernel.extract(zboot(self.image))
        self.assertEqual(image, self.image)
        self.assertEqual(record["payloadOffset"], 64)
        self.assertEqual(record["outputBytes"], 128)
        self.assertEqual(record["arm64MagicHex"], "41524d64")

    def test_rejects_bad_bounds_truncation_crc_and_wrong_architecture(self):
        valid = zboot(self.image)
        for offset in range(0, len(valid)):
            with self.subTest(truncated=offset):
                with self.assertRaises((ValueError, kernel.zlib.error)):
                    kernel.extract(valid[:offset])
        for position in [4, 8, 12, 24, len(valid) - 8]:
            bad = bytearray(valid)
            bad[position] ^= 0xFF
            with self.subTest(corrupt=position):
                with self.assertRaises((ValueError, kernel.zlib.error)):
                    kernel.extract(bytes(bad))
        with self.assertRaises(ValueError):
            kernel.extract(zboot(bytes(128)))

    def test_decompression_cap_is_enforced_before_allocating_declared_size(self):
        oversized = self.image + bytes(8192)
        with patch.object(kernel, "LIMIT", 4096):
            with self.assertRaises(ValueError):
                kernel.extract(zboot(oversized))


if __name__ == "__main__":
    unittest.main()
