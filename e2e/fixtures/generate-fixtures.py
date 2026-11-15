"""Generate known text fixtures; reject missing glyph mappings before testing.

No platform font path or OCR is used. Source assertions are independent of the
product processor so a missing target cannot pass a test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

import pymupdf as fitz
from ocr_fixtures import OCR_CONTRACT, generate_ocr, inspect_ocr

CONTRACT = {
    "sample.pdf": {"pageCount": 2, "required": ["SECRET", "PUBLIC CONTROL", "张三", "公开信息"],
                   "keywords": ["SECRET", "张三"], "public": ["PUBLIC CONTROL", "公开信息"]},
    "crossline-sample.pdf": {"pageCount": 1, "required": ["SEC\nRET", "PUBLIC CONTROL", "跨行样例"],
                             "keywords": ["SECRET"], "splitTarget": ["SEC", "RET"], "public": ["PUBLIC CONTROL"]},
}


def inspect(directory: Path) -> dict:
    fixtures = {}
    for name, contract in CONTRACT.items():
        file = directory / name
        with fitz.open(file) as document:
            text = "\n".join(page.get_text() for page in document)
            if len(document) != contract["pageCount"] or any(word not in text for word in contract["required"]):
                raise ValueError(f"Invalid source text in synthetic fixture: {name}")
            if "\ufffd" in text:
                raise ValueError(f"Invalid character mapping in synthetic fixture: {name}")
        fixtures[name] = {**contract, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    fixtures.update(inspect_ocr(directory))
    return {"version": 2, "fixtures": fixtures}


def generate(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fixture-", dir=directory) as temporary:
        staging = Path(temporary)
        with fitz.open() as document:
            page = document.new_page(width=300, height=400)
            page.insert_text((32, 50), "PUBLIC CONTROL", fontsize=12)
            page.insert_text((32, 100), "SECRET", fontsize=12)
            page = document.new_page(width=595, height=842)
            page.insert_text((40, 60), "公开信息：合成样本", fontname="china-s", fontsize=18)
            page.insert_text((40, 110), "姓名：张三", fontname="china-s", fontsize=14)
            document.save(staging / "sample.pdf")
        with fitz.open() as document:
            page = document.new_page(width=300, height=400)
            page.insert_text((32, 45), "PUBLIC CONTROL", fontsize=12)
            page.insert_text((32, 95), "SEC", fontsize=12)
            page.insert_text((32, 110), "RET", fontsize=12)
            page.insert_text((32, 160), "跨行样例", fontname="china-s", fontsize=14)
            document.save(staging / "crossline-sample.pdf")
        generate_ocr(staging)
        manifest = inspect(staging)
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for name in [*CONTRACT, *OCR_CONTRACT, "manifest.json"]:
            os.replace(staging / name, directory / name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--verify-only", action="store_true")
    options = parser.parse_args()
    if not options.verify_only:
        generate(options.output_directory)
    actual = inspect(options.output_directory)
    saved = json.loads((options.output_directory / "manifest.json").read_text(encoding="utf-8"))
    if actual != saved:
        raise ValueError("Synthetic fixture manifest does not match source files")
    print(json.dumps({"verified": True, "version": actual["version"], "fixtures": list(actual["fixtures"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
