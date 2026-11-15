"""Show that a visually black PDF retaining source pixels is rejected."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from ocr_fixtures import inspect_ocr, verify_ocr_result


def check(fixtures: Path, result: Path, review: Path, output: Path):
    spec = importlib.util.spec_from_file_location("unsafe_overlay", Path(__file__).with_name("unsafe-overlay.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    contract = inspect_ocr(fixtures)["scanned.pdf"]
    source = fixtures / "scanned.pdf"
    verify_ocr_result(result, source, contract)
    module.overlay(source, output, json.loads(review.read_text()))
    return {**check_unsafe(fixtures, output), "safeResultAccepted": True}


def check_unsafe(fixtures: Path, output: Path):
    contract = inspect_ocr(fixtures)["scanned.pdf"]
    source = fixtures / "scanned.pdf"
    with fitz.open(source) as original, fitz.open(output) as unsafe:
        for target in contract["rasterTargets"]:
            index = target["page"] - 1
            pix = fitz.Pixmap(unsafe, unsafe[index].get_images(full=True)[0][0])
            source_pix = fitz.Pixmap(original, original[index].get_images(full=True)[0][0])
            assert pix.samples == source_pix.samples, "Negative control must retain original sensitive pixels"
            frame = fitz.Rect(target["frame"])
            ink = fitz.Rect(target["inkRectPx"]) * fitz.Matrix(frame.width / pix.width, frame.height / pix.height)
            ink += (frame.x0, frame.y0, frame.x0, frame.y0)
            assert set(unsafe[index].get_pixmap(dpi=150, clip=ink, alpha=False).samples) == {0}, "Negative control must look fully black"
    try:
        verify_ocr_result(output, source, contract)
    except AssertionError as error:
        assert str(error) == "Sensitive pixels remain in a stored PDF image", "Unexpected negative-control failure"
    else:
        raise AssertionError("Unsafe overlay was accepted")
    return {"verified": True, "overlayLooksBlack": True,
            "originalPixelsRetained": True, "unsafeOverlayRejected": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    for name in ("result", "review", "output", "unsafe-result"):
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    if args.unsafe_result and not any((args.result, args.review, args.output)):
        report = check_unsafe(args.fixtures, args.unsafe_result)
    elif not args.unsafe_result and all((args.result, args.review, args.output)):
        report = check(args.fixtures, args.result, args.review, args.output)
    else:
        parser.error('Provide --unsafe-result, or all of --result/--review/--output')
    print(json.dumps(report))
