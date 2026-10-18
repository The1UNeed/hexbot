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
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[2]
USERNAME = r"HEXBOT-VM\HexbotVmAdmin"
PORT = 15985


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
    length = int(result.std_out.decode().strip())
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
            output.write(base64.b64decode(result.std_out.decode().strip(), validate=True))


def run(manifest, evidence):
    import winrm

    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("This proof requires a native Linux x86_64 KVM host")
    kvm = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
    os.close(kvm)
    if shutil.disk_usage(evidence).free < 45 * 1024**3:
        raise RuntimeError("The Windows VM needs at least 45 GiB of free host disk space")
    processes = []
    logs = []
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
            # Microsoft's UEFI DVD asks for a key before starting Setup.
            for _ in range(12):
                time.sleep(1)
                if monitor.exists():
                    qmp(monitor, "send-key", {"keys": [{"type": "qcode", "data": "spc"}]})
            session = winrm.Session(f"http://127.0.0.1:{PORT}/wsman", auth=(USERNAME, password), transport="ntlm", message_encryption="always", operation_timeout_sec=15, read_timeout_sec=20)
            deadline = time.monotonic() + 110 * 60
            last_message = None
            heartbeat = 0
            ready = False
            state = None
            while time.monotonic() < deadline:
                if vm.poll() is not None:
                    raise RuntimeError(f"The Windows VM exited early with code {vm.returncode}")
                try:
                    result = session.run_ps("$ErrorActionPreference='Stop'; Get-Content C:\\HexbotVm\\state.json -Raw")
                    if result.status_code == 0:
                        state = json.loads(result.std_out.decode("utf-8-sig"))
                        if not ready:
                            # Setup and bootstrap have copied everything they
                            # need. Remove both DVDs before the standard-user test.
                            qmp(monitor, "eject", {"device": "payload", "force": True})
                            qmp(monitor, "eject", {"device": "installer", "force": True})
                            ready = True
                        message = f"{state['phase']}: {state['message']}"
                        if message != last_message:
                            print(message, flush=True)
                            last_message = message
                        if state["phase"] in ["passed", "failed"]:
                            (evidence / "result.json").write_text(json.dumps(state, indent=2))
                            collect(session, evidence)
                            if state["phase"] != "passed":
                                raise RuntimeError("The Windows 11 x64 guest validation failed; see guest-evidence.zip")
                            return
                except (OSError, ValueError, winrm.exceptions.WinRMError):
                    # Setup and the cumulative update both reboot the guest.
                    pass
                if time.monotonic() >= heartbeat:
                    print("Waiting for Windows Setup, the pinned update, or the containment test", flush=True)
                    heartbeat = time.monotonic() + 45
                time.sleep(10)
            raise RuntimeError("The Windows VM exceeded its 110-minute deadline")
        finally:
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
