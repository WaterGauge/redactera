"""Real frozen JSON protocol and saved artifact checks; optional cloud secret on stdin."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from ocr_fixtures import inspect_ocr, verify_ocr_result
from frozen_protocol import FrozenWorker


def run(args):
    args.output_directory.mkdir(parents=True, exist_ok=False)
    settings = {"ocr_mode": args.mode, "export_dpi": 150, "fuzzy_match_enabled": False}
    if args.mode == "paddle":
        config = json.load(sys.stdin)
        settings.update(paddle_api_url=config.pop("url"), paddle_token=config.pop("token"))
        config.clear()
    report = {"mode": args.mode, "binarySha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "results": [], "verified": False}
    worker = None
    try:
        worker = FrozenWorker(args.binary, args.output_directory / "worker")
        report["contract"] = worker.manifest["contract"]
        for name, contract in inspect_ocr(args.fixtures).items():
            report["phase"] = name + ":process"
            result, elapsed = worker.request("desensitize", {"file_path": str((args.fixtures / name).resolve()),
                                             "keywords": contract["keywords"], "settings": settings})
            target = args.output_directory / name
            shutil.copyfile(result["output_path"], target)
            report["phase"] = name + ":verify"
            verify_ocr_result(target, args.fixtures / name, contract)
            expected = {(entry["page"], entry["word"]) for entry in contract["rasterTargets"]}
            if name == "mixed.pdf":
                expected.add((1, "TEXTSECRET"))
            actual = {(entry["page"], word) for entry in result["review"]["regions"] for word in entry["keywords"]}
            assert actual == expected
            exported, export_ms = worker.request("export", {"file_path": result["output_path"], "format": "png_zip", "dpi": 300})
            archive = args.output_directory / (name + ".300.zip")
            shutil.copyfile(exported["zip_path"], archive)
            subprocess.run([sys.executable, str(Path(__file__).with_name("verify-output.py")), "--fixtures", str(args.fixtures),
                            "--sample", name, "--output", str(archive), "--kind", "png_zip", "--dpi", "300",
                            "--reference-pdf", str(target)], capture_output=True, check=True, timeout=30)
            report["results"].append({"file": name, "processMs": elapsed, "exportMs": export_ms,
                                      "regions": len(result["review"]["regions"]), "pdfStoredPixelsVerified": True,
                                      "pngDpi": 300, "pngPixelsVerified": True,
                                      "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        report["verified"] = True
    except Exception as error:
        report["exceptionType"] = type(error).__name__
    finally:
        settings.clear()
        if worker:
            try:
                worker.close()
                report["worker"] = worker.summary()
            except Exception as error:
                report.update(verified=False, shutdownErrorType=type(error).__name__)
        (args.output_directory / "report.json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--mode", choices=["local", "paddle"], default="local")
    result = run(parser.parse_args())
    print(json.dumps(result))
    sys.exit(0 if result["verified"] else 1)
