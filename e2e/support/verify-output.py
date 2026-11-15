"""Independent saved-artifact assertions, with source-positive controls first."""
import argparse
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import zipfile
import sys

import pymupdf as fitz
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from ocr_fixtures import verify_ocr_result


def verify_pdf(file, sample, contract):
    if contract.get("rasterTargets"):
        verify_ocr_result(file, sample, contract)
        assert file.read_bytes() != sample.read_bytes(), "OCR export is the original PDF"
        return
    with fitz.open(file) as document:
        assert len(document) == contract["pageCount"], "Wrong page count"
        text = "\n".join(page.get_text() for page in document)
        assert all(word in text for word in contract["public"]), "Public control text missing"
        targets = contract.get("splitTarget", contract["keywords"])
        assert all(word not in text for word in targets), "Sensitive source text remains recoverable"
        for xref in range(1, document.xref_length()):
            data = document.xref_object(xref).encode("utf-8") + (document.xref_stream(xref) or b"")
            assert b"SECRET" not in data, "Sensitive marker remains in a PDF object"
        assert file.read_bytes() != sample.read_bytes(), "Export is the original PDF"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample", required=True)
    parser.add_argument("--kind", choices=["pdf", "png_zip"], required=True)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--reference-pdf", type=Path)
    args = parser.parse_args()
    module_path = Path(__file__).resolve().parents[1] / "fixtures/generate-fixtures.py"
    spec = importlib.util.spec_from_file_location("fixture_contract", module_path)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    manifest = generator.inspect(args.fixtures)
    assert manifest == json.loads((args.fixtures / "manifest.json").read_text(encoding="utf-8")), "Source fixtures changed"
    contract = manifest["fixtures"][args.sample]
    source = args.fixtures / args.sample
    if args.kind == "pdf":
        verify_pdf(args.output, source, contract)
    else:
        assert args.reference_pdf and args.dpi in (150, 200, 300)
        verify_pdf(args.reference_pdf, source, contract)
        with fitz.open(args.reference_pdf) as document, zipfile.ZipFile(args.output) as archive:
            assert archive.namelist() == [f"page_{index + 1}.png" for index in range(len(document))]
            for index, page in enumerate(document):
                with Image.open(io.BytesIO(archive.read(f"page_{index + 1}.png"))) as image:
                    assert image.size == (math.ceil(page.rect.width * args.dpi / 72), math.ceil(page.rect.height * args.dpi / 72))
                    assert all(abs(value - args.dpi) < .02 for value in image.info["dpi"])
                    expected = page.get_pixmap(dpi=args.dpi, alpha=False)
                    assert image.convert("RGB").tobytes() == expected.samples, "ZIP pixels differ from the verified result PDF"
    print(json.dumps({"verified": True, "kind": args.kind, "sample": args.sample,
                      "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
