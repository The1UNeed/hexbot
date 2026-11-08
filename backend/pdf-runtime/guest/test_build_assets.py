import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-assets.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@unittest.skipUnless(hasattr(tarfile, "data_filter"), "requires Python with tarfile extraction filters")
class RootfsExtraction(unittest.TestCase):
    def test_absolute_applet_links_are_confined_with_equivalent_chroot_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w") as tar:
                regular = tarfile.TarInfo("bin/busybox")
                regular.size = 4
                tar.addfile(regular, io.BytesIO(b"test"))
                link = tarfile.TarInfo("usr/bin/yes")
                link.type = tarfile.SYMTYPE
                link.linkname = "/bin/busybox"
                tar.addfile(link)
            archive.seek(0)
            with tarfile.open(fileobj=archive) as tar:
                tar.extractall(root, filter=builder.rootfs_filter)
            self.assertEqual((root / "usr/bin/yes").resolve(), (root / "bin/busybox").resolve())
            self.assertEqual((root / "usr/bin/yes").read_bytes(), b"test")

    def test_archive_paths_cannot_escape_the_owned_build_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            bad = tarfile.TarInfo("../outside")
            with self.assertRaises(tarfile.OutsideDestinationError):
                builder.rootfs_filter(bad, root)
            self.assertFalse((Path(directory) / "outside").exists())


class DownloadOwnership(unittest.TestCase):
    def test_source_snapshot_rejects_symlink_directories_and_records_new_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'main.rs').write_bytes(b'first')
            with patch.object(builder,'HERE',root):
                original = builder.source_snapshot()
                (root/'build.rs').write_bytes(b'build input')
                self.assertNotEqual(builder.source_snapshot(),original)
                (root/'src').symlink_to(root,target_is_directory=True)
                with self.assertRaisesRegex(ValueError,'must not be symlinks'):
                    builder.source_snapshot()

    def asset(self, data, arch="aarch64"):
        import hashlib
        return {"url": f"https://dl-cdn.alpinelinux.org/alpine/v3.24/main/{arch}/example.apk", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def test_failed_fetch_never_deletes_another_builders_partial_file(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            other = cache / "example.apk.partial"
            other.write_bytes(b"another builder owns this")
            with patch.object(builder.urllib.request, "urlopen", side_effect=OSError("offline")):
                with self.assertRaises(OSError):
                    builder.fetch(self.asset(b"expected"), cache)
            self.assertEqual(other.read_bytes(), b"another builder owns this")
            self.assertEqual(list((cache / self.asset(b"expected")["sha256"]).iterdir()), [])

    def test_same_filename_for_two_architectures_cannot_replace_each_others_bytes(self):
        from unittest.mock import patch
        first, second = b"ARM package", b"Intel package"
        a, b = self.asset(first), self.asset(second, "x86_64")
        def open_url(url, timeout):
            response = io.BytesIO(first if url == a["url"] else second)
            response.url = url
            return response
        with tempfile.TemporaryDirectory() as directory, patch.object(builder.urllib.request, "urlopen", side_effect=open_url):
            pa = builder.fetch(a, Path(directory))
            pb = builder.fetch(b, Path(directory))
            self.assertNotEqual(pa, pb)
            self.assertEqual(pa.read_bytes(), first)
            self.assertEqual(pb.read_bytes(), second)

    def test_legacy_cache_migration_owns_a_copy_not_a_mutable_shared_inode(self):
        data = b"authenticated package"
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            legacy = cache / "example.apk"
            legacy.write_bytes(data)
            pinned = builder.fetch(self.asset(data), cache)
            legacy.write_bytes(b"a legacy writer replaced its data")
            self.assertEqual(pinned.read_bytes(), data)


class NativeKernelFormat(unittest.TestCase):
    def test_x86_kernel_must_have_the_native_64_bit_boot_headers(self):
        import struct
        image = bytearray(4096)
        image[510:512] = b'\x55\xaa'
        image[0x202:0x206] = b'HdrS'
        struct.pack_into('<H', image, 0x206, 0x020F)
        struct.pack_into('<H', image, 0x236, 1)
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/'input', Path(directory)/'kernel'
            source.write_bytes(image)
            builder.copy_x86_kernel(source, output)
            self.assertEqual(output.read_bytes(), image)
            for offset in [510, 0x202, 0x206, 0x236]:
                wrong = bytearray(image)
                wrong[offset] = 0
                source.write_bytes(wrong)
                with self.subTest(offset=offset), self.assertRaises(ValueError):
                    builder.copy_x86_kernel(source, output)


if __name__ == "__main__":
    unittest.main()
