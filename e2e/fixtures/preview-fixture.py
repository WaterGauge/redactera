"""Independent synthetic Chinese/table/JPX preview control, never user material."""
import argparse
import hashlib
import io
import json
import random
from pathlib import Path

import pymupdf as fitz
from PIL import Image


def inspect(directory: Path) -> dict:
    file = directory / "preview.pdf"
    with fitz.open(file) as document:
        assert len(document) == 2
        assert "公开信息：复杂页面预览" in document[0].get_text()
        assert "PUBLIC SECOND PAGE" in document[1].get_text()
        assert any(document.xref_get_key(item[0], "Filter")[1] == "/JPXDecode" for item in document[0].get_images())
    large = directory / "preview-large.pdf"
    rng = random.Random(20261102)
    with fitz.open(large) as document:
        assert len(document) == 250
        assert "PUBLIC LARGE PAGE 1" in document[0].get_text()
        assert "PUBLIC LARGE PAGE 250" in document[-1].get_text()
        for index in range(3):
            images = document[index].get_images()
            assert len(images) == 1
            assert document.xref_stream(images[0][0]) == rng.randbytes(1800 * 1800 * 3)
    assert large.stat().st_size > 25_000_000
    return {"version": 2, "large": {"sha256": hashlib.sha256(large.read_bytes()).hexdigest(),
                                      "pageCount": 250, "bytes": large.stat().st_size}, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "pageCount": 2, "titlePrefixRect": [40, 40, 112, 65], "pageSize": [595, 842]}


def generate(directory: Path) -> None:
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        page.insert_text((40, 60), "公开信息：复杂页面预览", fontname="china-s", fontsize=18)
        for row in range(4):
            page.insert_text((48, 115 + row * 38), f"表格第{row + 1}行：公开内容", fontname="china-s", fontsize=14)
            page.draw_line((40, 125 + row * 38), (550, 125 + row * 38))
        page.insert_text((40, 330), "E = mc^2", fontsize=18)
        page.draw_circle((400, 430), 45, color=(0, .3, .8), fill=(.5, .7, 1))
        image = Image.new("RGB", (128, 64))
        image.putdata([(230, 60, 40) if (x // 16 + y // 16) % 2 else (40, 80, 230)
                       for y in range(64) for x in range(128)])
        stream = io.BytesIO()
        image.save(stream, format="JPEG2000")
        page.insert_image(fitz.Rect(40, 370, 296, 498), stream=stream.getvalue())
        page = document.new_page(width=400, height=300)
        page.insert_text((24, 50), "PUBLIC SECOND PAGE", fontsize=18)
        document.save(directory / "preview.pdf")
    # Distinct incompressible images exercise the async binary bridge rather
    # than padding a tiny PDF or repeatedly referencing the same image object.
    rng = random.Random(20261102)
    with fitz.open() as document:
        for index in range(250):
            page = document.new_page(width=595, height=842)
            page.insert_text((40, 60), f"PUBLIC LARGE PAGE {index + 1}", fontsize=18)
            if index < 3:
                pixels = fitz.Pixmap(fitz.csRGB, 1800, 1800, rng.randbytes(1800 * 1800 * 3), False)
                page.insert_image(fitz.Rect(40, 100, 555, 615), pixmap=pixels)
        document.save(directory / "preview-large.pdf")
    (directory / "preview-manifest.json").write_text(json.dumps(inspect(directory), indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if not args.verify_only:
        generate(args.directory)
    assert inspect(args.directory) == json.loads((args.directory / "preview-manifest.json").read_text())
    print(json.dumps({"verified": True, **inspect(args.directory)}))
