"""Versioned startup identity shared by source and frozen backends."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
from typing import Any

from source_inventory import backend_files


def checked_tesseract_version(executable: Path) -> str:
    result = subprocess.run([str(executable), "--version"], capture_output=True, text=True, check=True, timeout=20)
    line = next(iter(result.stdout.splitlines()), "").strip()
    version = re.fullmatch(r"tesseract v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?", line)
    if version is None or tuple(map(int, version.groups())) < (5, 5, 4):
        raise RuntimeError("Tesseract 5.5.4 or newer is required for multilingual OCR")
    return line


def source_contract() -> dict[str, Any]:
    root = Path(__file__).absolute().parent.parent
    files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
             for name in backend_files(root)}
    upstream = root / "scripts/release-upstream.json"
    files["scripts/release-upstream.json"] = hashlib.sha256(upstream.read_bytes()).hexdigest()
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    return {"protocol": 1, "appVersion": version,
            "sourceSha256": hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest()}


def backend_contract() -> dict[str, Any]:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS"))
        value: dict[str, Any] = json.loads((base / "backend-build.json").read_text(encoding="utf-8"))["contract"]
        if value.get("protocol") != 1 or not isinstance(value.get("appVersion"), str) or len(value.get("sourceSha256", "")) != 64:
            raise RuntimeError("Invalid backend build identity")
        return value
    return source_contract()


def runtime_versions() -> dict[str, str]:
    # Python 3.11 decodes the patch of OpenSSL 3 into the fourth tuple field.
    provider, version, *_ = ssl.OPENSSL_VERSION.split()
    openssl = version if provider == "OpenSSL" else ssl.OPENSSL_VERSION
    return {"python": sys.version.split()[0], "openssl": openssl}


def self_check() -> dict[str, Any]:
    import pymupdf as fitz
    import PIL
    import requests
    import fontTools
    import pytesseract
    from PIL import Image
    from local_ocr import read_ocr_data
    from pdf_processor import PDFProcessor
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS")) / "tesseract"
        executable = base / ("tesseract.exe" if sys.platform == "win32" else "tesseract")
        for language in ("eng", "chi_sim", "chi_tra"):
            if not (base / "tessdata" / (language + ".traineddata")).is_file():
                raise RuntimeError("Bundled OCR language is missing")
        os.environ["TESSDATA_PREFIX"] = str(base / "tessdata")
    else:
        located = shutil.which("tesseract")
        if not located:
            raise RuntimeError("Tesseract executable is missing")
        executable = Path(located)
    result = subprocess.run([str(executable), "--list-langs"], capture_output=True, text=True, check=True, timeout=20)
    languages = set(result.stdout.splitlines()[1:])
    if not {"eng", "chi_sim", "chi_tra"}.issubset(languages):
        raise RuntimeError("Required OCR languages are unavailable")
    version = checked_tesseract_version(executable)
    pytesseract.pytesseract.tesseract_cmd = str(executable)
    ocr = {}
    for text, language, font in (("SECRET 12345", "eng", "helv"), ("测试中文", "chi_sim", "china-s"), ("測試中文", "chi_tra", "china-t")):
        with fitz.open() as document:
            page = document.new_page(width=400, height=100)
            page.insert_text((20, 65), text, fontsize=36, fontname=font)
            png = page.get_pixmap(dpi=150).tobytes("png")
            if sys.platform == "win32":
                recognized = " ".join(word for word in read_ocr_data(png, language, timeout=20, psm=7)["text"] if word)
            else:
                with Image.open(io.BytesIO(png)) as image:
                    recognized = pytesseract.image_to_string(image, lang=language, config="--psm 7", timeout=20)
            if "".join(text.split()) not in "".join(recognized.split()):
                raise RuntimeError("Bundled OCR recognition failed: " + language)
            ocr[language] = recognized.strip()
    return {"type": "build-self-check", "contract": backend_contract(), "frozen": bool(getattr(sys, "frozen", False)),
            **runtime_versions(), "pymupdf": fitz.VersionBind, "mupdf": fitz.VersionFitz, "pillow": PIL.__version__,
            "requests": requests.__version__, "fonttools": fontTools.__version__, "pytesseract": pytesseract.__version__,
            "processor": PDFProcessor.__name__, "ocrLanguages": sorted(languages), "ocrSmoke": ocr, "tesseract": version}
