"""Inspect a real PSEC child using only disposable host fixture identifiers.

The trusted host owns the process, registry canary, and optional named pipe.
This child never writes registry values, reads process memory, or sends pipe data.
Pass one JSON argument. A successful run prints one JSON object with the marker
HEXBOT_PSEC_TOKEN_OK. Host controls must establish that each target exists and is
accessible outside the sandbox before invoking this payload.
"""

import ctypes
import json
import os
import re
import sys
import uuid


DWORD = ctypes.c_uint32
LONG = ctypes.c_int32
HANDLE = ctypes.c_void_p
BOOL = ctypes.c_int32


class LUID(ctypes.Structure):
    _fields_ = [("LowPart", DWORD), ("HighPart", LONG)]


class LUID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Luid", LUID), ("Attributes", DWORD)]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", DWORD)]


class TOKEN_GROUPS(ctypes.Structure):
    _fields_ = [("GroupCount", DWORD), ("Groups", SID_AND_ATTRIBUTES * 1)]


DANGEROUS_PRIVILEGES = {
    "SeAssignPrimaryTokenPrivilege",
    "SeBackupPrivilege",
    "SeCreateTokenPrivilege",
    "SeDebugPrivilege",
    "SeEnableDelegationPrivilege",
    "SeImpersonatePrivilege",
    "SeIncreaseQuotaPrivilege",
    "SeLoadDriverPrivilege",
    "SeManageVolumePrivilege",
    "SeRelabelPrivilege",
    "SeRestorePrivilege",
    "SeSecurityPrivilege",
    "SeSystemEnvironmentPrivilege",
    "SeTakeOwnershipPrivilege",
    "SeTcbPrivilege",
    "SeTrustedCredManAccessPrivilege",
}


def fixture_spec(argument):
    spec = json.loads(argument)
    if not isinstance(spec, dict):
        raise ValueError("Fixture input must be a JSON object")
    allowed = {"hostPid", "hostRegistryKey", "hostRegistryValue", "pipeName"}
    if set(spec) - allowed:
        raise ValueError("Unknown fixture input field")
    pid = spec.get("hostPid")
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF or pid == os.getpid():
        raise ValueError("hostPid must identify a live test-owned host process")
    key = spec.get("hostRegistryKey", "")
    match = re.fullmatch(r"Software\\HexbotTests\\([0-9a-fA-F-]{36})", key)
    if not match or str(uuid.UUID(match[1])) != match[1].lower():
        raise ValueError("Registry canary must be Software\\HexbotTests\\<UUID>")
    if spec.get("hostRegistryValue") != "secret":
        raise ValueError("The test-owned registry value must be named secret")
    pipe = spec.get("pipeName")
    if pipe is not None:
        match = re.fullmatch(r"\\\\\.\\pipe\\HexbotPsec-([0-9a-fA-F-]{36})", pipe)
        if not match or str(uuid.UUID(match[1])) != match[1].lower():
            raise ValueError("Named pipe must be \\\\.\\pipe\\HexbotPsec-<UUID>")
    return spec


def inspect(spec, report):
    import winreg

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = HANDLE
    kernel.CloseHandle.argtypes = [HANDLE]
    kernel.CloseHandle.restype = BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [DWORD, BOOL, DWORD]
    kernel.OpenProcess.restype = HANDLE
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, DWORD, DWORD, ctypes.c_void_p, DWORD, DWORD, HANDLE]
    kernel.CreateFileW.restype = HANDLE
    security.OpenProcessToken.argtypes = [HANDLE, DWORD, ctypes.POINTER(HANDLE)]
    security.OpenProcessToken.restype = BOOL
    security.GetTokenInformation.argtypes = [HANDLE, DWORD, ctypes.c_void_p, DWORD, ctypes.POINTER(DWORD)]
    security.GetTokenInformation.restype = BOOL
    security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    security.ConvertSidToStringSidW.restype = BOOL
    security.LookupPrivilegeNameW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(LUID), ctypes.c_wchar_p, ctypes.POINTER(DWORD)]
    security.LookupPrivilegeNameW.restype = BOOL
    errors = report["errors"]

    def check(condition, message):
        if not condition:
            errors.append(message)

    def sid_string(sid):
        if not sid:
            return None
        text = ctypes.c_wchar_p()
        if not security.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    token = HANDLE()
    if not security.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        def token_info(kind):
            length = DWORD()
            ctypes.set_last_error(0)
            security.GetTokenInformation(token, kind, None, 0, ctypes.byref(length))
            if ctypes.get_last_error() != 122 or not length.value:
                raise ctypes.WinError(ctypes.get_last_error())
            buffer = ctypes.create_string_buffer(length.value)
            if not security.GetTokenInformation(token, kind, buffer, length, ctypes.byref(length)):
                raise ctypes.WinError(ctypes.get_last_error())
            return buffer

        def token_dword(kind):
            return DWORD.from_buffer(token_info(kind)).value

        app_sid_buffer = token_info(31)
        app_sid = sid_string(HANDLE.from_buffer(app_sid_buffer).value)
        integrity_buffer = token_info(25)
        integrity_sid = sid_string(SID_AND_ATTRIBUTES.from_buffer(integrity_buffer).Sid)
        integrity_rid = int(integrity_sid.rsplit("-", 1)[1]) if integrity_sid else None
        privileges_buffer = token_info(3)
        privilege_count = DWORD.from_buffer(privileges_buffer).value
        privilege_size = ctypes.sizeof(LUID_AND_ATTRIBUTES)
        if 4 + privilege_count * privilege_size > len(privileges_buffer):
            raise ValueError("Windows returned a truncated privilege list")
        privileges = []
        for index in range(privilege_count):
            item = LUID_AND_ATTRIBUTES.from_buffer(privileges_buffer, 4 + index * privilege_size)
            length = DWORD()
            ctypes.set_last_error(0)
            security.LookupPrivilegeNameW(None, ctypes.byref(item.Luid), None, ctypes.byref(length))
            if ctypes.get_last_error() != 122:
                raise ctypes.WinError(ctypes.get_last_error())
            name = ctypes.create_unicode_buffer(length.value + 1)
            length.value = len(name)
            if not security.LookupPrivilegeNameW(None, ctypes.byref(item.Luid), name, ctypes.byref(length)):
                raise ctypes.WinError(ctypes.get_last_error())
            privileges.append({"name": name.value, "attributes": item.Attributes})
        capabilities_buffer = token_info(30)
        capability_count = DWORD.from_buffer(capabilities_buffer).value
        capability_size = ctypes.sizeof(SID_AND_ATTRIBUTES)
        capability_offset = TOKEN_GROUPS.Groups.offset
        if capability_count and capability_offset + capability_count * capability_size > len(capabilities_buffer):
            raise ValueError("Windows returned a truncated capability list")
        capabilities = []
        for index in range(capability_count):
            item = SID_AND_ATTRIBUTES.from_buffer(capabilities_buffer, capability_offset + index * capability_size)
            capabilities.append({"sid": sid_string(item.Sid), "attributes": item.Attributes})
        dangerous = sorted(item["name"] for item in privileges if item["name"] in DANGEROUS_PRIVILEGES)
        facts = {
            "isAppContainer": bool(token_dword(29)),
            "appContainerSid": app_sid,
            "integritySid": integrity_sid,
            "integrityRid": integrity_rid,
            "elevated": bool(token_dword(20)),
            "uiAccess": bool(token_dword(26)),
            "privileges": privileges,
            "dangerousPrivileges": dangerous,
            "capabilities": capabilities,
        }
        report["token"] = facts
        check(facts["isAppContainer"], "The child token is not an AppContainer")
        check(bool(app_sid and app_sid.startswith("S-1-15-2-")), "The child has no AppContainer SID")
        check(bool(integrity_sid and integrity_sid.startswith("S-1-16-") and integrity_rid <= 0x1000), "The child integrity level exceeds Low")
        check(not facts["elevated"], "The child token is elevated")
        check(not facts["uiAccess"], "The child token has UIAccess")
        check(not dangerous, "Dangerous privileges are present, including disabled entries: " + ", ".join(dangerous))
    finally:
        kernel.CloseHandle(token)

    process_access = []
    for name, mask in [("createThread", 0x0002), ("vmOperation", 0x0008), ("vmRead", 0x0010), ("vmWrite", 0x0020), ("duplicateHandle", 0x0040)]:
        ctypes.set_last_error(0)
        handle = kernel.OpenProcess(mask, False, spec["hostPid"])
        error = 0 if handle else ctypes.get_last_error()
        if handle:
            kernel.CloseHandle(handle)
        process_access.append({"access": name, "mask": mask, "opened": bool(handle), "winerror": error})
        check(not handle and error == 5, "Host process access was not denied: " + name)
    report["process"] = {"hostPid": spec["hostPid"], "attempts": process_access}

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, spec["hostRegistryKey"], 0, winreg.KEY_QUERY_VALUE) as key:
            winreg.QueryValueEx(key, spec["hostRegistryValue"])
        registry_read = {"readable": True, "winerror": 0}
    except OSError as error:
        registry_read = {"readable": False, "winerror": error.winerror}
    check(not registry_read["readable"] and registry_read["winerror"] in (2, 3, 5), "The child could read the host registry canary, or the test failed unexpectedly")
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE):
            pass
        autostart = {"openedForWrite": True, "winerror": 0}
    except OSError as error:
        autostart = {"openedForWrite": False, "winerror": error.winerror}
    check(not autostart["openedForWrite"] and autostart["winerror"] in (2, 3, 5), "The child could open HKCU Run for writing, or the test failed unexpectedly")
    report["registry"] = {"canaryRead": registry_read, "autostartWriteOpen": autostart, "writesAttempted": False}

    pipe = spec.get("pipeName")
    if pipe is None:
        report["pipe"] = {"skipped": True, "reason": "No host pipe fixture was supplied"}
    else:
        attempts = []
        for name, mask in [("read", 0x80000000), ("readWrite", 0xC0000000)]:
            ctypes.set_last_error(0)
            # Anonymous security QoS prevents this canary server impersonating us.
            handle = kernel.CreateFileW(pipe, mask, 0, None, 3, 0x00100000, None)
            opened = handle not in (None, ctypes.c_void_p(-1).value)
            error = 0 if opened else ctypes.get_last_error()
            if opened:
                kernel.CloseHandle(handle)
            attempts.append({"access": name, "opened": opened, "winerror": error})
            check(not opened and error in (2, 3, 5), "Host named-pipe access was not isolated: " + name)
        report["pipe"] = {"skipped": False, "attempts": attempts}


def main():
    report = {"ok": False, "errors": []}
    try:
        if os.name != "nt":
            raise ValueError("Run this payload on a real Windows VM")
        if len(sys.argv) != 2:
            raise ValueError("Pass exactly one JSON fixture specification")
        inspect(fixture_spec(sys.argv[1]), report)
        report["ok"] = not report["errors"]
    except Exception as error:
        report["errors"].append(f"{type(error).__name__}: {error}")
    if report["ok"]:
        report["marker"] = "HEXBOT_PSEC_TOKEN_OK"
    print(json.dumps(report, separators=(",", ":")), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
