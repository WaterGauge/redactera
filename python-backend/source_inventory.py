"""Canonical backend input inventory; keep in sync with scripts/backend-source.cjs."""
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Iterable

_ROOT_EXCLUDED = frozenset({"tests", "build", "dist", "coverage", "htmlcov", "venv", "env",
                            "node_modules", "tmp", "temp", "logs", "coverage.xml"})
_PORTABLE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")
_WINDOWS_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])", re.IGNORECASE)


def _excluded(name: str, at_root: bool) -> bool:
    folded = name.lower()
    return (name.startswith(".") or folded == "__pycache__" or folded.endswith((".pyc", ".pyo"))
            or (at_root and folded in _ROOT_EXCLUDED))


def _regular_info(path: Path) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
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


def verify_runtime_sources(root: Path, analyzed_sources: Iterable[str]) -> None:
    """Every runtime module must appear in PyInstaller's actual Analysis TOCs."""
    analyzed = {Path(source).resolve() for source in analyzed_sources}
    # The native build entry is build-only; any future build-only modules need an explicit exception.
    expected = [name for name in python_sources(root) if name != "python-backend/build_backend.py"]
    missing = [name for name in expected if (root / name).resolve() not in analyzed]
    if missing:
        raise RuntimeError("Backend modules missing from PyInstaller Analysis: " + ", ".join(missing))


def check_types(root: Path) -> int:
    sources = python_sources(root)
    if not sources:
        raise RuntimeError("No backend Python sources found")
    return subprocess.call([sys.executable, "-m", "mypy", "--config-file", "mypy.ini",
                            "--explicit-package-bases",
                            *[name.removeprefix("python-backend/") for name in sources]],
                           cwd=root / "python-backend")


if __name__ == "__main__":
    if sys.argv[1:] != ["--check-types"]:
        raise SystemExit("Usage: python source_inventory.py --check-types")
    raise SystemExit(check_types(Path(__file__).absolute().parent.parent))
