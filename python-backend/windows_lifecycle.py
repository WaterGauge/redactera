"""Windows process incarnation and kernel-enforced worker-tree ownership.

Only managed workers create jobs. The probe opens query-only handles; it never
terminates a PID, changes a job or touches document/session files.
"""
import ctypes as c
import hashlib
import os
import re
import sys
from typing import Any

_JOB_HANDLE: Any = None
_JOB_NAME: str | None = None
_JOB_PREFIX = "Global" + chr(92) + "PDFDesensitization-"
_JOB_PATTERN = re.compile(re.escape(_JOB_PREFIX) + r"[a-f0-9]{64}")


class FileTime(c.Structure):
    _fields_ = [("low", c.c_uint32), ("high", c.c_uint32)]


class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_int64), ("job_time", c.c_int64),
                ("flags", c.c_uint32), ("minimum", c.c_size_t), ("maximum", c.c_size_t),
                ("active_limit", c.c_uint32), ("affinity", c.c_size_t),
                ("priority", c.c_uint32), ("scheduling", c.c_uint32)]


class IoCounters(c.Structure):
    _fields_ = [(name, c.c_uint64) for name in
                ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                ("peak_process_memory", c.c_size_t), ("peak_job_memory", c.c_size_t)]


class Accounting(c.Structure):
    _fields_ = [("user_time", c.c_int64), ("kernel_time", c.c_int64),
                ("period_user", c.c_int64), ("period_kernel", c.c_int64),
                ("faults", c.c_uint32), ("total", c.c_uint32),
                ("active", c.c_uint32), ("terminated", c.c_uint32)]


def _kernel() -> Any:
    if sys.platform != "win32":
        raise RuntimeError("Windows process APIs are unavailable")
    kernel = c.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": (c.c_void_p, [c.c_void_p, c.c_wchar_p]),
        "OpenJobObjectW": (c.c_void_p, [c.c_uint32, c.c_int32, c.c_wchar_p]),
        "SetInformationJobObject": (c.c_int32, [c.c_void_p, c.c_int32, c.c_void_p, c.c_uint32]),
        "QueryInformationJobObject": (c.c_int32, [c.c_void_p, c.c_int32, c.c_void_p, c.c_uint32, c.c_void_p]),
        "AssignProcessToJobObject": (c.c_int32, [c.c_void_p, c.c_void_p]),
        "GetCurrentProcess": (c.c_void_p, []),
        "OpenProcess": (c.c_void_p, [c.c_uint32, c.c_int32, c.c_uint32]),
        "GetProcessTimes": (c.c_int32, [c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p]),
        "WaitForSingleObject": (c.c_uint32, [c.c_void_p, c.c_uint32]),
        "CloseHandle": (c.c_int32, [c.c_void_p]),
    }
    for name, (result, args) in signatures.items():
        api = getattr(kernel, name)
        api.restype = result
        api.argtypes = args
    return kernel


def job_name(session: str, generation: str) -> str:
    digest = hashlib.sha256((session + ":" + generation).encode()).hexdigest()
    return _JOB_PREFIX + digest


def _last_error() -> int:
    if sys.platform != "win32":
        raise RuntimeError("Windows process APIs are unavailable")
    return int(c.get_last_error())


def process_identity(pid: int) -> dict[str, str]:
    kernel = _kernel()
    # Query and wait rights only. Access denied is never interpreted as absent.
    handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle:
        return {"state": "absent" if _last_error() == 87 else "unknown"}
    try:
        if kernel.WaitForSingleObject(handle, 0) == 0:
            return {"state": "absent"}
        created, exited, user, cpu = FileTime(), FileTime(), FileTime(), FileTime()
        if not kernel.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(user), c.byref(cpu)):
            return {"state": "unknown"}
        return {"state": "present", "started": str((created.high << 32) | created.low)}
    finally:
        kernel.CloseHandle(handle)


def job_state(name: str) -> str:
    if not _JOB_PATTERN.fullmatch(name):
        return "unknown"
    kernel = _kernel()
    handle = kernel.OpenJobObjectW(0x4, False, name)  # JOB_OBJECT_QUERY
    if not handle:
        return "empty" if _last_error() == 2 else "unknown"
    try:
        info = Accounting()
        if not kernel.QueryInformationJobObject(handle, 1, c.byref(info), c.sizeof(info), None):
            return "unknown"
        return "empty" if info.active == 0 else "active"
    finally:
        kernel.CloseHandle(handle)


def worker_identity(session: str, generation: str) -> dict[str, str]:
    if sys.platform != "win32":
        return {}
    global _JOB_HANDLE, _JOB_NAME
    name = job_name(session, generation)
    kernel = _kernel()
    if _JOB_HANDLE is None:
        c.set_last_error(0)
        handle = kernel.CreateJobObjectW(None, name)  # Non-inheritable default ACL.
        if not handle:
            raise RuntimeError("Cannot establish managed Windows process tree")
        if _last_error() == 183:
            kernel.CloseHandle(handle)
            raise RuntimeError("Windows process-tree identity is already in use")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway flags.
        if not kernel.SetInformationJobObject(handle, 9, c.byref(limits), c.sizeof(limits)):
            kernel.CloseHandle(handle)
            raise RuntimeError("Cannot protect managed Windows process tree")
        if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
            kernel.CloseHandle(handle)
            raise RuntimeError("Cannot join managed Windows process tree")
        # Never close this explicitly: the OS closes it as this worker exits.
        # In particular it must outlive writing the stopped marker.
        _JOB_HANDLE, _JOB_NAME = handle, name
    if _JOB_NAME != name:
        raise RuntimeError("Windows process-tree identity changed")
    own = process_identity(os.getpid())
    if own["state"] != "present":
        raise RuntimeError("Cannot establish Windows process identity")
    parent = process_identity(os.getppid())
    result = {"windowsJob": name, "processStarted": own["started"]}
    if parent["state"] == "present":
        result["parentStarted"] = parent["started"]
    return result


def snapshot(query: object) -> dict[str, object]:
    if sys.platform != "win32" or not isinstance(query, dict) or set(query) != {"pids", "jobs"}:
        raise ValueError("Invalid process snapshot query")
    pids, jobs = query["pids"], query["jobs"]
    if not isinstance(pids, list) or not isinstance(jobs, list) or len(pids) > 512 or len(jobs) > 256:
        raise ValueError("Invalid process snapshot query")
    if any(type(pid) is not int or not 0 < pid < 2**32 for pid in pids):
        raise ValueError("Invalid process snapshot query")
    if any(not isinstance(name, str) or not _JOB_PATTERN.fullmatch(name) for name in jobs):
        raise ValueError("Invalid process snapshot query")
    return {"processes": {str(pid): process_identity(pid) for pid in pids},
            "jobs": {name: job_state(name) for name in jobs}}
