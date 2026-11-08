import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-sources.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class SourceArchiveBytes(unittest.TestCase):
    def make(self, root, records, data_override=None, tar_format=tarfile.USTAR_FORMAT):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w", format=tar_format) as tar:
            for name, data, kind in records:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = len(data) if kind == tarfile.REGTYPE else 0
                if kind == tarfile.SYMTYPE:
                    item.linkname = "/outside"
                tar.addfile(item, io.BytesIO(data) if item.size else None)
        raw = stream.getvalue() if data_override is None else data_override(stream.getvalue())
        compressed = gzip.compress(raw, mtime=0)
        sha = hashlib.sha256(compressed).hexdigest()
        name = f"hexbot-pdf-sources-0.1.0-aarch64-{sha}.tar.gz"
        path = root / name
        path.write_bytes(compressed)
        metadata = {"file": name, "sha256": sha, "bytes": len(compressed), "url": "https://updates.hexbot.app/pdf-sources/" + name}
        return path, metadata

    def materials(self):
        return {"source.txt": {"path": "source.txt", "component": "example", "role": "source", "bytes": 7, "sha256": hashlib.sha256(b"source!").hexdigest()}}

    def test_real_payload_is_checked_without_extracting_any_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, metadata = self.make(root, [("source.txt", b"source!", tarfile.REGTYPE)])
            self.assertEqual(verifier.check_archive(archive, metadata, self.materials()), {})
            self.assertFalse((root / "source.txt").exists())

    def test_missing_duplicate_special_and_traversal_entries_fail(self):
        cases = [[], [("source.txt", b"source!", tarfile.REGTYPE)] * 2,
                 [("source.txt", b"", tarfile.SYMTYPE)], [("../outside", b"source!", tarfile.REGTYPE)]]
        for records in cases:
            with self.subTest(records=records), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive, metadata = self.make(root, records)
                with self.assertRaises(ValueError):
                    verifier.check_archive(archive, metadata, self.materials())
                self.assertFalse((root.parent / "outside").exists())

    def test_a_regular_member_cannot_claim_the_archive_root_dot_name(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,metadata = self.make(Path(directory),[('.',b'x',tarfile.REGTYPE)])
            item = {'path':'.','component':'example','role':'source','bytes':1,'sha256':hashlib.sha256(b'x').hexdigest()}
            with self.assertRaisesRegex(ValueError,'noncanonical archive path'):
                verifier.check_archive(archive,metadata,{'.':item})

    def test_tampered_bytes_wrong_lengths_and_postarchive_data_fail(self):
        cases = [(b"changed", None), (b"short", None), (b"source!", lambda raw: raw + b"unlisted trailing bytes")]
        for data, override in cases:
            with self.subTest(data=data, override=override), tempfile.TemporaryDirectory() as directory:
                archive, metadata = self.make(Path(directory), [("source.txt", data, tarfile.REGTYPE)], override)
                with self.assertRaises(ValueError):
                    verifier.check_archive(archive, metadata, self.materials())

    def test_regular_gnu_headers_are_not_mistaken_for_the_ustar_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, metadata = self.make(Path(directory), [("source.txt", b"source!", tarfile.REGTYPE)], tar_format=tarfile.GNU_FORMAT)
            with self.assertRaisesRegex(ValueError, "USTAR is required"):
                verifier.check_archive(archive, metadata, self.materials())

    def test_large_pax_header_is_rejected_before_its_claimed_payload_is_read(self):
        item = tarfile.TarInfo("pax")
        item.type = tarfile.XHDTYPE
        item.size = 1024**3
        raw = item.tobuf(format=tarfile.USTAR_FORMAT) + bytes(1024)
        with tempfile.TemporaryDirectory() as directory:
            archive, metadata = self.make(Path(directory), [], lambda _: raw)
            with self.assertRaises(ValueError):
                verifier.check_archive(archive, metadata, self.materials())

    def test_complete_flags_cannot_replace_actual_companion_materials(self):
        sources = {"version": 1, "architecture": "aarch64", "completeCorrespondingSourceArchive": True, "components": [], "materials": []}
        lock = verifier.load(verifier.HERE/'assets.lock.json')
        with self.assertRaisesRegex(ValueError, "missing or mismatched locked component"):
            verifier.verify_materials(Path("absent"), sources, lock, "aarch64")

    def test_caller_lock_cannot_authorize_its_own_replacement_recipe(self):
        lock = verifier.load(verifier.HERE/'assets.lock.json')
        next(iter(lock['sourceRecipePins'].values()))['recipeSha256'] = '0'*64
        with self.assertRaisesRegex(ValueError,'accepted build/source lock'):
            verifier.verify_materials(Path('absent'),{'version':1,'architecture':'aarch64'},lock,'aarch64')

    def test_repeated_and_unlisted_directories_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            records = [('dir',b'',tarfile.DIRTYPE),('dir/source.txt',b'source!',tarfile.REGTYPE)]
            item = self.materials()['source.txt']
            materials = {'dir/source.txt':dict(item,path='dir/source.txt')}
            archive, metadata = self.make(Path(directory),records)
            self.assertEqual(verifier.check_archive(archive,metadata,materials),{})
            for invalid in [[records[0]]+records,[('unlisted',b'',tarfile.DIRTYPE)]+records]:
                archive,metadata = self.make(Path(directory),invalid)
                with self.assertRaises(ValueError):verifier.check_archive(archive,metadata,materials)

    def test_expanded_bound_includes_headers_padding_and_terminators(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,metadata = self.make(Path(directory),[('source.txt',b'source!',tarfile.REGTYPE)])
            expanded = len(gzip.decompress(archive.read_bytes()))
            with patch.object(verifier,'LIMIT',expanded):
                self.assertEqual(verifier.check_archive(archive,metadata,self.materials()),{})
            with patch.object(verifier,'LIMIT',expanded-1):
                with self.assertRaisesRegex(ValueError,'expanded archive'):
                    verifier.check_archive(archive,metadata,self.materials())

    def test_growth_after_the_compressed_hash_cannot_feed_extra_gzip_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,metadata = self.make(Path(directory),[('source.txt',b'source!',tarfile.REGTYPE)])
            original = verifier.gzip.GzipFile
            def append_after_hash(*args,**kwargs):
                with archive.open('ab') as target:target.write(b'new compressed data')
                return original(*args,**kwargs)
            with patch.object(verifier.gzip,'GzipFile',side_effect=append_after_hash):
                with self.assertRaisesRegex(ValueError,'changed during verification'):
                    verifier.check_archive(archive,metadata,self.materials())

    def test_physical_reader_exposes_only_the_recorded_prefix(self):
        raw = io.BytesIO(b'accepted' + b'not in the recorded file')
        physical = verifier.PhysicalArchive(raw,8)
        self.assertEqual(physical.read(100000),b'accepted')
        self.assertEqual(physical.read(100000),b'')
        self.assertEqual(raw.tell(),8)
        self.assertEqual(physical.sha256.hexdigest(),hashlib.sha256(b'accepted').hexdigest())


class RegularFileBoundaries(unittest.TestCase):
    def test_owned_source_cannot_hide_files_behind_a_symlink_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'worker'
            source.mkdir()
            outside = root/'outside'
            outside.mkdir()
            (outside/'main.rs').write_text('owned source')
            (source/'src').symlink_to(outside,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'must not be symlinks'):
                verifier.owned_snapshot(source)

    def test_fifo_is_rejected_promptly_without_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = Path(directory)/'inventory'
            os.mkfifo(fifo)
            code = "import importlib.util,sys; s=importlib.util.spec_from_file_location('v',sys.argv[1]); v=importlib.util.module_from_spec(s); s.loader.exec_module(v); v.load(__import__('pathlib').Path(sys.argv[2]))"
            result = subprocess.run([sys.executable,'-c',code,str(verifier.HERE/'verify-sources.py'),str(fifo)],capture_output=True,timeout=2)
            self.assertNotEqual(result.returncode,0)
            self.assertIn(b'not regular',result.stderr)

    def test_symlinks_and_growth_after_descriptor_metadata_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'regular'
            link = Path(directory)/'link'
            file.write_bytes(b'{}')
            link.symlink_to(file)
            with self.assertRaises(OSError):verifier.load(link)
            stat = verifier.os.fstat
            def grow(fd):
                before = stat(fd)
                with file.open('ab') as target:target.write(b'changed after fstat')
                return before
            for operation in [lambda:verifier.read_regular(file,8),lambda:verifier.digest(file,8),
                              lambda:verifier.copy_regular(file,Path(directory)/'copy',8)]:
                file.write_bytes(b'{}')
                with patch.object(verifier.os,'fstat',side_effect=grow):
                    with self.assertRaises(ValueError):operation()


class ReviewedSourceAnchors(unittest.TestCase):
    def test_release_identity_binds_version_architecture_and_public_path(self):
        sha = 'a'*64
        filename = 'hexbot-pdf-sources-1.2.3-aarch64-'+sha+'.tar.gz'
        sources = {'archive':{'file':filename,'sha256':sha,'url':'https://updates.hexbot.app/daemon/native/1.2.3/macos-aarch64/'+filename}}
        verifier.check_release_identity(sources,'aarch64','1.2.3')
        for arch,version in [('x86_64','1.2.3'),('aarch64','2.0.0'),('aarch64',None)]:
            with self.assertRaises(ValueError):verifier.check_release_identity(sources,arch,version)

    def test_self_described_placeholder_recipe_cannot_replace_a_reviewed_upstream_pin(self):
        key = 'alpine:main:example:' + 'a'*40
        pin = {'recipeSha256':'1'*64,'aportsArchiveSha256':'2'*64}
        by = {key:[{'role':'recipe','sha256':'3'*64},{'role':'build','sha256':'2'*64}]}
        by.update({name:[{'role':'source','sha256':sha} for sha in hashes] for name,hashes in verifier.STATIC_SOURCE_PINS.items()})
        by['musl'].append({'role':'build','sha256':verifier.MUSL_CROSS_HASH})
        with self.assertRaisesRegex(ValueError,'reviewed source pin'):
            verifier.check_source_pins(by,{key}, {'sourceRecipePins':{key:pin}})
        by[key][0]['sha256'] = '1'*64
        verifier.check_source_pins(by,{key}, {'sourceRecipePins':{key:pin}})
        by['rust-std'] = [{'role':'source','sha256':'4'*64}]
        with self.assertRaisesRegex(ValueError,'actual pinned upstream source'):
            verifier.check_source_pins(by,{key}, {'sourceRecipePins':{key:pin}})

    def test_musl_source_does_not_replace_its_actual_build_recipes_and_patches(self):
        by = {name:[{'role':'source','sha256':sha} for sha in hashes] for name,hashes in verifier.STATIC_SOURCE_PINS.items()}
        with self.assertRaisesRegex(ValueError,'musl-cross-make'):
            verifier.check_source_pins(by,{}, {})
        by['musl'].append({'role':'build','sha256':verifier.MUSL_CROSS_HASH})
        verifier.check_source_pins(by,{}, {})

    def test_static_worker_dependency_contract_rejects_unaccounted_crates(self):
        actual = verifier.read_regular(verifier.HERE/'Cargo.lock',1024*1024)
        verifier.check_worker_dependencies()
        for changed in [actual+b'\n[[package]]\nname="other"\nversion="1.0.0"\n',
                        actual.replace(b'"libc",',b'"libc", "other",'),
                        actual.replace(b'version = "0.2.190"',b'version = "0.2.191"')]:
            with patch.object(verifier,'read_regular',return_value=changed):
                with self.assertRaisesRegex(ValueError,'libc-only dependency set'):
                    verifier.check_worker_dependencies()


if __name__ == "__main__":
    unittest.main()
