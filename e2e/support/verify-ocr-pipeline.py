"""Real local/cloud adapter regression. Cloud configuration is accepted only on stdin.

Only synthetic fixtures are uploaded. Never emit raw exceptions, headers, request
or response bodies, job identifiers or result URLs. Network policy is unchanged.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-backend"))
sys.path.insert(0, str(ROOT / "e2e/fixtures"))
from diagnostics import configure_diagnostics, error_kind
import pdf_processor
from pdf_processor import PDFProcessor
from request_context import request_scope
from ocr_fixtures import inspect_ocr, verify_ocr_result


def run(args):
    configure_diagnostics(False, "")
    args.output_directory.mkdir(parents=True, exist_ok=False)
    contracts = inspect_ocr(args.fixtures)
    settings = {"ocr_mode": args.mode, "export_dpi": 150, "fuzzy_match_enabled": False}
    if args.mode == "paddle":
        supplied = json.load(sys.stdin)
        settings.update(paddle_api_url=supplied.pop("url"), paddle_token=supplied.pop("token"))
        supplied.clear()
    report = {"mode": args.mode, "model": "PaddleOCR-VL-1.5" if args.mode == "paddle" else "Tesseract",
              "network": [], "sourceControls": [], "results": [], "verified": False}
    request = pdf_processor.paddle_request

    def observe_request(method, url, **kwargs):
        entry = {"method": method, "phase": "submit" if method == "POST" else "poll" if "/api/v2/ocr/jobs/" in url else "download"}
        report["network"].append(entry)
        started = time.monotonic()
        try:
            response = request(method, url, **kwargs)
            entry["status"] = response.status_code
            return response
        except Exception as error:
            entry["errorKind"] = error_kind(error)
            entry["exceptionType"] = type(error).__name__
            raise
        finally:
            entry["elapsedMs"] = round((time.monotonic() - started) * 1000)

    pdf_processor.paddle_request = observe_request
    processor = PDFProcessor()
    fetch = processor._fetch_paddle_all_pages
    current = {}

    def observe_fetch(*positional, **keywords):
        pages = fetch(*positional, **keywords)
        expected = current["contract"]
        assert len(pages) == expected["pageCount"], "Live source page count differs"
        for target in expected["rasterTargets"]:
            page = pages[target["page"] - 1]
            normalized = "".join("".join(str(token["text"]) for token in page["tokens"]).split())
            entry = {"file": current["file"], "page": target["page"],
                     "targetRecognized": target["word"] in normalized,
                     "publicRecognized": "PUBLICCONTROL" in normalized,
                     "width": page.get("img_w"), "height": page.get("img_h"), "tokens": len(page["tokens"])}
            report["sourceControls"].append(entry)
            assert entry["targetRecognized"] and entry["publicRecognized"], "Live source OCR control failed"
        return pages

    if args.mode == "paddle":
        processor._fetch_paddle_all_pages = observe_fetch
    try:
        for name, contract in contracts.items():
            current.update(file=name, contract=contract)
            started = time.monotonic()
            with request_scope(time.time() * 1000 + 180000):
                result = processor.desensitize(str(args.fixtures / name), contract["keywords"], settings)
            output = args.output_directory / name
            shutil.copyfile(result["output_path"], output)
            (args.output_directory / (name + ".review.json")).write_text(json.dumps(result["review"]), encoding="utf-8")
            report["results"].append({"file": name, "regions": len(result["review"]["regions"]),
                                      "warningTypes": sorted({item["type"] for item in result.get("warnings") or []})})
            report["phase"] = "stored-and-displayed-pixels"
            verify_ocr_result(output, args.fixtures / name, contract)
            expected = {(target["page"], target["word"]) for target in contract["rasterTargets"]}
            if name == "mixed.pdf":
                expected.add((1, "TEXTSECRET"))
            actual = {(region["page"], word) for region in result["review"]["regions"] for word in region["keywords"]}
            assert actual == expected, "Review does not cover exactly the known target locations"
            exported = processor.export(result["output_path"], "png_zip", dpi=300)
            shutil.copyfile(exported["zip_path"], args.output_directory / (name + ".300.zip"))
            subprocess.run([sys.executable, str(Path(__file__).with_name("verify-output.py")),
                            "--fixtures", str(args.fixtures), "--output", str(args.output_directory / (name + ".300.zip")),
                            "--sample", name, "--kind", "png_zip", "--dpi", "300", "--reference-pdf", str(output)],
                           capture_output=True, check=True, timeout=30)
            report["results"][-1].update(elapsedMs=round((time.monotonic() - started) * 1000),
                                        sha256=hashlib.sha256(output.read_bytes()).hexdigest(), pngDpi=300, pngPixelsVerified=True)
        report["verified"] = True
    except Exception as error:
        report["errorKind"] = error_kind(error)
        report["exceptionType"] = type(error).__name__
        report["failedFile"] = current.get("file")
    finally:
        processor.cleanup()
        settings.clear()
        pdf_processor.paddle_request = request
        (args.output_directory / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--output-directory", required=True, type=Path)
    parser.add_argument("--mode", choices=["local", "paddle"], default="local")
    options = parser.parse_args()
    try:
        result = run(options)
    except Exception as error:
        result = {"verified": False, "errorKind": error_kind(error), "exceptionType": type(error).__name__}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0 if result["verified"] else 1)
