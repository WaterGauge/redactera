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
    library = dependency.parent
    put(source, "python-backend/venv/lib/site-packages/probe-1.0.dist-info/METADATA", b"Name: probe\nVersion: 1.0\n")
    put(source, "python-backend/venv/lib/site-packages/probe-1.0.dist-info/RECORD", b"dependency.py,,\n")
    original = inventory.sysconfig.get_path
    monkeypatch.setattr(inventory.sysconfig, "get_path", lambda name, **kwargs:
                        str(library) if name in ("purelib", "platlib") and not kwargs else original(name, **kwargs))
    analyzed = [str(source / "python-backend" / name) for name in ("main.py", "build_info.py")]
    inventory.verify_runtime_sources(source, [*analyzed, str(dependency)])
    unrecorded = put(source, "python-backend/venv/lib/site-packages/unrecorded.py")
    for unexpected in (excluded, build_only, other, unrecorded):
        with pytest.raises(RuntimeError, match="Unlisted backend modules"):
            inventory.verify_runtime_sources(source, [*analyzed, str(unexpected)])


def test_windows_reparse_attribute_rejected_on_all_hosts(tmp_path, monkeypatch):
    from types import SimpleNamespace

    target = tmp_path / "linked.py"
    original = Path.lstat
    monkeypatch.setattr(Path, "lstat", lambda self, *args, **kwargs: SimpleNamespace(
        st_mode=0o100644, st_file_attributes=0x400) if self == target else original(self, *args, **kwargs))
    with pytest.raises(RuntimeError, match="Linked backend source"):
        inventory._regular_info(target)


def test_analysis_rejects_lexical_escape_and_resolved_unknown_source(source, tmp_path):
    import tempfile
    analyzed = [str(source / "python-backend" / name) for name in ("main.py", "build_info.py")]
    with tempfile.TemporaryDirectory() as outside:
        unknown = Path(outside) / "private.py"
        unknown.write_text("# synthetic")
        with pytest.raises(RuntimeError, match="Unlisted backend modules"):
            inventory.verify_runtime_sources(source, [*analyzed, str(unknown)])
        link = source / "python-backend/tests"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            pytest.skip(f"Symbolic link creation unavailable: {exc}")
        with pytest.raises(RuntimeError, match="Unlisted backend modules"):
            inventory.verify_runtime_sources(source, [*analyzed, str(link / "private.py")])


def test_real_installed_library_and_standard_library(source):
    import json as standard
    import requests
    analyzed = [str(source / "python-backend" / name) for name in ("main.py", "build_info.py")]
    inventory.verify_runtime_sources(source, [*analyzed, str(Path(standard.__file__).resolve()),
                                              str(Path(requests.__file__).resolve())])


def test_release_correspondence(source, monkeypatch, tmp_path):
    import tarfile
    root = source.resolve()
    monkeypatch.delenv("PDF_REQUIRE_RELEASE_RUNTIME", raising=False)
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)
    git("init", "-q")
    git("config", "user.name", "Synthetic Test")
    git("config", "user.email", "synthetic@example.invalid")
    git("config", "core.autocrlf", "false")
    put(root, ".gitignore", b"*.log\n*.spec\n")
    resource = put(root, "python-backend/ocr/model.bin", b"synthetic")
    git("add", ".")
    git("commit", "-qm", "synthetic")
    commit = git("rev-parse", "HEAD").decode().strip()
    expression = "b.applicationSource(r, '" + commit + "')"
    good = json.loads(node(root, expression).stdout)
    for name in ("ocr/untracked.py", "ocr/ignored.log", "ocr/ignored.spec", "ocr/extra.bin"):
        file = put(root, "python-backend/" + name)
        failed = node(root, expression, check=False)
        assert failed.returncode and "Untracked release input" in failed.stderr
        file.unlink()
    for action in ("edit", "delete", "rename"):
        moved = resource.with_name("renamed.bin")
        if action == "edit": resource.write_bytes(b"changed")
        elif action == "delete": resource.unlink()
        else: resource.rename(moved)
        assert node(root, expression, check=False).returncode
        if moved.exists(): moved.unlink()
        resource.write_bytes(b"synthetic")
    assert json.loads(node(root, expression).stdout) == good
    export = tmp_path / "export"
    export.mkdir()
    import io
    with tarfile.open(fileobj=io.BytesIO(git("archive", "--format=tar", commit))) as archive:
        for member in archive:
            if member.isfile():
                put(export, member.name, archive.extractfile(member).read())
    assert json.loads(node(export, "b.applicationSource(r)").stdout) == good
    assert node(export, expression, check=False).returncode
    put(root, ".gitattributes", b"python-backend/ocr export-ignore\n")
    git("add", ".gitattributes")
    git("commit", "-qm", "synthetic export omission")
    assert "Release archive omits tracked files" in node(root, "b.applicationSource(r, 'HEAD')", check=False).stderr


def test_analysis_namespace_sentinel_only_with_real_child(source):
    child = put(source, "python-backend/ocr/provider.py")
    rows = [(name, str(source / "python-backend" / (name + ".py")), "PYMODULE") for name in ("main", "build_info")]
    rows.append(("ocr.provider", str(child), "PYMODULE"))
    inventory.verify_analysis_toc(source, [*rows, ("ocr", "-", "PYMODULE")])
    for invalid in (("ocr", "-", "PYSOURCE"), ("unknown", "-", "PYMODULE"), ("ocr", "", "PYMODULE")):
        with pytest.raises(RuntimeError):
            inventory.verify_analysis_toc(source, [*rows, invalid])
