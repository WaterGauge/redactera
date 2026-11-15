"""Read-only WSL preflight. Uses existing native .exe tools, never PowerShell."""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys


def native_probe(name, setting, program, prefix=()):
    executable = os.environ.get(setting) or shutil.which(name)
    if not executable:
        return {"available": False, "reason": "missing executable"}
    if re.match(r"^[A-Za-z]:\\", executable):
        executable = subprocess.check_output(["wslpath", "-u", executable], text=True).strip()
    if "windowsapps" in executable.lower():
        return {"available": False, "reason": "verify the actual interpreter path instead of an App Execution Alias"}
    environment = dict(os.environ)
    environment.pop("PYLAUNCHER_ALLOW_INSTALL", None)
    try:
        result = subprocess.run([executable, *prefix, "-e" if name == "node.exe" else "-c", program],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", env=environment, timeout=15)
        if result.returncode:
            return {"available": False, "exitCode": result.returncode, "reason": "native probe failed"}
        return {"available": True, **json.loads(result.stdout)}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {"available": False, "reason": type(error).__name__}


def main():
    if sys.platform != "linux" or not (os.environ.get("WSL_DISTRO_NAME") or "microsoft" in platform.release().lower()):
        print(json.dumps({"scope": "environment-only", "ready": False, "reason": "Run this script in the Windows Codex WSL terminal"}))
        return 2
    report = {"scope": "environment-only", "distro": os.environ.get("WSL_DISTRO_NAME"), "kernel": platform.release(),
              "linuxDirectory": str(Path.cwd()), "guiSessionVerified": False}
    try:
        report["windowsDirectory"] = subprocess.check_output(["wslpath", "-w", str(Path.cwd())], text=True, timeout=10).strip()
    except (OSError, subprocess.SubprocessError):
        report["windowsDirectory"] = None
    report["node"] = native_probe("node.exe", "PDF_WINDOWS_NODE",
        'console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,executable:process.execPath,cwd:process.cwd(),windowsRelease:require("node:os").release()}))')
    python_code = ('import json,sys,struct,platform,ctypes,os; sid=ctypes.c_ulong(); '
                   'ok=ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(),ctypes.byref(sid)); '
                   'print(json.dumps({"platform":sys.platform,"bits":struct.calcsize("P")*8,"version":platform.python_version(),'
                   '"executable":sys.executable,"sessionId":sid.value if ok else None}))')
    report["python"] = native_probe("python.exe", "PDF_WINDOWS_PYTHON", python_code)
    node, python = report["node"], report["python"]
    report["ready"] = bool(node.get("platform") == "win32" and node.get("arch") == "x64" and
                           node.get("version", "").startswith("v24.") and python.get("platform") == "win32" and
                           python.get("bits") == 64 and python.get("version", "").startswith("3.11.") and
                           re.match(r"^[A-Za-z]:\\", report["windowsDirectory"] or ""))
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
