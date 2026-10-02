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
        env.update(HEXBOT_BACKEND="python", PYTHONPATH=str(Path(__file__).resolve().parents[1]))
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
        file.write_text(f"<string>{legacy}</string><key>EnvironmentVariables</key><dict><key>HEXBOT_HOME</key><string>{self.home}</string></dict><key>PATH</key><string>/usr/bin:{self.home}/runtime/venv/bin</string>")
        transition._migrate_service(self.home, user)
        self.assertIn(str(self.home / "runtime/native-executable"), file.read_text())
        self.assertNotIn("venv", file.read_text())
        self.assertEqual(file.read_text().count("<key>HEXBOT_SUPERVISOR</key><string>service</string>"), 1)
        first = file.stat().st_mtime_ns
        transition._migrate_service(self.home, user)
        self.assertEqual(file.stat().st_mtime_ns, first)

    def test_migration_marks_systemd_services_as_supervised(self):
        user = self.root / "user"
        file = user / ".config/systemd/user/hexbot.service"
        file.parent.mkdir(parents=True)
        legacy = self.home / "runtime/venv/bin/hexbot"
        file.write_text(f'[Service]\nExecStart="{legacy}" serve\nEnvironment=HEXBOT_HOME="{self.home}"\nEnvironment=PATH="/usr/bin:{legacy.parent}"\n')
        with patch("subprocess.run") as run:
            transition._migrate_service(self.home, user)
            run.assert_called_once_with(["systemctl", "--user", "daemon-reload"], check=True, timeout=30)
        self.assertEqual(file.read_text().count("Environment=HEXBOT_SUPERVISOR=service"), 1)
        self.assertNotIn("venv", file.read_text())
        with patch("subprocess.run") as run:
            transition._migrate_service(self.home, user)
            run.assert_not_called()

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
            "from hexbot.cli import main\nraise SystemExit(main())\n"
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

    def test_pointer_without_its_stable_link_reinstalls(self):
        executable = self.install()
        stable = self.home / "runtime/native-executable"
        source = self.root / "source"
        (source / "hexbot").mkdir(parents=True)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        for state in ("missing", "stale"):
            stable.unlink(missing_ok=True)
            if state == "stale":
                stable.symlink_to(sys.executable)
            with self.subTest(state=state), \
                 patch.object(transition, "__file__", str(source / "hexbot/native_transition.py")), \
                 patch.object(transition, "install", return_value=executable) as install, \
                 patch.object(transition.os, "execv"):
                transition.handoff(["version"])
            install.assert_called_once_with(self.home, self.version)

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

    def test_failed_native_install_keeps_serve_retrying_and_fails_version_probe(self):
        source = self.root / "source"
        package = source / "hexbot"
        package.mkdir(parents=True)
        for name in ("__init__.py", "cli.py", "native_transition.py"):
            shutil.copyfile(Path(transition.__file__).parent / name, package / name)
        (source / transition.MARKER).write_text(json.dumps({"version": self.version}))
        launcher = self.launcher()
        old_launcher = launcher.read_bytes()
        script = (
            "from hexbot import native_transition as transition\n"
            "def unavailable(*args, **kwargs):\n    raise OSError('native download unavailable')\n"
            "transition.urllib.request.urlopen = unavailable\n"
            "from hexbot.cli import main\nraise SystemExit(main())\n"
        )
        env = {**os.environ, "PYTHONPATH": str(source)}
        # A service stays up and retries instead of exiting into a restart loop.
        serve = subprocess.Popen([sys.executable, "-c", script, "serve", "--port", "9119"],
                                 cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn("service handoff failed", serve.stderr.readline())
            self.assertIn("Retrying the service handoff", serve.stderr.readline())
            self.assertIsNone(serve.poll())
            self.assertEqual(launcher.read_bytes(), old_launcher)
        finally:
            serve.kill()
            stdout, _ = serve.communicate(timeout=10)
        self.assertEqual(stdout, "")
        result = subprocess.run([sys.executable, "-c", script, "version"],
                                cwd=source, env=env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native download unavailable", result.stderr)


    def legacy_source(self, name, built, project="hermes-agent"):
        source = self.home / "runtime/src" / name
        source.mkdir(parents=True)
        (source / "pyproject.toml").write_text(f'[project]\nname = "{project}"\n')
        if built is not None:
            (source / "HEXBOT_BUILD.json").write_text(json.dumps({"date": built}))
        return source

    def test_failed_probe_restores_the_newest_legacy_source(self):
        venv = self.home / "runtime/venv"
        venv.mkdir(parents=True)
        self.legacy_source("0.1.4", "2026-09-01T00:00:00Z")
        newest = self.legacy_source("0.1.5-nightly.1", "2026-09-20T00:00:00Z")
        self.legacy_source("0.1.6", "2026-10-01T00:00:00Z", project="hexbot-handoff")
        self.legacy_source("broken", None).joinpath("pyproject.toml").unlink()
        calls = []
        with patch.object(transition.sys, "prefix", str(venv)):
            self.assertTrue(transition._restore_legacy_environment(
                self.home, run=lambda *args, **kwargs: calls.append((args, kwargs))))
        self.assertEqual(len(calls), 1)
        (command,), options = calls[0]
        self.assertEqual(command[1:], ["sync", "--extra", "all", "--locked"])
        self.assertEqual(options["cwd"], str(newest))
        self.assertEqual(options["env"]["UV_PROJECT_ENVIRONMENT"], str(venv))
        self.assertTrue(options["check"])

    def test_restore_skips_a_venv_outside_the_service_home(self):
        self.legacy_source("0.1.4", "2026-09-01T00:00:00Z")
        calls = []
        self.assertFalse(transition._restore_legacy_environment(self.home, run=lambda *args, **kwargs: calls.append(args)))
        self.assertEqual(calls, [])

    def test_restore_falls_back_to_an_older_source_when_the_newest_fails(self):
        venv = self.home / "runtime/venv"
        venv.mkdir(parents=True)
        working = self.legacy_source("0.1.4", "2026-09-01T00:00:00Z")
        self.legacy_source("0.1.5-nightly.1", "2026-09-20T00:00:00Z")
        tried = []

        def run(command, **options):
            tried.append(Path(options["cwd"]).name)
            if options["cwd"] != str(working):
                raise subprocess.CalledProcessError(1, command)

        with patch.object(transition.sys, "prefix", str(venv)):
            self.assertTrue(transition._restore_legacy_environment(self.home, run=run))
        self.assertEqual(tried, ["0.1.5-nightly.1", "0.1.4"])

    def test_restore_tries_every_source_and_reports_each_failure(self):
        venv = self.home / "runtime/venv"
        venv.mkdir(parents=True)
        self.legacy_source("0.1.3", "2026-08-01T00:00:00Z")
        self.legacy_source("0.1.4", "2026-09-01T00:00:00Z")
        self.legacy_source("0.1.5-nightly.1", "2026-09-20T00:00:00Z")
        tried = []

        def run(command, **options):
            tried.append(Path(options["cwd"]).name)
            raise subprocess.TimeoutExpired(command, 900)

        with patch.object(transition.sys, "prefix", str(venv)), \
                self.assertRaisesRegex(RuntimeError, "^0.1.5-nightly.1: .*; 0.1.4: .*; 0.1.3: "):
            transition._restore_legacy_environment(self.home, run=run)
        self.assertEqual(tried, ["0.1.5-nightly.1", "0.1.4", "0.1.3"])

    def test_restore_without_legacy_source_fails_loudly(self):
        venv = self.home / "runtime/venv"
        venv.mkdir(parents=True)
        with patch.object(transition.sys, "prefix", str(venv)), self.assertRaisesRegex(RuntimeError, "No previous"):
            transition._restore_legacy_environment(self.home, run=lambda *args, **kwargs: None)

    def test_failed_version_probe_restores_before_failing(self):
        restored = []
        with patch.object(transition, "install", side_effect=OSError("offline")), \
                patch.object(transition, "_restore_legacy_environment", side_effect=restored.append), \
                patch.object(transition.Path, "is_file", return_value=True), \
                patch.object(transition.Path, "read_text", return_value=json.dumps({"version": self.version})), \
                self.assertRaisesRegex(OSError, "offline"):
            transition.handoff(["version"])
        self.assertEqual(restored, [self.home])

    def test_failed_version_probe_reports_the_install_error_when_restore_fails(self):
        with patch.object(transition, "install", side_effect=OSError("offline")), \
                patch.object(transition, "_restore_legacy_environment", side_effect=RuntimeError("no source")), \
                patch.object(transition.Path, "is_file", return_value=True), \
                patch.object(transition.Path, "read_text", return_value=json.dumps({"version": self.version})), \
                self.assertRaisesRegex(OSError, "offline"):
            transition.handoff(["version"])

    def handoff_with_failed_install(self, arguments, restored):
        with patch.object(transition, "install", side_effect=OSError("offline")), \
                patch.object(transition, "_restore_legacy_environment", return_value=restored), \
                patch.object(transition.Path, "is_file", return_value=True), \
                patch.object(transition.Path, "read_text", return_value=json.dumps({"version": self.version})), \
                patch.object(transition.os, "execv") as execv:
            transition.handoff(arguments)
        return execv

    def test_failed_serve_install_runs_the_restored_python_daemon(self):
        execv = self.handoff_with_failed_install(["serve", "--port", "9119"], True)
        legacy = str(self.home / "runtime/venv/bin/hexbot")
        execv.assert_called_once_with(legacy, [legacy, "serve", "--port", "9119"])

    def test_restored_python_daemon_never_starts_beside_a_live_one(self):
        with patch.object(transition, "_refuse_running_daemon", side_effect=RuntimeError("Stop the existing")), \
                self.assertRaisesRegex(RuntimeError, "Stop the existing"):
            self.handoff_with_failed_install(["serve", "--port", "9120"], True)

    def test_failed_serve_install_without_restore_returns_to_the_retry_loop(self):
        self.handoff_with_failed_install(["serve"], False).assert_not_called()

    def test_service_definition_failure_still_hands_off(self):
        executable = self.install()
        with patch.object(transition, "_migrate_service", side_effect=subprocess.CalledProcessError(1, "systemctl")), \
                patch.object(transition.Path, "is_file", return_value=True), \
                patch.object(transition.Path, "read_text", side_effect=[
                    json.dumps({"version": self.version}),
                    json.dumps({"version": self.version, "executable": str(executable)})]), \
                patch.object(transition.os, "execv") as execv:
            transition.handoff(["serve"])
        execv.assert_called_once_with(str(executable), [str(executable), "serve"])


if __name__ == "__main__":
    unittest.main()
