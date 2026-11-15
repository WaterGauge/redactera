"""Generate and verify an ordinary PDF with native text and vector glyphs."""
import argparse
from io import BytesIO
import json
from pathlib import Path

import pymupdf as fitz
from fontTools.cffLib import CFFFontSet
from fontTools.pens.recordingPen import RecordingPen

KEYWORD = "SECRET"
OUTLINE = fitz.Rect(65, 145, 372, 226)
CHART = fitz.Rect(60, 299, 340, 355)


def add_outlines(page):
    font = CFFFontSet()
    font.decompile(BytesIO(fitz.Font("hebo").buffer), None)
    glyphs = font[font.fontNames[0]].CharStrings
    x = 80.0
    for letter in KEYWORD:
        glyph = glyphs[letter]
        pen = RecordingPen()
        glyph.draw(pen)
        shape = page.new_shape()
        start = current = None
        for operation, points in pen.value:
            mapped = [fitz.Point(x + dx * .064, 213 - dy * .064) for dx, dy in points]
            if operation == "moveTo":
                start = current = mapped[0]
            elif operation == "lineTo":
                shape.draw_line(current, mapped[0])
                current = mapped[0]
            elif operation == "curveTo":
                shape.draw_bezier(current, *mapped)
                current = mapped[-1]
            elif operation == "closePath":
                if current != start:
                    shape.draw_line(current, start)
                current = start
            else:
                raise ValueError(f"Unexpected outline operation: {operation}")
        shape.finish(color=None, fill=(0, 0, 0), closePath=False)
        shape.commit()
        x += glyph.width * .064 + 3


def generate(source: Path, *, rotation=0, cropped=False, user_unit=1.0):
    with fitz.open() as document:
        page = document.new_page(width=570 if cropped else 510, height=460 if cropped else 400)
        if cropped:
            page.set_cropbox(fitz.Rect(30, 30, 540, 430))
        page.insert_text((80, 95), KEYWORD, fontsize=34)
        page.insert_text((80, 270), "PUBLIC CONTROL", fontsize=20)
        add_outlines(page)
        for index in range(3):
            x = 88 + 50 * index
            page.draw_rect(fitz.Rect(x, 342 - 8 * (index + 1), x + 19, 342),
                           color=(0, 0, .7), fill=(.3, .5, 1))
        if user_unit != 1:
            document.xref_set_key(page.xref, "UserUnit", str(user_unit))
            page = document.reload_page(page)
        page.set_rotation(rotation)
        document.save(source, garbage=4, deflate=True)


def inspect_source(source: Path) -> None:
    with fitz.open(source) as document:
        page = document[0]
        assert len(document) == 1 and not page.get_image_info()
        assert page.get_text().count(KEYWORD) == 1 and "PUBLIC CONTROL" in page.get_text()
        outlines = _outline_paths(page)
        assert len(outlines) == len(KEYWORD), "Source control must contain all vector glyphs"


def _outline_paths(page):
    return [drawing["rect"] for drawing in page.get_drawings()
            if drawing.get("fill") == (0., 0., 0.) and len(drawing["items"]) > 4]


def _chart_pixels(page):
    # Rendering at the unrotated visible origin also works with a cropped page.
    rotation = page.rotation
    try:
        page.set_rotation(0)
        return page.get_pixmap(dpi=144, clip=CHART * fitz.Matrix(page.rect.width / 510, page.rect.height / 400)).samples
    finally:
        page.set_rotation(rotation)


def verify_result(source: Path, output: Path):
    inspect_source(source)
    with fitz.open(source) as original, fitz.open(output) as result:
        before, after = original[0], result[0]
        assert len(result) == 1 and after.rect == before.rect and after.cropbox == before.cropbox
        assert after.rotation == before.rotation
        assert KEYWORD not in after.get_text() and "PUBLIC CONTROL" in after.get_text()
        assert not _outline_paths(after), "Sensitive vector paths survive in the exported file"
        assert not after.get_image_info(), "The output must keep its vector representation"
        assert _chart_pixels(after) == _chart_pixels(before), "Public chart pixels changed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        verify_result(args.source, args.output)
        print(json.dumps({"nativeTextRemoved": True, "outlinePathsRemoved": True, "publicChartPreserved": True}))
    else:
        generate(args.source)
        inspect_source(args.source)
