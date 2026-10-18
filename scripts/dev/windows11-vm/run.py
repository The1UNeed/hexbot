#!/usr/bin/env python3
"""Run the PSEC candidate in an ephemeral, native Windows 11 x64 KVM guest."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[2]
USERNAME = r"HEXBOT-VM\HexbotVmAdmin"
PORT = 15985
# The guest reaches this host listener through slirp's 10.0.2.2 gateway alias,
# so progress beacons arrive even while WinRM is broken or not yet configured.
BEACON_PORT = 15986

class _BeaconHandler(BaseHTTPRequestHandler):
    evidence = None
    lock = threading.Lock()
    terminal = None
    terminal_at = 0.0
    def do_GET(self):
        with _BeaconHandler.lock:
            with (_BeaconHandler.evidence / "beacon.log").open("a") as log:
                log.write(f"{time.strftime('%H:%M:%S')} {self.path}\n")
            if self.path.startswith("/beacon/phase-passed") or self.path.startswith("/beacon/phase-failed") \
                    or self.path.startswith("/beacon/bootstrap-error-"):
                _BeaconHandler.terminal = self.path
                _BeaconHandler.terminal_at = time.monotonic()
        self.send_response(204)
        self.end_headers()
    def log_message(self, *args):
        pass


def beacon_server(evidence):
    _BeaconHandler.evidence = evidence
    server = ThreadingHTTPServer(("127.0.0.1", BEACON_PORT), _BeaconHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def validate():
    manifest = json.loads((SOURCE / "downloads.json").read_text())
    for item in [manifest[key] for key in ["iso", "node", "python", "mxc"]] + manifest["updates"]:
        assert item["url"].startswith("https://")
        assert len(item["sha256"]) == 64
        int(item["sha256"], 16)
    xml = (SOURCE / "unattend.xml").read_text()
    assert xml.count("HEXBOT_GENERATED_PASSWORD") == 2
    ET.fromstring(xml.replace("HEXBOT_GENERATED_PASSWORD", "Vm9!example"))
    for name in ["bootstrap.ps1", "guest.ps1", "standard-user.ps1"]:
        assert (SOURCE / name).is_file()
    assert (REPO / "scripts/dev/windows-sandbox-candidate-smoke.mjs").is_file()
    return manifest


def download(item, destination):
    for attempt in range(3):
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(item["url"], timeout=120) as response, destination.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
            if digest.hexdigest() != item["sha256"]:
                raise RuntimeError(f"The pinned checksum does not match: {destination.name}")
            return
        except Exception:
            destination.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2)


def qmp(address, command, arguments=None):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(10)
        connection.connect(str(address))
        stream = connection.makefile("rwb")
        json.loads(stream.readline())
        for name, args in [("qmp_capabilities", {}), (command, arguments or {})]:
            stream.write((json.dumps({"execute": name, "arguments": args}) + "\n").encode())
            stream.flush()
            while True:
                reply = json.loads(stream.readline())
                if "error" in reply:
                    raise RuntimeError(f"QMP {name} failed: {reply['error']}")
                if "return" in reply:
                    break
        return reply["return"]


def collect(session, evidence):
    result = session.run_ps(r"""
    $ErrorActionPreference = 'Stop'
    Compress-Archive -Path C:\HexbotVm\evidence\* -DestinationPath C:\HexbotVm\evidence.zip -Force
    (Get-Item C:\HexbotVm\evidence.zip).Length
    """)
    if result.status_code:
        raise RuntimeError("Cannot package the guest evidence")
    length = int(result.std_out.decode("utf-8-sig").strip())
    if length > 32 * 1024 * 1024:
        raise RuntimeError("Guest evidence exceeded 32 MiB")
    with (evidence / "guest-evidence.zip").open("wb") as output:
        for offset in range(0, length, 49152):
            result = session.run_ps(r"""
            $stream = [IO.File]::OpenRead('C:\HexbotVm\evidence.zip')
            try {
                $stream.Position = OFFSET
                $buffer = New-Object byte[] 49152
                $count = $stream.Read($buffer, 0, $buffer.Length)
                [Convert]::ToBase64String($buffer, 0, $count)
            } finally { $stream.Dispose() }
            """.replace("OFFSET", str(offset)))
            if result.status_code:
                raise RuntimeError("Cannot read the guest evidence")
            output.write(base64.b64decode(result.std_out.decode("utf-8-sig").strip(), validate=True))


def run(manifest, evidence):
    import winrm

    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("This proof requires a native Linux x86_64 KVM host")
    kvm = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
    os.close(kvm)
    evidence.mkdir(parents=True, exist_ok=True)
    df = subprocess.run(["df", "-h"], capture_output=True, text=True, check=False)
    (evidence / "host-df.txt").write_text(df.stdout)
    if shutil.disk_usage(evidence).free < 40 * 1024**3:
        raise RuntimeError("The Windows VM needs at least 40 GiB of free host disk space; see host-df.txt")
    processes = []
    logs = []
    beacon = beacon_server(evidence)
    with tempfile.TemporaryDirectory(prefix="hexbot-win11-", dir=os.environ.get("RUNNER_TEMP")) as directory:
        private = Path(directory)
        payload = private / "payload"
        payload.mkdir()
        password = "Vm9!" + secrets.token_hex(24)
        # The generated password exists only in this private directory and the
        # disposable guest. Neither the directory nor the VM is an artifact.
        (payload / "Autounattend.xml").write_text((SOURCE / "unattend.xml").read_text().replace("HEXBOT_GENERATED_PASSWORD", password))
        for name in ["bootstrap.ps1", "guest.ps1", "standard-user.ps1", "downloads.json"]:
            shutil.copyfile(SOURCE / name, payload / name)
        shutil.copyfile(REPO / "scripts/dev/windows-sandbox-candidate-smoke.mjs", payload / "probe.mjs")
        (payload / "fixtures").mkdir()
        shutil.copyfile(REPO / "scripts/dev/fixtures/windows-psec-token-probe.py", payload / "fixtures/windows-psec-token-probe.py")
        print("Downloading and checking the pinned Microsoft evaluation ISO and test tools", flush=True)
        download(manifest["iso"], private / "windows.iso")
        download(manifest["node"], payload / "node.exe")
        download(manifest["python"], payload / "python.zip")
        download(manifest["mxc"], private / "mxc.zip")
        with zipfile.ZipFile(private / "mxc.zip") as archive:
            executable = archive.read("x64/wxc-exec.exe")
        if hashlib.sha256(executable).hexdigest() != manifest["mxc"]["executableSha256"]:
            raise RuntimeError("The native MXC executable checksum does not match")
        (payload / "wxc-exec.exe").write_bytes(executable)
        (private / "mxc.zip").unlink()
        subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-J", "-R", "-V", "HEXBOT_PAYLOAD", "-o", str(private / "payload.iso"), str(payload)], check=True)
        shutil.copyfile("/usr/share/OVMF/OVMF_VARS_4M.ms.fd", private / "vars.fd")
        subprocess.run(["qemu-img", "create", "-q", "-f", "qcow2", str(private / "windows.qcow2"), "64G"], check=True)
        tpm = private / "tpm"
        tpm.mkdir()
        monitor = private / "qmp.sock"
        command = [
            "qemu-system-x86_64", "-machine", "q35,accel=kvm,smm=on", "-cpu", "host", "-smp", "2", "-m", "6144",
            "-global", "driver=cfi.pflash01,property=secure,value=on",
            "-drive", "if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.ms.fd",
            "-drive", f"if=pflash,format=raw,unit=1,file={private / 'vars.fd'}",
            "-drive", f"if=none,id=system,format=qcow2,file={private / 'windows.qcow2'}",
            "-device", "ide-hd,drive=system,bus=ide.0",
            "-drive", f"if=none,id=installer,media=cdrom,readonly=on,file={private / 'windows.iso'}",
            "-device", "ide-cd,drive=installer,bus=ide.1",
            "-drive", f"if=none,id=payload,media=cdrom,readonly=on,file={private / 'payload.iso'}",
            "-device", "ide-cd,drive=payload,bus=ide.2",
            "-chardev", f"socket,id=tpm,path={tpm / 'socket'}", "-tpmdev", "emulator,id=tpm0,chardev=tpm", "-device", "tpm-tis,tpmdev=tpm0",
            "-netdev", f"user,id=net0,hostfwd=tcp:127.0.0.1:{PORT}-:5985", "-device", "e1000e,netdev=net0",
            "-boot", "order=c,once=d,menu=off", "-display", "none", "-vga", "std", "-nic", "none",
            "-qmp", f"unix:{monitor},server=on,wait=off", "-monitor", "none", "-serial", "none",
        ]
        try:
            for name, args in [
                ("swtpm", ["swtpm", "socket", "--tpm2", "--tpmstate", f"dir={tpm}", "--ctrl", f"type=unixio,path={tpm / 'socket'}"]),
                ("qemu", command),
            ]:
                if name == "qemu":
                    limit = time.monotonic() + 10
                    while not (tpm / "socket").exists() and time.monotonic() < limit:
                        time.sleep(0.1)
                log = (evidence / f"{name}.log").open("wb")
                logs.append(log)
                processes.append(subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT))
            vm = processes[-1]
            started_at = time.monotonic()
            last_frame = -1
            # Microsoft's UEFI DVD asks for a key before starting Setup. The
            # key press is best effort; slow media spin-up can delay the prompt,
            # so keep pressing for 90 seconds rather than 12.
            for _ in range(90):
                time.sleep(1)
                if monitor.exists():
                    try:
                        qmp(monitor, "send-key", {"keys": [{"type": "qcode", "data": "spc"}]})
                    except (OSError, RuntimeError, ValueError):
                        pass
            session = winrm.Session(f"http://127.0.0.1:{PORT}/wsman", auth=(USERNAME, password), transport="ntlm", message_encryption="always", operation_timeout_sec=15, read_timeout_sec=20)
            deadline = time.monotonic() + 100 * 60
            last_message = None
            heartbeat = 0
            ready = False
            state = None
            while time.monotonic() < deadline:
                if vm.poll() is not None:
                    raise RuntimeError(f"The Windows VM exited early with code {vm.returncode}")
                state = None
                try:
                    result = session.run_ps("$ErrorActionPreference='Stop'; Get-Content C:\\HexbotVm\\state.json -Raw")
                    if result.status_code == 0:
                        state = json.loads(result.std_out.decode("utf-8-sig"))
                # pywinrm 0.5.0 raises transport errors that do not inherit
                # from WinRMError; tolerate every transient it can produce.
                except (ET.ParseError, OSError, ValueError, winrm.exceptions.WinRMError,
                        winrm.exceptions.WinRMOperationTimeoutError, winrm.exceptions.WinRMTransportError):
                    # Setup and the cumulative update both reboot the guest, and
                    # the WinRM service can briefly answer 500 or a non-XML body
                    # while it starts. All of these are transients.
                    pass
                if state is not None:
                    if not ready:
                        # Setup and bootstrap have copied everything they need.
                        # Ejecting both DVDs is best effort: the guest keeps its
                        # payload, and a failed eject must not kill a healthy run.
                        ready = True
                        for device in ("payload", "installer"):
                            try:
                                qmp(monitor, "eject", {"device": device, "force": True})
                            except (OSError, RuntimeError, ValueError):
                                pass
                    message = f"{state['phase']}: {state['message']}"
                    if message != last_message:
                        print(message, flush=True)
                        last_message = message
                    if state["phase"] in ["passed", "failed"]:
                        # A decided run must report its real result, never loop
                        # to the deadline on a transient collection failure.
                        (evidence / "result.json").write_text(json.dumps(state, indent=2))
                        for attempt in range(3):
                            try:
                                collect(session, evidence)
                                break
                            except (ET.ParseError, OSError, ValueError, winrm.exceptions.WinRMError,
                                    winrm.exceptions.WinRMOperationTimeoutError, winrm.exceptions.WinRMTransportError):
                                if attempt == 2:
                                    raise
                                time.sleep(10)
                        if state["phase"] != "passed":
                            raise RuntimeError("The Windows 11 x64 guest validation failed; see guest-evidence.zip")
                        return
                # A terminal beacon means the guest decided its own outcome;
                # keep waiting briefly for WinRM to return the full state, then
                # stop instead of heartbeating to the deadline for an hour.
                if _BeaconHandler.terminal and time.monotonic() - _BeaconHandler.terminal_at > 180:
                    raise RuntimeError(
                        f"The guest reported {_BeaconHandler.terminal} through its beacon; see beacon.log"
                    )
                if time.monotonic() >= heartbeat:
                    print("Waiting for Windows Setup, the pinned update, or the containment test", flush=True)
                    heartbeat = time.monotonic() + 45
                # Capture the guest's display every five minutes so the evidence
                # shows where Setup, OOBE, or the test actually is.
                frame = int((time.monotonic() - started_at) // 300)
                if frame != last_frame:
                    last_frame = frame
                    try:
                        qmp(monitor, "screendump", {"filename": str(evidence / f"screen-{frame:03d}.ppm")})
                    except (OSError, RuntimeError, ValueError):
                        pass
                    for old in sorted(evidence.glob("screen-*.ppm"))[:-4]:
                        old.unlink(missing_ok=True)
                time.sleep(10)
            raise RuntimeError("The Windows VM exceeded its 100-minute deadline")
        finally:
            try:
                beacon.shutdown()
            except OSError:
                pass
            if monitor.exists():
                try:
                    qmp(monitor, "screendump", {"filename": str(evidence / "display.ppm")})
                except (OSError, RuntimeError, ValueError):
                    pass
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
            for log in logs:
                log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate the inputs without starting or downloading a VM")
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    inputs = validate()
    if args.check:
        print("Windows VM inputs are valid")
    else:
        if args.evidence is None:
            parser.error("--evidence is required")
        args.evidence = args.evidence.resolve()
        args.evidence.mkdir(parents=True, exist_ok=True)
        run(inputs, args.evidence)
