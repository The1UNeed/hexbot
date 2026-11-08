import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import sys
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("pdf_source_collector", HERE / "collect-sources.py")
COLLECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECT)
VERIFY_SPEC = importlib.util.spec_from_file_location("pdf_source_verifier", HERE / "verify-sources.py")
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(VERIFY)


class Response(io.BytesIO):
    def __init__(self, data, url="https://example.invalid/source", declared=None):
        super().__init__(data)
        self.url = url
        self.headers = {} if declared is None else {"Content-Length": str(declared)}


def archive(path, entries):
    with tarfile.open(path, "w:gz") as bundle:
        for name, data in entries:
            header = tarfile.TarInfo(name)
            if data is None:
                header.type, header.linkname = tarfile.SYMTYPE, "../../outside"
                bundle.addfile(header)
            else:
                header.size = len(data)
                bundle.addfile(header, io.BytesIO(data))


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.collector = COLLECT.Collector(self.root / "out", 64)

    def test_paths_reject_escape_noncanonical_controls_and_unrepresentable_length(self):
        for name in ["", ".", "..", "a/../b", "/absolute", "./a", "a//b", "a/", "a\\b", "c:a", "a\x00b", "a\nb", "a" * 256]:
            with self.subTest(name=repr(name)), self.assertRaises(ValueError):
                COLLECT.safe_name(name)
        self.assertEqual(str(COLLECT.safe_name("a/normal-LICENSE.txt")), "a/normal-LICENSE.txt")

    def test_output_cannot_recursively_collect_guest_or_helper_artifacts(self):
        guest = self.root / "source/guest"
        for destination in [guest, guest / "generated", guest.parent / "macos/output"]:
            with self.subTest(destination=destination), patch.object(COLLECT, "HERE", guest), self.assertRaisesRegex(ValueError, "outside"):
                COLLECT.Collector(destination, 64)
            self.assertFalse(destination.exists())

    def test_owned_symlink_directory_is_rejected_instead_of_silently_omitted(self):
        repo = self.root / "repo"
        guest = repo / "backend/pdf-runtime/guest"
        guest.mkdir(parents=True)
        target = self.root / "external-source"
        target.mkdir()
        (target / "lib.rs").write_text("pub fn example() {}")
        (guest / "src").symlink_to(target, target_is_directory=True)
        with patch.object(COLLECT, "HERE", guest), self.assertRaisesRegex(ValueError, "snapshot contains a symlink"):
            self.collector.own_sources(None)

    def test_download_bound_rejects_declared_and_streamed_overflow_without_commit(self):
        for response in [Response(b"body", declared=65), Response(b"x" * 65)]:
            with self.subTest(declared=response.headers), patch.object(COLLECT.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(ValueError):
                    self.collector.fetch("https://example.invalid/source")
                self.assertEqual(self.collector.ledger, {})
                self.assertEqual(list(self.collector.cache.iterdir()), [])

    def test_download_rejects_checksum_mismatch_and_non_https_redirect(self):
        for response, expected in [(Response(b"wrong"), "0" * 64), (Response(b"body", "http://example.invalid/source"), None)]:
            with patch.object(COLLECT.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(ValueError):
                    self.collector.fetch("https://example.invalid/source", sha256=expected)
                self.assertEqual(self.collector.ledger, {})
                self.assertEqual(list(self.collector.cache.iterdir()), [])

    def test_cache_is_rehashed_and_missing_entry_can_refetch_at_full_unique_budget(self):
        body = b"body"
        self.collector.budget = len(body)
        checksum = hashlib.sha256(body).hexdigest()
        url = "https://example.invalid/source"
        with patch.object(COLLECT.urllib.request, "urlopen", side_effect=lambda *_args, **_kwargs: Response(body)) as request:
            downloaded = self.collector.fetch(url, sha256=checksum)
            self.collector.fetch(url, sha256=checksum)
            self.assertEqual(request.call_count, 1)
            downloaded.write_bytes(b"evil")
            self.collector.fetch(url, sha256=checksum)
            downloaded.unlink()
            self.collector.fetch(url, sha256=checksum)
            self.assertEqual(request.call_count, 3)
        self.assertEqual(sum(row["bytes"] for row in self.collector.ledger.values()), len(body))
        self.assertEqual(downloaded.read_bytes(), body)

    def test_warm_cache_obeys_current_per_request_limit_and_total_budget(self):
        with patch.object(COLLECT.urllib.request, "urlopen", return_value=Response(b"12345678")) as request:
            url = "https://example.invalid/source"
            self.collector.fetch(url)
            with self.assertRaisesRegex(ValueError, "per-request"):
                self.collector.fetch(url, limit=1)
            self.collector.budget = 1
            with self.assertRaisesRegex(ValueError, "current unique"):
                self.collector.fetch(url)
            self.assertEqual(request.call_count, 1)

    def test_conflicting_material_is_rejected_before_overwriting_verified_bytes(self):
        self.collector.put("source/file", "component", "source", data=b"original")
        with self.assertRaises(ValueError):
            self.collector.put("source/file", "component", "source", data=b"changed")
        self.assertEqual((self.collector.stage / "source/file").read_bytes(), b"original")

    def test_upstream_scan_copies_license_bytes_without_extracting_links_or_running_hooks(self):
        source = self.root / "upstream.tar.gz"
        sentinel = self.root / "never-created"
        archive(source, [("project/LICENSE", b"Copyright owner\nPermission granted\n"),
                         ("project/build.sh", ("touch " + str(sentinel)).encode()),
                         ("project/licenses/linked", None)])
        copied = self.collector.licenses(source, "component", "licenses")
        self.assertEqual(copied, ["licenses/project/LICENSE"])
        self.assertFalse(sentinel.exists())
        self.assertEqual(len(self.collector.materials), 1)
        self.assertFalse((self.root / "outside").exists())

    def test_upstream_scan_rejects_traversal_and_expansion_before_license_payload(self):
        for name, bound in [("../../LICENSE", 64), ("project/LICENSE", 1)]:
            source = self.root / "upstream.tar.gz"
            archive(source, [(name, b"copyright")])
            with patch.object(COLLECT, "MAX_SCAN", bound):
                self.assertEqual(self.collector.licenses(source, "component", "licenses"), [])
        self.assertEqual([row["kind"] for row in self.collector.gaps], ["license_scan", "license_scan"])
        self.assertEqual(self.collector.materials, {})

    def test_required_source_member_that_is_a_link_remains_an_explicit_gap(self):
        source = self.root / "upstream.tar.gz"
        archive(source, [("project/build.sh", None)])
        self.collector.licenses(source, "component", "licenses",
                                {"project/build.sh": ("build/recipe", "component", "build")})
        self.assertEqual(self.collector.gaps, [{"component": "component", "kind": "missing_source_members",
                                               "members": ["project/build.sh"]}])
        self.assertEqual(self.collector.materials, {})

    def test_hidden_pax_metadata_and_effective_size_cannot_bypass_scan_limit(self):
        source = self.root / "pax.tar.gz"
        for headers in [{"comment": "x" * 16384}, {"size": "1000000000"}]:
            with self.subTest(headers=list(headers)):
                with tarfile.open(source, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
                    member = tarfile.TarInfo("project/LICENSE")
                    member.size, member.pax_headers = 1, headers
                    bundle.addfile(member, io.BytesIO(b"x"))
                with patch.object(COLLECT, "MAX_SCAN", 4096):
                    self.assertEqual(self.collector.licenses(source, "component", "licenses"), [])
        self.assertEqual(len(self.collector.gaps), 2)
        self.assertEqual(self.collector.materials, {})

    def test_oversized_gnu_metadata_is_rejected_before_processing_its_claimed_payload(self):
        source = self.root / "gnu.tar.gz"
        for kind in [tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                     tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK]:
            member = tarfile.TarInfo("extension")
            member.type, member.size = kind, COLLECT.MAX_LICENSE + 1
            source.write_bytes(gzip.compress(member.tobuf(format=tarfile.USTAR_FORMAT) + bytes(1024)))
            with self.subTest(kind=kind), patch.object(tarfile.TarInfo, "_proc_member", side_effect=AssertionError("metadata payload processed")):
                self.assertEqual(self.collector.licenses(source, "component", "licenses"), [])
            self.assertIn("extension metadata", self.collector.gaps[-1]["error"])

    def test_normal_pax_and_gnu_long_names_preserve_full_license_bytes(self):
        for index, format_ in enumerate([tarfile.PAX_FORMAT, tarfile.GNU_FORMAT]):
            source = self.root / f"long-{index}.tar.gz"
            name = "project/" + "nested/" * 18 + "LICENSE"
            with tarfile.open(source, "w:gz", format=format_) as bundle:
                member = tarfile.TarInfo(name)
                member.size = 14
                bundle.addfile(member, io.BytesIO(b"actual license"))
            collector = COLLECT.Collector(self.root / f"long-output-{index}", 64)
            self.assertEqual(collector.licenses(source, "component", "licenses"), ["licenses/" + name])
            self.assertEqual((collector.stage / "licenses" / name).read_bytes(), b"actual license")
            self.assertEqual(collector.gaps, [])

    def test_cumulative_metadata_bound_counts_payload_not_padding_but_rejects_accumulation(self):
        for count in [1, 2]:
            source = self.root / f"metadata-count-{count}.tar.gz"
            with tarfile.open(source, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
                for index in range(count):
                    member = tarfile.TarInfo(f"project/LICENSE.{index}")
                    member.size, member.pax_headers = 1, {"comment": "x" * 32}
                    bundle.addfile(member, io.BytesIO(b"x"))
            collector = COLLECT.Collector(self.root / f"metadata-output-{count}", 64)
            with patch.object(COLLECT, "MAX_TAR_METADATA", 64):
                copied = collector.licenses(source, "component", "licenses")
            self.assertEqual(len(copied), 1)
            self.assertEqual(bool(collector.gaps), count == 2)

    def test_legacy_and_pax_sparse_formats_are_rejected_before_sparse_processing(self):
        variants = [(tarfile.GNUTYPE_SPARSE, {}), (tarfile.REGTYPE, {"GNU.sparse.size": "1"}),
                    (tarfile.REGTYPE, {"GNU.sparse.map": "0,1"}),
                    (tarfile.REGTYPE, {"GNU.sparse.major": "1", "GNU.sparse.minor": "0"})]
        for index, (kind, headers) in enumerate(variants):
            source = self.root / f"sparse-{index}.tar.gz"
            with tarfile.open(source, "w:gz", format=tarfile.PAX_FORMAT) as bundle:
                member = tarfile.TarInfo("project/LICENSE")
                member.size, member.type, member.pax_headers = 1, kind, headers
                bundle.addfile(member, io.BytesIO(b"x"))
            with self.subTest(kind=kind, headers=headers):
                self.assertEqual(self.collector.licenses(source, "component", "licenses"), [])
                self.assertIn("sparse", self.collector.gaps[-1]["error"])

    def test_local_source_only_recipe_keeps_source_and_validates_checksum_without_eval(self):
        local = b"owned source"
        checksum = hashlib.sha512(local).hexdigest()
        recipe = ('source="local.c"\nsha512sums="\n' + checksum + '  local.c\n"\n'
                  'build() { touch /must-never-run; }\n').encode()
        source = self.root / "aports.tar.gz"
        commit = "1" * 40
        prefix = "aports-" + commit + "-main-example/main/example/"
        archive(source, [(prefix + "APKBUILD", recipe), (prefix + "local.c", local)])
        package = {"name": "example", "version": "1-r0", "license": ["MIT"]}
        with patch.object(self.collector, "fetch", return_value=source):
            self.collector.alpine("main", "example", commit, [package], False)
        self.assertIn("source", {row["role"] for row in self.collector.materials.values()})
        self.assertTrue(any(row.get("upstreamFile") == "local.c" and row["sha512"] == checksum
                            for row in self.collector.materials.values()))
        archive(source, [(prefix + "APKBUILD", recipe), (prefix + "local.c", b"tampered")])
        second = COLLECT.Collector(self.root / "second", 64)
        with patch.object(second, "fetch", return_value=source), self.assertRaisesRegex(ValueError, "checksum"):
            second.alpine("main", "example", commit, [package], False)

    def test_notice_dedup_keeps_every_attribution_reference_and_non_utf8_original(self):
        first = self.collector.put("licenses/a", "one", "license", data=b"Copyright A\n")
        self.collector.put("licenses/b", "two", "license", data=b"Copyright A\n")
        last = self.collector.put("licenses/c", "two", "license", data=b"Copyright \xe9\n")
        texts = {first["sha256"]: b"Copyright A\n", last["sha256"]: b"Copyright \xe9\n"}
        rendered = COLLECT.render_notices([], self.collector.materials.values(), texts).decode()
        self.assertEqual(rendered.count("Copyright A\n"), 1)
        for reference in ["one / licenses/a", "two / licenses/b", "two / licenses/c", "Copyright é"]:
            self.assertIn(reference, rendered)
        with self.assertRaises(ValueError):
            COLLECT.render_notices([], [first], {first["sha256"]: b"altered"})

    def test_companion_is_deterministic_ustar_and_actual_verifier_checks_bytes(self):
        self.collector.put("project/source.tar.gz", "one", "source", data=b"original archive bytes")
        self.collector.put("project/LICENSE", "one", "license", data=b"actual full license")
        one = self.collector.companion("aarch64", "1.2.3", "https://updates.hexbot.app/native/1.2.3")
        two = self.collector.companion("aarch64", "1.2.3", "https://updates.hexbot.app/native/1.2.3")
        self.assertEqual(one, two)
        output = self.collector.output / one["file"]
        VERIFY.check_archive(output, one, self.collector.materials)
        inventory = self.collector.inventory("aarch64", one)
        self.assertFalse(inventory["completeCorrespondingSourceArchive"])
        with self.assertRaisesRegex(ValueError, "prototype"):
            VERIFY.verify(output, inventory, {}, "aarch64")
        with output.open("ab") as file:
            file.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "byte length"):
            VERIFY.check_archive(output, one, self.collector.materials)

    def test_companion_refuses_changed_material_or_invalid_version_and_url(self):
        self.collector.put("source", "one", "source", data=b"original")
        with self.assertRaisesRegex(ValueError, "architecture"):
            self.collector.companion("../../escape", "1.2.3", "https://updates.hexbot.app")
        for version, url in [("../escape", "https://example.invalid"), ("1.2.3", "http://example.invalid"), ("1.2.3", "https://example.invalid?token=private")]:
            with self.assertRaises(ValueError):
                self.collector.companion("aarch64", version, url)
        (self.collector.stage / "source").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.collector.companion("aarch64", "1.2.3", "https://updates.hexbot.app")

    def test_missing_signature_receipt_is_an_explicit_gap_not_a_complete_claim(self):
        with patch.object(COLLECT, "trusted_gpg", return_value=None):
            self.collector.signature_receipts(None)
        self.assertEqual(self.collector.gaps[0]["kind"], "detached_signature_verification_pending")
        result = self.collector.inventory("aarch64")
        self.assertFalse(result["completeCorrespondingSourceArchive"])
        self.assertIsNone(result["archive"])
        self.assertEqual(json.loads((self.collector.output / "SOURCES.json").read_text()), result)

    def test_required_gpg_cannot_be_replaced_by_an_external_receipt(self):
        with patch.object(COLLECT, "trusted_gpg", return_value=None), self.assertRaisesRegex(ValueError, "trusted gpg"):
            self.collector.signature_receipts(self.root, required=True)

    def test_gpg_uses_isolated_offline_home_and_requires_the_pinned_primary_key(self):
        for name in COLLECT.RUST_SOURCE_HASHES:
            path = self.collector.stage / "rust" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"source")
            Path(str(path) + ".asc").write_bytes(b"signature")
        (self.collector.stage / "rust/rust-key.gpg.ascii").write_bytes(b"public key")
        calls = []

        def run(command, environment):
            calls.append((command, environment))
            if "--list-keys" in command:
                output = b"pub:::::::::\nfpr:::::::::" + COLLECT.RUST_KEY.encode() + b":\n"
            elif "--verify" in command:
                output = ("[GNUPG:] VALIDSIG " + COLLECT.RUST_KEY + " 2026-07-16 1 0 4 0 1 10 00 " + COLLECT.RUST_KEY + "\n").encode()
            else:
                output = b""
            return output

        with patch.object(COLLECT, "bounded_command", side_effect=run):
            results = self.collector.check_rust_signatures("/trusted/bin/gpg")
        self.assertEqual(len(results), 2)
        for row in results:
            self.assertEqual(row["trustedSigningFingerprint"], COLLECT.RUST_KEY)
            self.assertEqual(row["publicKey"]["sha256"], hashlib.sha256(b"public key").hexdigest())
            self.assertEqual(row["signature"]["sha256"], hashlib.sha256(b"signature").hexdigest())
        homes = set()
        for command, environment in calls:
            for required in ["--no-options", "--no-auto-key-retrieve", "--no-auto-key-import", "--no-autostart"]:
                self.assertIn(required, command)
            home = command[command.index("--homedir") + 1]
            homes.add(home)
            self.assertTrue(Path(home).is_relative_to(self.collector.output))
            self.assertEqual(environment["GNUPGHOME"], home)
            self.assertEqual(environment["PATH"], os.defpath)
        self.assertEqual(len(homes), 1)
        self.assertFalse(Path(next(iter(homes))).exists())
        wrong = b"pub:::::::::\nfpr:::::::::" + b"0" * 40 + b":\n"
        with patch.object(COLLECT, "bounded_command", return_value=wrong):
            with self.assertRaisesRegex(ValueError, "primary fingerprint"):
                self.collector.check_rust_signatures("/trusted/bin/gpg")

    def test_trusted_child_capture_enforces_stdout_stderr_cap_and_timeout_during_execution(self):
        environment = {"PATH": os.defpath}
        output = COLLECT.bounded_command([sys.executable, "-c", "import os; os.write(1,b'ok'); os.write(2,b'note')"], environment)
        self.assertEqual(output, b"ok")
        for stream in [1, 2]:
            with self.subTest(stream=stream), self.assertRaisesRegex(ValueError, "bounded output"):
                COLLECT.bounded_command([sys.executable, "-c", f"import os; os.write({stream}, b'x'*4096)"], environment, limit=128)
        with self.assertRaisesRegex(ValueError, "timed out"):
            COLLECT.bounded_command([sys.executable, "-c", "while True: pass"], environment, timeout=0.1)

    def test_external_receipt_must_bind_actual_signature_and_key_material_hashes(self):
        rust = self.collector.stage / "rust"
        rust.mkdir()
        results = []
        pins = {name: hashlib.sha256(b"source").hexdigest() for name in COLLECT.RUST_SOURCE_HASHES}
        for name, checksum in pins.items():
            (rust / name).write_bytes(b"source")
            (rust / (name + ".asc")).write_bytes(b"signature")
            results.append({"file": name, "bytes": 6, "sha256": checksum, "exit": 0,
                            "validsig": ["[GNUPG:] VALIDSIG " + COLLECT.RUST_KEY + " 2026-07-16 1 0 4 0 1 10 00 " + COLLECT.RUST_KEY],
                            "trustedPrimaryFingerprint": COLLECT.RUST_KEY, "trustedSigningFingerprint": COLLECT.RUST_KEY,
                            "signature": {"file": name + ".asc", "bytes": 9, "sha256": "0" * 64},
                            "publicKey": {"file": "rust-key.gpg.ascii", "bytes": 10, "sha256": hashlib.sha256(b"public key").hexdigest()}})
        (rust / "rust-key.gpg.ascii").write_bytes(b"public key")
        (self.root / "results.json").write_text(json.dumps(results))
        with patch.object(COLLECT, "trusted_gpg", return_value=None), patch.object(COLLECT, "RUST_SOURCE_HASHES", pins), self.assertRaisesRegex(ValueError, "actual signature bytes"):
            self.collector.signature_receipts(self.root)

    def test_cargo_lock_requires_exact_libc_record_and_rejects_comment_bypass_or_extra_crate(self):
        repo = self.root / "repo"
        guest = repo / "backend/pdf-runtime/guest"
        guest.mkdir(parents=True)
        for name in ["LICENSE", "NOTICE"]:
            (repo / name).write_text("actual repository " + name)
        template = ('version = 3\n[[package]]\nname = "hexbot-pdf-worker"\nversion = "0.1.0"\n'
                    '[[package]]\nname = "{name}"\nversion = "{version}"\n'
                    'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
                    'checksum = "{checksum}"\n')
        variants = [("libc", "0.2.191", COLLECT.LIBC_HASH, ""),
                    ("other", "0.2.190", COLLECT.LIBC_HASH, ""),
                    ("libc", "0.2.190", "0" * 64, ""),
                    ("libc", "0.2.190", COLLECT.LIBC_HASH, '\n[[package]]\nname = "extra"\nversion = "1"\n')]
        for index, (name, version, checksum, extra) in enumerate(variants):
            original_pin_comment = '# version = "0.2.190" checksum = "' + COLLECT.LIBC_HASH + '"\n'
            (guest / "Cargo.lock").write_text(original_pin_comment + template.format(name=name, version=version, checksum=checksum) + extra)
            collector = COLLECT.Collector(self.root / f"rejected-{index}", 64)
            with self.subTest(name=name, version=version, extra=extra), patch.object(COLLECT, "HERE", guest), self.assertRaisesRegex(ValueError, "Cargo.lock"):
                collector.own_sources(None)
        (guest / "Cargo.lock").write_text(template.format(name="libc", version="0.2.190", checksum=COLLECT.LIBC_HASH))
        collector = COLLECT.Collector(self.root / "accepted", 64)
        with patch.object(COLLECT, "HERE", guest):
            collector.own_sources(None)
        self.assertTrue(any(item["path"] == "worker/Cargo.lock" for item in collector.materials.values()))


if __name__ == "__main__":
    unittest.main()
