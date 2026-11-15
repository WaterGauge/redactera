"""Preserve the matching, privacy and page geometry contracts for outline OCR."""

import importlib.util
import math
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import pytest
from PIL import Image

from pdf_processor import PDFProcessor, normalize_settings
from .test_redaction_mixed_pages import settings


spec = importlib.util.spec_from_file_location(
    "outline_fixture", Path(__file__).resolve().parents[2] / "e2e/fixtures/outline-fixture.py"
)
outline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(outline)


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


@pytest.mark.parametrize(("mode", "rotation", "cropped", "unit"), [
    ("local", 0, False, 1), ("paddle", 90, True, .5), ("baidu", 270, True, 2),
])
def test_second_keyword_appearance_is_removed_locally(processor, tmp_path, monkeypatch, mode, rotation, cropped, unit):
    source, output = tmp_path / "outline.pdf", tmp_path / "export.pdf"
    outline.generate(source, rotation=rotation, cropped=cropped, user_unit=unit)
    outline.inspect_source(source)
    before = source.read_bytes()
    calls = []

    def read_ocr(png, lang, **_kwargs):
        calls.append(lang)
        with Image.open(BytesIO(png)) as image:
            scale = 150 / 72 * unit
            assert image.size == (math.ceil(510 * scale), math.ceil(400 * scale))
            assert image.crop((int(75 * scale), int(60 * scale), int(220 * scale), int(110 * scale))).getextrema() == (255, 255)
            assert image.crop((int(65 * scale), int(145 * scale), int(372 * scale), int(226 * scale))).getextrema()[0] == 0
            return {"text": ["SECRET"], "conf": [95], "left": [80 * scale], "top": [164 * scale],
                    "width": [276 * scale], "height": [52 * scale], "block_num": [1], "par_num": [1], "line_num": [1]}

    monkeypatch.setattr("pdf_processor.read_ocr_data", read_ocr)
    with (patch.object(processor, "_fetch_paddle_all_pages") as paddle,
          patch.object(processor, "_get_page_ocr_data_baidu") as baidu):
        result = processor.desensitize(str(source), ["SECRET"], {**settings(mode), "ocr_language": "eng"})
    paddle.assert_not_called()
    baidu.assert_not_called()
    assert calls == ["eng"]
    assert [region["page"] for region in result["review"]["regions"]] == [1, 1]
    warning, = result["warnings"]
    assert (warning["type"], warning["page"]) == ("outline_text", 1)
    assert "可能仍留在导出文件中" in warning["message"]
    processor.export(result["output_path"], "pdf", str(output))
    outline.verify_result(source, output)
    assert source.read_bytes() == before


def test_native_tables_skip_ocr_and_keep_public_rules(processor, tmp_path):
    source = tmp_path / "tables.pdf"
    table_area = fitz.Rect(36, 98, 375, 259)
    with fitz.open() as document:
        for index in range(24):
            page = document.new_page(width=420, height=320)
            page.insert_text((40, 50), "SECRET")
            page.insert_text((55, 121), "PUBLIC CONTROL")
            for top in range(100, 244, 24):
                page.draw_rect(fitz.Rect(42, top, 365, top + 16),
                               color=None, fill=(.9, .9, .9), overlay=False)
            grid = page.new_shape()
            for row in range(132, 255, 20):
                grid.draw_line((42, row), (365, row))
            for col in (42, 152, 232, 365):
                grid.draw_line((col, 100), (col, 252))
            grid.finish(color=(0, 0, 0), width=.7, closePath=False)
            grid.commit()
            page.set_rotation(90 if index % 2 else 0)
        document.save(source)
    with patch.object(processor, "_get_page_ocr_data") as ocr:
        result = processor.desensitize(str(source), ["SECRET"])
    ocr.assert_not_called()
    assert not result.get("warnings")
    assert len(result["review"]["regions"]) == 24
    with fitz.open(source) as before, fitz.open(result["output_path"]) as after:
        for original, output in zip(before, after):
            assert output.rotation == original.rotation and output.cropbox == original.cropbox
            assert "PUBLIC CONTROL" in output.get_text() and "SECRET" not in output.get_text()
            clip = table_area * original.rotation_matrix
            assert original.get_pixmap(clip=clip).samples == output.get_pixmap(clip=clip).samples


@pytest.mark.parametrize("grouped", [False, True])
def test_compact_fills_enter_local_outline_review(processor, grouped):
    with fitz.open() as document:
        page = document.new_page(width=420, height=320)
        page.insert_text((40, 50), "Ink swatches")
        swatches = [fitz.Rect(x, y, x + 8, y + 8) for y in (88, 102) for x in (40, 54, 68, 82)]
        if grouped:
            shape = page.new_shape()
            for swatch in swatches:
                shape.draw_rect(swatch)
            shape.finish(color=None, fill=(.2, .3, .4))
            shape.commit()
        else:
            for swatch in swatches:
                page.draw_rect(swatch, color=None, fill=(.2, .3, .4))

        tokens = {"tokens": []}
        with patch.object(processor, "_get_page_ocr_data", return_value=tokens) as ocr:
            data, warning = processor._get_outline_ocr_data(page, normalize_settings(None))

        ocr.assert_called_once()
        assert data is tokens
        assert warning is not None
        assert (warning["type"], warning["page"]) == ("outline_text", 1)


def test_out_of_budget_outline_page_keeps_an_explicit_warning(processor, tmp_path, monkeypatch):
    source = tmp_path / "outline.pdf"
    outline.generate(source, rotation=90)
    monkeypatch.setattr("pdf_processor.MAX_OUTLINE_OCR_PIXELS", 1)
    with patch.object(processor, "_get_page_ocr_data") as ocr:
        result = processor.desensitize(str(source), ["SECRET"])
    ocr.assert_not_called()
    assert len(result["review"]["regions"]) == 1
    warning, = result["warnings"]
    assert warning["type"] == "outline_text" and warning["page"] == 1
    assert "超出" in warning["message"]
    with fitz.open(result["output_path"]) as output:
        assert output[0].rotation == 90
