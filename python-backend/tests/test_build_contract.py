import json
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
import build_info
import build_backend


def test_runtime_reports_openssl_patch_from_runtime_version(monkeypatch):
    monkeypatch.setattr(build_info.ssl, "OPENSSL_VERSION", "OpenSSL 3.5.9 29 Sep 2026")
    monkeypatch.setattr(build_info.ssl, "OPENSSL_VERSION_INFO", (3, 5, 0, 9, 0))
    assert build_info.runtime_versions()["openssl"] == "3.5.9"


def test_source_identity_includes_backend_bytes_engine_source_lock_and_app_version(tmp_path, monkeypatch):
    directory = tmp_path / "python-backend"
    directory.mkdir()
    source = directory / "build_info.py"
    source.write_text("original")
    package = tmp_path / "package.json"
    package.write_text(json.dumps({"version": "1.0.0"}))
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    upstream = scripts / "release-upstream.json"
    upstream.write_text('{"mupdfVersion":"1.28.0"}')
    monkeypatch.setattr(build_info, "__file__", str(source))
    original = build_info.source_contract()
    (directory / "._build_info.py").write_bytes(b"archive metadata")
    assert build_info.source_contract() == original
    source.write_text("changed")
    updated = build_info.source_contract()
    assert updated["sourceSha256"] != original["sourceSha256"]
    upstream.write_text('{"mupdfVersion":"1.28.2"}')
    assert build_info.source_contract()["sourceSha256"] != updated["sourceSha256"]
    package.write_text(json.dumps({"version": "2.0.0"}))
    assert build_info.source_contract()["appVersion"] == "2.0.0"


def test_frozen_identity_requires_embedded_build_data(tmp_path, monkeypatch):
    monkeypatch.setattr(build_info.sys, "frozen", True, raising=False)
    monkeypatch.setattr(build_info.sys, "_MEIPASS", str(tmp_path), raising=False)
    with pytest.raises(FileNotFoundError):
        build_info.backend_contract()
    (tmp_path / "backend-build.json").write_text(json.dumps({"contract": {"protocol": 0}}))
    with pytest.raises(RuntimeError, match="identity"):
        build_info.backend_contract()


@pytest.mark.parametrize("missing", ["eng", "chi_sim", "chi_tra"])
def test_missing_language_fails_before_pyinstaller(tmp_path, monkeypatch, missing):
    executable = tmp_path / "tesseract"
    executable.write_text("synthetic executable")
    data = tmp_path / "data"
    data.mkdir()
    for language in build_backend.LANGUAGES:
        if language != missing:
            (data / (language + ".traineddata")).write_bytes(b"x" * 1001)
    monkeypatch.setenv("PDF_TESSERACT_PATH", str(executable))
    monkeypatch.setenv("PDF_TESSDATA_DIR", str(data))
    monkeypatch.setattr(build_backend.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout='List of available languages in "' + str(data) + '":\neng\n'))
    with pytest.raises(RuntimeError, match="missing"):
        build_backend.ocr_resources()


def test_windows_ocr_binary_closure_keeps_delay_imports_and_forwarders(tmp_path, monkeypatch):
    for name in ("tesseract.exe", "direct.dll", "delay.dll", "forwarded.dll", "unused.dll"):
        (tmp_path / name).touch()

    class Image:
        def __init__(self, filename, *, fast_load):
            assert fast_load
            name = Path(filename).name
            self.DIRECTORY_ENTRY_IMPORT = (
                [SimpleNamespace(dll=b"Direct.DLL"), SimpleNamespace(dll=b"KERNEL32.dll")]
                if name == "tesseract.exe" else []
            )
            self.DIRECTORY_ENTRY_DELAY_IMPORT = (
                [SimpleNamespace(dll=b"delay.dll")] if name == "direct.dll" else []
            )
            self.DIRECTORY_ENTRY_EXPORT = (
                SimpleNamespace(symbols=[SimpleNamespace(forwarder=b"forwarded.Entry")])
                if name == "delay.dll" else None
            )

        def parse_data_directories(self, *, directories, forwarded_exports_only, import_dllnames_only):
            assert directories == [1, 13, 0]
            assert forwarded_exports_only and import_dllnames_only

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "pefile", SimpleNamespace(PE=Image, DIRECTORY_ENTRY={
        "IMAGE_DIRECTORY_ENTRY_IMPORT": 1, "IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT": 13,
        "IMAGE_DIRECTORY_ENTRY_EXPORT": 0,
    }))
    paths = build_backend.windows_ocr_binaries(tmp_path / "tesseract.exe")
    assert [p.name for p in paths] == ["tesseract.exe", "delay.dll", "direct.dll", "forwarded.dll"]


def test_missing_executable_has_no_path_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_TESSERACT_PATH", str(tmp_path / "missing"))
    with pytest.raises(RuntimeError, match="executable"):
        build_backend.ocr_resources()


def test_ocr_build_rejects_an_affected_engine_with_all_language_files(tmp_path, monkeypatch):
    executable = tmp_path / "tesseract"
    executable.touch()
    for language in build_backend.LANGUAGES:
        (tmp_path / (language + ".traineddata")).write_bytes(b"x" * 1001)
    monkeypatch.setenv("PDF_TESSERACT_PATH", str(executable))
    monkeypatch.setenv("PDF_TESSDATA_DIR", str(tmp_path))

    def run(args, **kwargs):
        if args[1] == "--version":
            return SimpleNamespace(stdout="tesseract v5.5.3.20260724\n")
        return SimpleNamespace(stdout="List of available languages:\neng\nchi_sim\nchi_tra\n")

    monkeypatch.setattr(build_backend.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="Tesseract 5.5.4"):
        build_backend.ocr_resources()


def test_frozen_self_check_refuses_missing_language_data(tmp_path, monkeypatch):
    monkeypatch.setattr(build_info.sys, "frozen", True, raising=False)
    monkeypatch.setattr(build_info.sys, "_MEIPASS", str(tmp_path), raising=False)
    with pytest.raises(RuntimeError, match="language is missing"):
        build_info.self_check()
