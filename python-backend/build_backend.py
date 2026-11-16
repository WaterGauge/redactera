"""Native, fail-closed backend build. Never installs packages or OCR resources."""
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

import pymupdf as fitz

from build_info import checked_tesseract_version, runtime_versions, source_contract
from source_inventory import backend_files

LANGUAGES = ("eng", "chi_sim", "chi_tra")


def sha256(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def windows_ocr_binaries(executable: Path) -> list[Path]:
    """Keep the bundled OCR loader closure, including delay imports and forwarded exports."""
    import pefile

    vendor_dlls = {file.name.casefold(): file for file in executable.parent.glob("*.dll") if file.is_file()}
    directories = [pefile.DIRECTORY_ENTRY[name] for name in (
        "IMAGE_DIRECTORY_ENTRY_IMPORT", "IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT", "IMAGE_DIRECTORY_ENTRY_EXPORT"
    )]
    included = {executable}
    pending = [executable]
    while pending:
        image = pefile.PE(str(pending.pop()), fast_load=True)
        try:
            image.parse_data_directories(directories=directories, forwarded_exports_only=True, import_dllnames_only=True)
            imports = {
                entry.dll.decode("ascii").casefold()
                for attribute in ("DIRECTORY_ENTRY_IMPORT", "DIRECTORY_ENTRY_DELAY_IMPORT")
                for entry in getattr(image, attribute, ())
            }
            exports = getattr(image, "DIRECTORY_ENTRY_EXPORT", None)
            if exports:
                imports.update(
                    symbol.forwarder.decode("ascii").split(".", 1)[0].casefold() + ".dll"
                    for symbol in exports.symbols if symbol.forwarder
                )
        finally:
            image.close()
        for name in imports:
            library = vendor_dlls.get(name)
            if library is not None and library not in included:
                included.add(library)
                pending.append(library)
    return [executable, *sorted(included - {executable})]


def ocr_resources() -> dict[str, Any]:
    configured = os.environ.get("PDF_TESSERACT_PATH")
    candidate = configured or shutil.which("tesseract")
    if not candidate and sys.platform == "win32":
        candidate = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if not candidate or not Path(candidate).is_absolute() or not Path(candidate).is_file():
        raise RuntimeError("Set PDF_TESSERACT_PATH to an existing native Tesseract executable")
    executable = Path(candidate).resolve()
    result = subprocess.run([str(executable), "--list-langs"], capture_output=True, text=True, check=True, timeout=20)
    supplied = os.environ.get("PDF_TESSDATA_DIR")
    match = re.search(r'"([^"]+)"', result.stdout.splitlines()[0])
    directory = Path(supplied or (match.group(1) if match else ""))
    if not directory.is_absolute() or not directory.is_dir():
        raise RuntimeError("Set PDF_TESSDATA_DIR to the native OCR language directory")
    data = [directory / (language + ".traineddata") for language in LANGUAGES]
    if any(not file.is_file() or file.stat().st_size < 1000 for file in data):
        raise RuntimeError("Required OCR resources eng/chi_sim/chi_tra are missing")
    checked_tesseract_version(executable)
    binaries = windows_ocr_binaries(executable) if sys.platform == "win32" else [executable]
    return {"binaries": [str(file) for file in binaries], "data": [str(file) for file in data],
            "sha256": {str(file): sha256(file) for file in binaries + data}}


def write_python_notices(run: Path, project_license: Path, openssl_license: Path | None) -> str:
    analysis = json.loads((run / "analyzed-inputs.json").read_text(encoding="utf-8"))
    origins = {Path(source).resolve() for rows in analysis.values()
               for _, source, kind in rows if kind != "SYMLINK"}
    stdlib = Path(sysconfig.get_path("stdlib"))
    cpython_license = next((file for file in (stdlib / "LICENSE.txt",
        Path(sys.base_prefix) / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE") if file.is_file()), None)
    if cpython_license is None:
        raise RuntimeError("The native Python distribution must provide its license text")

    packages = {"CPython": platform.python_version()}
    destination = run / "dist/python-licenses.zip"
    notice_name = re.compile(r"^(LICENSE|COPYING|NOTICE|COPYRIGHT|AUTHORS)(\b|_)", re.IGNORECASE)
    with ZipFile(destination, "x", compression=ZIP_DEFLATED) as archive:
        archive.writestr("CPython/LICENSE.txt", cpython_license.read_bytes())
        if openssl_license is not None:
            archive.writestr("OpenSSL/LICENSE.txt", openssl_license.read_bytes())
        for distribution in importlib.metadata.distributions():
            files = distribution.files or ()
            name = distribution.metadata["Name"]
            if name.casefold() != "pyinstaller" and not any(
                Path(str(distribution.locate_file(file))).resolve() in origins for file in files
            ):
                continue
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or name in packages:
                raise RuntimeError("Invalid or duplicate Python distribution name")
            notices = [file for file in files if file.parts[0].endswith(".dist-info")
                       and ".." not in file.parts and notice_name.match(file.name)]
            if not notices:
                raise RuntimeError("Missing Python distribution license: " + name)
            for file in notices:
                contents = Path(str(distribution.locate_file(file))).read_bytes()
                digest = base64.urlsafe_b64encode(hashlib.sha256(contents).digest()).rstrip(b"=").decode("ascii")
                if not contents or (file.hash and file.hash.mode == "sha256" and file.hash.value != digest):
                    raise RuntimeError("Invalid Python distribution license: " + name)
                archive.writestr("/".join((name, *file.parts[1:])), contents)
            if name.casefold() == "pymupdf":
                archive.writestr(f"{name}/AGPL-3.0.txt", project_license.read_bytes())
            packages[name] = distribution.version
        archive.writestr("python-distributions.json", json.dumps(packages, indent=2, sort_keys=True) + "\n")
    return sha256(destination)


def build() -> None:
    root = Path(__file__).resolve().parent.parent
    if sys.platform not in ("darwin", "win32"):
        raise RuntimeError("Run Windows builds with native Windows Python; macOS builds require macOS Python")
    architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine().lower())
    if not architecture or sys.version_info[:2] != (3, 11):
        raise RuntimeError("A supported native architecture and Python 3.11 are required")
    tools = {}
    for requirement in (root / "python-backend/requirements.txt").read_text().splitlines():
        if not requirement.strip() or requirement.startswith("#"):
            continue
        name, expected = requirement.split("==")
        actual = importlib.metadata.version(name)
        if actual != expected:
            raise RuntimeError("Installed dependency does not match requirements: " + name)
        tools[name] = actual
    upstream = json.loads((root / "scripts/release-upstream.json").read_text(encoding="utf-8"))
    runtime = runtime_versions()
    pinned_runtime = {name: upstream["pythonRuntime"][name] for name in runtime}
    if os.environ.get("PDF_REQUIRE_RELEASE_RUNTIME") == "1" and runtime != pinned_runtime:
        raise RuntimeError("Release builds require the pinned Python and OpenSSL versions")
    if fitz.VersionBind != upstream["pymupdfVersion"] or fitz.VersionFitz != upstream["mupdfVersion"]:
        raise RuntimeError("Installed PDF engine does not match the corresponding release source")
    release_commit = None
    if os.environ.get("PDF_REQUIRE_RELEASE_RUNTIME") == "1":
        release_commit = subprocess.check_output(["git", "rev-parse", "--verify",
            os.environ.get("PDF_RELEASE_SOURCE_COMMIT", "HEAD") + "^{commit}"], cwd=root, text=True).strip()

    def verify_release_source() -> None:
        if release_commit is not None:
            names = [*backend_files(root), "scripts/release-upstream.json", "package.json"]
            inputs = {name: sha256(root / name) for name in names}
            subprocess.run([sys.executable, str(root / "scripts/verify-release-source.py"), str(root), release_commit],
                           input=json.dumps(inputs), text=True, check=True, timeout=120)

    verify_release_source()
    identity = source_contract()
    resources = ocr_resources()
    base = root / ".project-state/backend-builds"
    base.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=base))
    inputs = run / "backend-build.json"
    inputs.write_text(json.dumps({"contract": identity, "resources": resources}, indent=2), encoding="utf-8")
    environment = dict(os.environ, PDF_BACKEND_BUILD_INPUT=str(inputs))
    if sys.platform == "win32":
        python_dlls = str(Path(sys.base_prefix) / "DLLs")
        environment["PATH"] = os.pathsep.join(filter(None, (python_dlls, environment.get("PATH"))))
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--workpath", str(run / "work"),
                    "--distpath", str(run / "dist"), "python_backend.spec"], cwd=root / "python-backend", env=environment, check=True)
    executable = run / "dist" / ("python_backend.exe" if sys.platform == "win32" else "python_backend")
    # Verify the real archive before it can become an application resource.
    from PyInstaller.archive.readers import CArchiveReader
    archive = CArchiveReader(str(executable))
    runtime_metadata = json.loads(archive.extract('backend-build.json'))
    if runtime_metadata != {'contract': identity}:
        raise RuntimeError('Frozen runtime metadata contains build-only information')
    if sys.platform == "win32":
        for source in resources["binaries"]:
            member = str(Path("tesseract") / Path(source).name)
            if hashlib.sha256(archive.extract(member)).hexdigest() != resources["sha256"][source]:
                raise RuntimeError("Frozen OCR binary does not match the locked input: " + member)
    # No Homebrew/Tesseract PATH fallback is available during this actual bundle check.
    isolated = dict(os.environ, PATH=os.environ.get("SystemRoot", r"C:\Windows") + r"\System32" if sys.platform == "win32" else "/usr/bin:/bin")
    isolated.pop("TESSDATA_PREFIX", None)
    result = subprocess.run([str(executable), "--self-check"], env=isolated, capture_output=True, text=True, timeout=90, check=True)
    (run / "self-check-stdout.txt").write_text(result.stdout, encoding="utf-8")
    (run / "self-check-stderr.txt").write_text(result.stderr, encoding="utf-8")
    check = json.loads(result.stdout)
    if check.get("contract") != identity or check.get("frozen") is not True or source_contract() != identity or ocr_resources()["sha256"] != resources["sha256"]:
        raise RuntimeError("Build inputs or actual frozen identity changed")
    if (check.get("pymupdf") != upstream["pymupdfVersion"] or check.get("mupdf") != upstream["mupdfVersion"]
            or check.get("requests") != tools["requests"]):
        raise RuntimeError("Frozen PDF engine or HTTP client does not match the build environment")
    if any(check.get(name) != version for name, version in runtime.items()):
        raise RuntimeError("Frozen Python or OpenSSL does not match the build environment")
    verify_release_source()
    openssl_license = root / "python-backend/openssl-license.txt" if runtime["openssl"] == pinned_runtime["openssl"] else None
    notices_sha256 = write_python_notices(run, root / "LICENSE", openssl_license)
    manifest = {"contract": identity, "platform": sys.platform, "arch": architecture, "executable": executable.name,
                "executableSha256": sha256(executable), "pythonLicensesSha256": notices_sha256, "tools": tools, "ocrSha256": resources["sha256"], "selfCheck": check}
    (run / "dist/backend-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    destination = root / "python-backend/dist"
    previous = run / "previous-dist"
    if destination.exists():
        destination.rename(previous)
    try:
        (run / "dist").rename(destination)
    except BaseException:
        if previous.exists():
            previous.rename(destination)
        raise
    (base / "latest.json").write_text(json.dumps({"run": str(run), "manifest": manifest}, indent=2), encoding="utf-8")
    print(json.dumps({"built": str(destination), "run": str(run), "contract": identity}))


if __name__ == "__main__":
    build()
