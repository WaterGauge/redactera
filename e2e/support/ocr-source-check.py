"""Positive OCR controls outside the product, before asserting target absence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

import pymupdf as fitz
from PIL import Image
import pytesseract

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-backend"))
sys.path.insert(0, str(ROOT / "e2e/fixtures"))
from build_backend import ocr_resources
from ocr_fixtures import inspect_ocr


def check(directory: Path):
    resources = ocr_resources()
    executable = resources["binaries"][0]
    data_directory = str(Path(resources["data"][0]).parent)
    pytesseract.pytesseract.tesseract_cmd = executable
    os.environ["TESSDATA_PREFIX"] = data_directory
    contracts = inspect_ocr(directory)
    records = []
    for name, contract in contracts.items():
        with fitz.open(directory / name) as document:
            for target in contract["rasterTargets"]:
                page = document[target["page"] - 1]
                pix = page.get_pixmap(dpi=150, alpha=False)
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                text = pytesseract.image_to_string(image, lang="chi_sim+eng", timeout=30)
                normalized = "".join(text.split())
                if target["word"] not in normalized or "PUBLICCONTROL" not in normalized:
                    raise ValueError("Actual source OCR did not recognize the known target and public control: " + name)
                records.append({"file": name, "page": target["page"], "targetRecognized": True,
                                "publicRecognized": True, "renderedPageSha256": hashlib.sha256(pix.samples).hexdigest()})
    return {"verified": True, "executable": executable, "tessdataDirectory": data_directory,
            "version": str(pytesseract.get_tesseract_version()), "sourceControls": records}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.fixtures), ensure_ascii=True))
