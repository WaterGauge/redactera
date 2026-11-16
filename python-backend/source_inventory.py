"""Canonical backend input inventory; keep in sync with scripts/backend-source.cjs."""
import ctypes
import importlib.metadata
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import sysconfig
from typing import Iterable

_ROOT_EXCLUDED = frozenset({"tests", "build", "dist", "coverage", "htmlcov", "venv", "env",
                            "node_modules", "tmp", "temp", "logs", "coverage.xml"})
_PORTABLE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")
_WINDOWS_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])", re.IGNORECASE)

# FILE_ATTRIBUTE_REPARSE_POINT (Win32); the stat type stub exposes it only on Windows.
_WINDOWS_REPARSE_POINT = 0x400


def _excluded(name: str, at_root: bool) -> bool:
    folded = name.lower()
    return (name.startswith(".") or folded == "__pycache__" or folded.endswith((".pyc", ".pyo"))
            or (at_root and folded in _ROOT_EXCLUDED))


def _regular_info(path: Path) -> os.stat_result:
    info = path.lstat()
    attributes = getattr(info, "st_file_attributes", 0)
    if sys.platform == "win32":
        # lstat may follow non-name-surrogate reparse points. Query the entry itself.
        get_attributes = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True).GetFileAttributesW
        get_attributes.argtypes = [ctypes.c_wchar_p]
        get_attributes.restype = ctypes.c_uint32
        attributes = get_attributes(str(path.absolute()))
        if attributes == 0xFFFFFFFF:
            raise OSError("Unable to inspect Windows backend source attributes")
    if stat.S_ISLNK(info.st_mode) or attributes & _WINDOWS_REPARSE_POINT:
        raise RuntimeError("Linked backend source is not supported")
    return info


def backend_files(root: Path) -> list[str]:
    """Return sorted, slash-separated repository-relative names of regular inputs."""
    base = root / "python-backend"
    if not stat.S_ISDIR(_regular_info(base).st_mode):
        raise RuntimeError("Backend source root is not a directory")
    files: list[str] = []
    seen: set[str] = set()

    def visit(directory: Path) -> None:
        for item in directory.iterdir():
            if _excluded(item.name, directory == base):
                continue
            name = item.relative_to(root).as_posix()
            if (not _PORTABLE_NAME.fullmatch(item.name) or item.name.endswith(".")
                    or _WINDOWS_DEVICE.fullmatch(item.name.split(".", 1)[0])):
                raise RuntimeError("Non-portable backend source name: " + name)
            if name.lower() in seen:
                raise RuntimeError("Case-colliding backend source name: " + name)
            seen.add(name.lower())
            info = _regular_info(item)
            if stat.S_ISDIR(info.st_mode):
                visit(item)
            elif stat.S_ISREG(info.st_mode):
                files.append(name)
            else:
                raise RuntimeError("Non-regular backend source entry: " + name)

    visit(base)
    return sorted(files)


def python_sources(root: Path) -> list[str]:
    return [name for name in backend_files(root) if name.endswith(".py")]


def _library_roots() -> tuple[set[Path], set[Path]]:
    base_vars = {"base": sys.base_prefix, "platbase": sys.base_exec_prefix}
    standard = {Path(sysconfig.get_path(name, vars=base_vars)).resolve()
                for name in ("stdlib", "platstdlib")}
    installed = {Path(sysconfig.get_path(name)).resolve() for name in ("purelib", "platlib")}
    excluded = installed | {Path(sysconfig.get_path(name, vars=base_vars)).resolve()
                            for name in ("purelib", "platlib")}
    return standard, excluded


def _installed_sources() -> set[Path]:
    """Only files recorded by distributions in the selected interpreter's library dirs."""
    libraries = {Path(sysconfig.get_path(name)).resolve() for name in ("purelib", "platlib")}
    sources: set[Path] = set()
    for distribution in importlib.metadata.distributions(path=[str(p) for p in libraries]):
        for file in distribution.files or ():
            if file.suffix not in (".py", ".pyw") or ".." in file.parts:
                continue
            origin = Path(str(distribution.locate_file(file))).absolute()
            # An installed RECORD may mention scripts outside site-packages; they
            # are not an implicit source exception for Analysis.
            if any(origin.is_relative_to(library) for library in libraries):
                sources.add(origin)
    return sources


def _unlinked_under(path: Path, base: Path) -> bool:
    if not path.is_relative_to(base):
        return False
    current = base
    for part in path.relative_to(base).parts:
        current = current / part
        _regular_info(current)
    return path.resolve() == path and stat.S_ISREG(_regular_info(path).st_mode)


def verify_runtime_sources(root: Path, analyzed_sources: Iterable[str]) -> None:
    """Check actual TOC origins before path resolution can hide excluded inputs."""
    root = root.resolve()
    expected = {root / name for name in python_sources(root) if name != "python-backend/build_backend.py"}
    standard, excluded = _library_roots()
    dependencies = _installed_sources()
    analyzed: set[Path] = set()
    unexpected: list[str] = []
    for source in analyzed_sources:
        origin = Path(source)
        if not origin.is_absolute() or ".." in origin.parts:
            unexpected.append(source)
            continue
        if origin in expected:
            analyzed.add(origin)
            continue
        # The only exception inside the project is a selected, recorded library
        # file. A whole venv prefix is not a source allowlist.
        if origin in dependencies and any(_unlinked_under(origin, library) for library in excluded):
            continue
        if not any(origin.is_relative_to(library) for library in excluded):
            if any(_unlinked_under(origin, library) for library in standard):
                continue
        unexpected.append(source)
    if unexpected:
        raise RuntimeError("Unlisted backend modules in PyInstaller Analysis: " + ", ".join(sorted(unexpected)))
    missing = sorted(path.relative_to(root).as_posix() for path in expected - analyzed)
    if missing:
        raise RuntimeError("Backend modules missing from PyInstaller Analysis: " + ", ".join(missing))

def verify_analysis_toc(root: Path, entries: Iterable[tuple[str, str, str]]) -> None:
    """PyInstaller uses '-' only for source-less namespace package PYMODULEs."""
    rows = list(entries)
    physical = [(name, source) for name, source, _ in rows
                if isinstance(source, str) and source and source != "-"]
    names = {name for name, _ in physical}
    for name, source, kind in rows:
        if not isinstance(source, str) or not source:
            raise RuntimeError("Missing PyInstaller Analysis source: " + name)
        if source == "-" and (kind != "PYMODULE" or not all(part.isidentifier() for part in name.split("."))
                              or not any(child.startswith(name + ".") for child in names)):
            raise RuntimeError("Invalid source-less PyInstaller Analysis entry: " + name)
    verify_runtime_sources(root, (source for _, source in physical))



def check_types(root: Path) -> int:
    sources = python_sources(root)
    if not sources:
        raise RuntimeError("No backend Python sources found")
    return subprocess.call([sys.executable, "-m", "mypy", "--config-file", "mypy.ini",
                            "--explicit-package-bases",
                            *[name.removeprefix("python-backend/") for name in sources]],
                           cwd=root / "python-backend")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inventory":
        print(json.dumps(backend_files(Path(sys.argv[2]).absolute())))
        raise SystemExit(0)
    if sys.argv[1:] != ["--check-types"]:
        raise SystemExit("Usage: python source_inventory.py --check-types | --inventory ROOT")
    raise SystemExit(check_types(Path(__file__).absolute().parent.parent))
