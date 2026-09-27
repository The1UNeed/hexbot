"""The historical service entry point can move to Rust without changing its home."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from hexbot import native_transition as transition


class NativeTransitionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hexbot-transition-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.archive = self.root / "bundle.tar.gz"
        self.version = "1.2.3"
        self.manifest = {
            "version": self.version, "target": "linux-x86_64", "format": "tar.gz",
            "entrypoint": "hexbot", "url": "https://updates.example/bundle.tar.gz",
        }
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HEXBOT_HOME": str(self.home), "HEXBOT_UPDATE_URL": "https://updates.example"}).start()
        patch.object(transition.platform, "system", return_value="Linux").start()
        patch.object(transition.platform, "machine", return_value="x86_64").start()
        self.bundle([("hexbot", b'#!/bin/sh\nif [ "$1" = version ]; then echo 1.2.3; else printf "%s\\n" "$@"; fi\n')])

    def bundle(self, entries):
        with tarfile.open(self.archive, "w:gz") as output:
            for name, data in entries:
                entry = tarfile.TarInfo(name)
                entry.mode = 0o755
                if isinstance(data, bytes):
                    entry.size = len(data)
                    output.addfile(entry, io.BytesIO(data))
                else:
                    entry.type, entry.linkname = data
                    output.addfile(entry)
        self.manifest["sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def download(self, url, destination, limit):
        if url.endswith("manifest.json"):
            self.assertEqual(url, "https://updates.example/daemon/native/1.2.3/linux-x86_64/manifest.json")
            destination.write_text(json.dumps(self.manifest))
        else:
            self.assertEqual(url, self.manifest["url"])
            shutil.copyfile(self.archive, destination)

    def install(self):
        return transition.install(self.home, self.version, download=self.download)

    def launcher(self):
        launcher = self.home / "runtime/venv/bin/hexbot"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("#!/bin/sh\necho old\n")
        launcher.chmod(0o755)
        launcher.with_name("python").symlink_to(sys.executable)
        return launcher

    def test_service_launcher_always_runs_native_and_preserves_data(self):
        launcher = self.launcher()
        database = self.home / "state.db"
        database.write_bytes(b"existing conversations")
        memory = self.home / "bots/owl/MEMORY.md"
        memory.parent.mkdir(parents=True)
        memory.write_text("remember this")
        executable = self.install()
        self.assertEqual((self.home / "runtime/native-executable").resolve(), executable)
        self.assertEqual(json.loads((self.home / "runtime/native-current.json").read_text())["executable"], str(executable))
        env = {**os.environ, "HEXBOT_BACKEND": "rust"}
        result = subprocess.run([str(launcher), "serve", "--port", "9119"], env=env, check=True, text=True, capture_output=True)
        self.assertEqual(result.stdout, "serve\n--port\n9119\n")
        env.update(HEXBOT_BACKEND="python", PYTHONPATH=str(Path(__file__).resolve().parents[2]))
        result = subprocess.run([str(launcher), "version"], env=env, check=True, text=True, capture_output=True)
        self.assertEqual(result.stdout.strip(), self.version)
        self.assertEqual(database.read_bytes(), b"existing conversations")
        self.assertEqual(memory.read_text(), "remember this")

    def test_live_legacy_listener_blocks_handoff_until_stopped(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            (self.home / "serve-state.json").write_text(json.dumps({"host": "0.0.0.0", "port": port}))
            with self.assertRaisesRegex(RuntimeError, "Stop the existing"):
                transition._refuse_running_daemon(self.home)
        transition._refuse_running_daemon(self.home)
        from unittest.mock import patch
        for error in [TimeoutError("timeout"), OSError("network unreachable")]:
            with patch("socket.create_connection", side_effect=error):
                transition._refuse_running_daemon(self.home)

    def test_migration_updates_only_this_homes_service_and_removes_venv_path(self):
        user = self.root / "user"
        file = user / "Library/LaunchAgents/app.hexbot.daemon.plist"
        file.parent.mkdir(parents=True)
        legacy = str(self.home / "runtime/venv/bin/hexbot")
        file.write_text(f"<string>{legacy}</string><key>PATH</key><string>/usr/bin:{self.home}/runtime/venv/bin</string>")
        transition._migrate_service(self.home, user)
        self.assertIn(str(self.home / "runtime/native-executable"), file.read_text())
        self.assertNotIn("venv", file.read_text())
        first = file.stat().st_mtime_ns
        transition._migrate_service(self.home, user)
        self.assertEqual(file.stat().st_mtime_ns, first)

    def test_failed_download_checksum_and_runtime_probe_keep_old_launcher(self):
        launcher = self.launcher()
        for failure in ("download", "checksum", "version"):
            with self.subTest(failure=failure):
                if failure == "version":
                    self.bundle([("hexbot", b"#!/bin/sh\necho 0.0.0\n")])
                elif failure == "checksum":
                    self.manifest["sha256"] = "0" * 64
                download = self.download if failure != "download" else lambda *_: (_ for _ in ()).throw(OSError("offline"))
                with self.assertRaises((ValueError, OSError)):
                    transition.install(self.home, self.version, download=download)
                self.assertEqual(launcher.read_text(), "#!/bin/sh\necho old\n")
                self.assertFalse((self.home / "runtime/native-current.json").exists())
                self.assertFalse((self.home / "runtime/native-executable").exists())
                self.assertEqual(list((self.home / "runtime/native").iterdir()), [])

    def test_unsafe_archives_are_rejected_before_activation(self):
        for entry in [
            ("../escaped", b"bad"), ("/absolute", b"bad"), ("a\\b", b"bad"),
            ("hexbot", (tarfile.SYMTYPE, "outside")),
            ("hexbot", (tarfile.LNKTYPE, "outside")),
            ("hexbot", (tarfile.FIFOTYPE, "")),
        ]:
            with self.subTest(entry=entry[0:1]):
                self.bundle([entry])
                with self.assertRaises(ValueError):
                    self.install()
                self.assertFalse((self.home / "runtime/native-executable").exists())
        self.assertFalse((self.root / "escaped").exists())

    def test_unpack_and_entry_limits_are_enforced(self):
        for limit in ("MAX_UNPACKED", "MAX_ENTRIES"):
            with self.subTest(limit=limit), patch.object(transition, limit, 0), self.assertRaises(ValueError):
                self.install()

    def test_manifests_cannot_select_another_origin_platform_or_entrypoint(self):
        for key, value in [
            ("version", "9.9.9"), ("target", "macos-aarch64"), ("format", "zip"),
            ("entrypoint", "../../shell"), ("url", "http://updates.example/bundle.tar.gz"),
            ("url", "https://attacker.example/bundle.tar.gz"),
        ]:
            with self.subTest(key=key, value=value), patch.dict(self.manifest, {key: value}), self.assertRaises(ValueError):
                self.install()

    def test_invalid_versions_and_symlink_runtime_fail_before_download(self):
        with self.assertRaises(ValueError):
            transition.install(self.home, "../1.2.3", download=self.download)
        outside = self.root / "outside"
        outside.mkdir()
        (self.home / "runtime").symlink_to(outside)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_executable_pointer_preserves_previous_metadata(self):
        runtime = self.home / "runtime"
        (runtime / "native-executable").mkdir(parents=True)
        metadata = runtime / "native-current.json"
        metadata.write_text('{"version":"old","executable":"old"}')
        with self.assertRaisesRegex(ValueError, "cannot be a directory"):
            self.install()
        self.assertEqual(metadata.read_text(), '{"version":"old","executable":"old"}')

    def test_historical_python_restart_hands_off_without_redownloading(self):
        executable = self.install()
        source = self.root / "source"
        package = source / "hexbot"
        package.mkdir(parents=True)
        for name in ("__init__.py", "cli.py", "native_transition.py"):
            shutil.copyfile(Path(transition.__file__).parent / name, package / name)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        # The old daemon's restart is `python -m hexbot.cli serve --port N`.
        result = subprocess.run([sys.executable, "-m", "hexbot.cli", "serve", "--port", "9119"],
                                cwd=source, env={**os.environ, "PYTHONPATH": str(source), "HEXBOT_BACKEND": "rust"},
                                check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout, "serve\n--port\n9119\n")
        self.assertTrue(executable.is_file())

    def test_legacy_updater_version_probe_installs_then_replaces_service_entrypoint(self):
        launcher = self.launcher()
        source = self.root / "source"
        package = source / "hexbot"
        package.mkdir(parents=True)
        for name in ("__init__.py", "cli.py", "native_transition.py"):
            shutil.copyfile(Path(transition.__file__).parent / name, package / name)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps(self.manifest))
        # `uv sync` installs this console entry point from the compatibility source.
        # Inject only its HTTPS download boundary; unpacking, validation and exec are real.
        launcher.write_text(
            f"#!{sys.executable}\nimport sys, shutil, functools\n"
            f"sys.path.insert(0, {str(source)!r})\n"
            "from hexbot import native_transition as transition\n"
            "transition.platform.system = lambda: 'Linux'\n"
            "transition.platform.machine = lambda: 'x86_64'\n"
            "def download(url, destination, limit):\n"
            f"    shutil.copyfile({str(manifest)!r} if url.endswith('manifest.json') else {str(self.archive)!r}, destination)\n"
            "transition.install = functools.partial(transition.install, download=download)\n"
            "from hexbot.cli import main\nmain()\n"
        )
        env = {**os.environ, "HEXBOT_BACKEND": "rust"}
        result = subprocess.run([str(launcher), "version"], env=env, check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout.strip(), self.version)
        self.assertTrue(launcher.read_text().startswith("#!/bin/sh\n"))
        result = subprocess.run([str(launcher), "serve", "--port", "9119"], env=env, check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout, "serve\n--port\n9119\n")

    def test_download_bounds_and_https_origin_are_checked(self):
        class Response(io.BytesIO):
            url = "https://updates.example/bundle.tar.gz"

        for url, limit in [("http://updates.example/bundle.tar.gz", 100),
                           ("https://other.example/bundle.tar.gz", 100),
                           ("https://updates.example/bundle.tar.gz", 1)]:
            response = Response(b"payload")
            response.url = url
            with self.subTest(url=url, limit=limit), \
                 patch.object(transition.urllib.request, "urlopen", return_value=response), \
                 self.assertRaises(ValueError):
                transition._download("https://updates.example/bundle.tar.gz", self.root / "download", limit)

    def test_cached_pointer_outside_runtime_is_never_executed(self):
        runtime = self.home / "runtime"
        runtime.mkdir()
        (runtime / "native-current.json").write_text(json.dumps({"version": self.version, "executable": str(sys.executable)}))
        source = self.root / "source"
        (source / "hexbot").mkdir(parents=True)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        selected = self.root / "validated"
        with patch.object(transition, "__file__", str(source / "hexbot/native_transition.py")), \
             patch.object(transition, "install", return_value=selected) as install, \
             patch.object(transition.os, "execv") as execute, \
             patch.dict(os.environ, {"HEXBOT_BACKEND": "rust"}):
            transition.handoff(["version"])
        install.assert_called_once_with(self.home, self.version)
        execute.assert_called_once_with(str(selected), [str(selected), "version"])

    def test_invalid_cached_pointer_types_fall_back_to_verified_install(self):
        runtime = self.home / "runtime"
        runtime.mkdir()
        source = self.root / "source"
        (source / "hexbot").mkdir(parents=True)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        for selected in [None, [], 5, {"executable": None}, {"executable": 123}, {"executable": "missing"}]:
            (runtime / "native-current.json").write_text(json.dumps(selected))
            with self.subTest(selected=selected), \
                 patch.object(transition, "__file__", str(source / "hexbot/native_transition.py")), \
                 patch.object(transition, "install", return_value=self.root / "validated") as install, \
                 patch.object(transition.os, "execv"), \
                 patch.dict(os.environ, {"HEXBOT_BACKEND": "rust"}):
                transition.handoff(["version"])
            install.assert_called_once_with(self.home, self.version)


if __name__ == "__main__":
    unittest.main()
