"""Fixed synthetic A4 workloads, actual frozen backend and independent outputs."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import platform
import random
import shutil
import sys
import time
import zipfile

import pymupdf as fitz
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from ocr_fixtures import _bitmap, verify_ocr_result
from frozen_protocol import FrozenWorker


def raster_target(image, frame, page, word, band, public):
    xscale, yscale = image.width / frame.width, image.height / frame.height
    region = tuple((fitz.Rect(band) * fitz.Matrix(xscale, yscale)).irect)
    ink = image.crop(region).convert("L").point(lambda value: 255 if value < 100 else 0).getbbox()
    assert ink
    return {"page": page, "word": word, "width": image.width, "height": image.height,
            "frame": list(frame), "inkRectPx": [ink[0] + region[0], ink[1] + region[1], ink[2] + region[0], ink[3] + region[1]],
            "publicRectPx": list((fitz.Rect(public) * fitz.Matrix(xscale, yscale)).irect)}


def generate(directory):
    directory.mkdir()
    contracts = {}
    for kind, pages in (("text", 250), ("scanned", 20), ("mixed", 20)):
        targets = []
        with fitz.open() as document:
            for index in range(pages):
                page = document.new_page(width=595, height=842)
                page.insert_text((40, 55), "PUBLIC HEADER " + str(index + 1), fontsize=16)
                if kind == "mixed":
                    page.insert_text((40, 115), "TEXTSECRET", fontsize=20)
                    png = _bitmap("IMAGESECRET")
                    image = Image.open(io.BytesIO(png)).convert("RGB")
                    frame = fitz.Rect(40, 240, 440, 420)
                    page.insert_image(frame, stream=png, keep_proportion=False)
                    targets.append(raster_target(image, frame, index + 1, "IMAGESECRET", [20, 60, 380, 110], [20, 20, 360, 48]))
                else:
                    for line in range(30):
                        y = 95 + line * 21
                        if 170 < y < 250:
                            continue
                        page.insert_text((40, y), f"Public reference {index + 1:04d} line {line + 1:02d}: keep this content.", fontsize=12)
                    page.insert_text((40, 210), "SECRET", fontsize=28)
                    assert "SECRET" in page.get_text()
                    if kind == "scanned":
                        pix = page.get_pixmap(dpi=150, alpha=False)
                        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                        table = bytes(248 + value % 8 for value in range(256))
                        noise = Image.frombytes("L", image.size, random.Random(20261101 + index).randbytes(image.width * image.height).translate(table))
                        image = ImageChops.darker(image, noise.convert("RGB"))
                        buffer = io.BytesIO(); image.save(buffer, format="PNG")
                        document.delete_page(index)
                        page = document.new_page(width=595, height=842)
                        page.insert_image(page.rect, stream=buffer.getvalue(), keep_proportion=False)
                        targets.append(raster_target(image, page.rect, index + 1, "SECRET", [30, 170, 400, 230], [30, 30, 450, 65]))
            file = directory / (kind + ".pdf")
            document.save(file, garbage=4, deflate=True)
        with fitz.open(file) as check:
            assert len(check) == pages
            if kind == "scanned":
                assert not any(page.get_text().strip() for page in check)
            else:
                assert all("PUBLIC HEADER" in page.get_text() for page in check)
        contracts[kind] = {"pageCount": pages, "keywords": ["TEXTSECRET", "IMAGESECRET"] if kind == "mixed" else ["SECRET"],
                           "public": ["PUBLIC HEADER"] if kind != "scanned" else [], "rasterTargets": targets,
                           "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "inputBytes": file.stat().st_size}
    (directory / "manifest.json").write_text(json.dumps(contracts, indent=2))
    return contracts


def verify_zip(archive, pdf, dpi):
    with fitz.open(pdf) as document, zipfile.ZipFile(archive) as images:
        assert images.namelist() == [f"page_{index + 1}.png" for index in range(len(document))]
        for index, page in enumerate(document):
            expected = page.get_pixmap(dpi=dpi, alpha=False)
            with Image.open(io.BytesIO(images.read(f"page_{index + 1}.png"))) as image:
                assert image.size == (expected.width, expected.height)
                assert all(abs(value - dpi) < .02 for value in image.info["dpi"])
                assert image.convert("RGB").tobytes() == expected.samples


def benchmark(args):
    args.output_directory.mkdir(parents=True, exist_ok=False)
    fixtures = args.output_directory / "fixtures"
    contracts = generate(fixtures)
    report = {"platform": platform.platform(), "machine": platform.machine(), "pythonHarness": platform.python_version(),
              "binarySha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(), "workloads": [], "verified": False,
              "method": "one fresh frozen process per workload; OS caches uncontrolled; synthetic A4 pages; default chi_sim+eng OCR; RSS includes shared-page double counting"}
    for kind, contract in contracts.items():
        worker = None
        record = {"kind": kind, "pageCount": contract["pageCount"], "inputBytes": contract["inputBytes"], "sourceSha256": contract["sha256"]}
        report["workloads"].append(record)
        try:
            worker = FrozenWorker(args.binary, args.output_directory / (kind + "-worker"))
            result, elapsed = worker.request("desensitize", {"file_path": str((fixtures / (kind + ".pdf")).resolve()),
                "keywords": contract["keywords"], "settings": {"ocr_mode": "local", "export_dpi": 150, "fuzzy_match_enabled": False}}, timeout=600)
            pdf = args.output_directory / (kind + ".pdf")
            shutil.copyfile(result["output_path"], pdf)
            record.update(processMs=elapsed, regions=len(result["review"]["regions"]), outputBytes=pdf.stat().st_size,
                          warningTypes=sorted({warning["type"] for warning in result.get("warnings") or []}))
            expected = {(page, word) for page in range(1, contract["pageCount"] + 1) for word in contract["keywords"]}
            actual = {(region["page"], word) for region in result["review"]["regions"] for word in region["keywords"]}
            assert actual == expected
            if kind == "text":
                with fitz.open(pdf) as document:
                    assert len(document) == contract["pageCount"]
                    assert all("SECRET" not in page.get_text() and "PUBLIC HEADER" in page.get_text() for page in document)
                    for xref in range(1, document.xref_length()):
                        assert b"SECRET" not in document.xref_object(xref).encode() + (document.xref_stream(xref) or b"")
            else:
                verify_ocr_result(pdf, fixtures / (kind + ".pdf"), contract)
                dpi = 150 if kind == "scanned" else 300
                exported, export_ms = worker.request("export", {"file_path": result["output_path"], "format": "png_zip", "dpi": dpi}, timeout=600)
                archive = args.output_directory / (kind + ".zip")
                shutil.copyfile(exported["zip_path"], archive)
                verify_zip(archive, pdf, dpi)
                record.update(pngDpi=dpi, exportMs=export_ms, zipBytes=archive.stat().st_size, pngPixelsVerified=True)
            record["verified"] = True
        except Exception as error:
            record.update(verified=False, errorType=type(error).__name__)
        finally:
            if worker:
                try:
                    worker.close()
                    record["worker"] = worker.summary()
                except Exception as error:
                    record.update(verified=False, shutdownErrorType=type(error).__name__)
            (args.output_directory / "report.json").write_text(json.dumps(report, indent=2))
        if not record.get("verified"):
            break
    report["verified"] = len(report["workloads"]) == 3 and all(item.get("verified") for item in report["workloads"])
    (args.output_directory / "report.json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    result = benchmark(parser.parse_args())
    print(json.dumps(result))
    sys.exit(0 if result["verified"] else 1)
