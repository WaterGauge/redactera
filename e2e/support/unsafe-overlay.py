"""Deliberately unsafe synthetic result for the artifact verifier's negative control."""
import argparse
import json
from pathlib import Path

import pymupdf as fitz


def overlay(source: Path, output: Path, review):
    assert source.name == "scanned.pdf" and review["version"] == 1
    with fitz.open(source) as document:
        assert len(document) == review["pageCount"] == 2
        for region in review["regions"]:
            page = document[region["page"] - 1]
            points = [fitz.Point(x * page.rect.width, y * page.rect.height) for x, y in region["polygon"]]
            page.draw_polyline(points + [points[0]], color=(0, 0, 0), fill=(0, 0, 0), closePath=True, overlay=True)
        temporary = output.with_name(output.name + ".unsafe-overlay.tmp")
        document.save(temporary, garbage=4, deflate=True)
    temporary.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    import sys
    overlay(args.source, args.output, json.load(sys.stdin))
