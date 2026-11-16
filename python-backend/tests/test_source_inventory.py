"""Cross-language source identity and stale-build controls without native build tools."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

import build_info
import source_inventory as inventory

REPO = Path(__file__).resolve().parents[2]


def put(root, name, data=b"synthetic"):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(data)
    return file


def node(root, expression, *, check=True):
    script = "const b = require(process.argv[1]); const r = process.argv[2]; console.log(JSON.stringify(" + expression + "));"
    return subprocess.run(["node", "-e", script, str(REPO / "scripts/backend-contract.cjs"), str(root)],
                          capture_output=True, text=True, check=check, timeout=20)


@pytest.fixture
def source(tmp_path, monkeypatch):
    put(tmp_path, "package.json", b'{"version":"2.0.0"}')
    put(tmp_path, "scripts/release-upstream.json", b'{}')
    entry = put(tmp_path, "python-backend/build_info.py")
    put(tmp_path, "python-backend/main.py")
    monkeypatch.setattr(build_info, "__file__", str(entry))
    return tmp_path


def contracts(root):
    python = build_info.source_contract()
    js = json.loads(node(root, "[b.contract(r), b.applicationSource(r)]").stdout)
    assert python == js[0]
    return python, js[1]


def test_recursive_bytes_add_edit_delete_and_order(source):
    original, app = contracts(source)
    files = ["python-backend/z_pkg/nested/provider.py", "python-backend/A_pkg/__init__.py",
             "python-backend/z_pkg/config.json", "python-backend/z_pkg/resources/model.bin",
             "python-backend/z_pkg/nested/settings.ini", "python-backend/z_pkg/nested/NOTICE.txt"]
    for name in reversed(files):
        put(source, name)
    added, added_app = contracts(source)
    assert added != original and added_app["sha256"] != app["sha256"]
    assert set(files).issubset(added_app["files"])
    expected = {name: hashlib.sha256((source / name).read_bytes()).hexdigest()
                for name in sorted(files + ["python-backend/build_info.py", "python-backend/main.py"])}
    expected["scripts/release-upstream.json"] = hashlib.sha256(b"{}").hexdigest()
    assert added["sourceSha256"] == hashlib.sha256(json.dumps(expected, separators=(",", ":")).encode()).hexdigest()
    for name in files:
        put(source, name, b"changed")
        changed, changed_app = contracts(source)
        assert changed != added and changed_app["sha256"] != added_app["sha256"]
        put(source, name)
        assert contracts(source) == (added, added_app)
    for name in files:
        (source / name).unlink()
    assert contracts(source) == (original, app)
    for name in files:
        put(source, name)
    assert contracts(source) == (added, added_app)


def test_exclusions_do_not_change_either_identity(source):
    put(source, "python-backend/ocr/module.py")
    before = contracts(source)
    for name in ["tests/test_module.py", "dist/output.txt", "build/nested/output.py", "venv/lib/a.py",
                 "coverage.xml", "htmlcov/report.txt", "tmp/private.json", "logs/trace.txt",
                 "ocr/.__hidden.py", "ocr/__pycache__/module.pyc", "ocr/.cache/private.bin", "ocr/module.pyo"]:
        put(source, "python-backend/" + name)
    assert contracts(source) == before
    # Root-only exclusions must not swallow a legitimate nested package.
    put(source, "python-backend/ocr/build/module.py")
    assert contracts(source) != before


@pytest.mark.parametrize("change", ["add", "edit", "delete", "resource"])
def test_packaging_rejects_stale_frozen_manifest(source, change):
    module = put(source, "python-backend/ocr/provider.py")
    resource = put(source, "python-backend/ocr/model.bin")
    original, _ = contracts(source)
    dist = source / "python-backend/dist"
    binary = put(source, "python-backend/dist/python_backend.exe")
    notices = put(source, "python-backend/dist/python-licenses.zip")
    manifest = {"contract": original, "platform": "win32", "arch": "x64", "executable": binary.name,
                "executableSha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "pythonLicensesSha256": hashlib.sha256(notices.read_bytes()).hexdigest()}
    (dist / "backend-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    node(source, "b.verify(r, 'win32', 'x64')")
    if change == "add":
        put(source, "python-backend/ocr/other.py")
    elif change == "edit":
        module.write_bytes(b"changed")
    elif change == "delete":
        module.unlink()
    else:
        resource.write_bytes(b"changed")
    failed = node(source, "b.preparePackageBackend(r, 'win32', 'x64')", check=False)
    assert failed.returncode != 0 and "stale" in failed.stderr
    assert not (source / ".project-state").exists()


def test_linked_source_is_rejected(source):
    target = put(source, "outside.py")
    link = source / "python-backend/link.py"
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"Symbolic link creation unavailable: {exc}")
    with pytest.raises(RuntimeError, match="Linked backend source"):
        build_info.source_contract()
    failed = node(source, "b.contract(r)", check=False)
    assert failed.returncode != 0 and "Linked backend source" in failed.stderr


def test_nonportable_name_is_rejected(source):
    put(source, "python-backend/with space.py")
    with pytest.raises(RuntimeError, match="Non-portable"):
        build_info.source_contract()
    failed = node(source, "b.contract(r)", check=False)
    assert failed.returncode != 0 and "Non-portable" in failed.stderr


def test_case_collision_is_rejected_when_filesystem_allows_it(source):
    first = put(source, "python-backend/Module.py")
    second = first.with_name("module.py")
    if second.exists():
        pytest.skip("Case-insensitive filesystem")
    second.write_bytes(b"different")
    with pytest.raises(RuntimeError, match="Case-colliding"):
        build_info.source_contract()
    failed = node(source, "b.contract(r)", check=False)
    assert failed.returncode != 0 and "Case-colliding" in failed.stderr


def test_typecheck_and_analysis_discover_nested_modules(source, monkeypatch):
    nested = put(source, "python-backend/ocr/provider.py")
    put(source, "python-backend/build_backend.py")
    put(source, "python-backend/tests/test_ocr.py")
    expected = ["build_backend.py", "build_info.py", "main.py", "ocr/provider.py"]
    calls = []
    monkeypatch.setattr(inventory.subprocess, "call", lambda args, **kwargs: calls.append((args, kwargs)) or 7)
    assert inventory.check_types(source) == 7
    assert calls == [([sys.executable, "-m", "mypy", "--config-file", "mypy.ini", "--explicit-package-bases", *expected],
                      {"cwd": source / "python-backend"})]
    analyzed = [str(source / "python-backend" / name) for name in ("main.py", "build_info.py")]
    with pytest.raises(RuntimeError, match="ocr/provider.py"):
        inventory.verify_runtime_sources(source, analyzed)
    inventory.verify_runtime_sources(source, [*analyzed, str(nested)])


def test_analysis_rejects_excluded_project_code_but_allows_selected_environment(source, monkeypatch):
    excluded = put(source, "python-backend/tests/helpers.py")
    build_only = put(source, "python-backend/build_backend.py")
    dependency = put(source, "python-backend/venv/lib/site-packages/dependency.py")
    other = put(source, "python-backend/env/lib/site-packages/unselected.py")
    monkeypatch.setattr(inventory.sys, "prefix", str(source / "python-backend/venv"))
    analyzed = [str(source / "python-backend" / name) for name in ("main.py", "build_info.py")]
    inventory.verify_runtime_sources(source, [*analyzed, str(dependency)])
    for unexpected in (excluded, build_only, other):
        with pytest.raises(RuntimeError, match="Unlisted backend modules"):
            inventory.verify_runtime_sources(source, [*analyzed, str(unexpected)])
