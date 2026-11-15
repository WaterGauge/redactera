"""User-visible warning semantics, using deterministic OCR data and real PDFs."""
import io

import pymupdf as fitz
import pytest
from PIL import Image

from pdf_processor import PDFProcessor, normalize_settings


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


def cross_tokens(source="local"):
    return [
        {"text": part, "x": 20, "y": 20 + i * 15, "w": 45, "h": 12,
         "line_id": f"internal-{i}", "block_id": "block", "source": source}
        for i, part in enumerate(["SEC", "RET"])
    ]


def assert_contract(warning, kind):
    assert warning["type"] == kind
    assert warning["message"] and warning["reason"] and warning["suggestedAction"]
    assert isinstance(warning["affectedRegions"], list)


@pytest.mark.parametrize("scope", ["normal", "loose", "line", "paragraph"])
def test_text_cross_line_has_a_typed_readable_explanation(processor, scope):
    with fitz.open() as document:
        page = document.new_page(width=200, height=200)
        page.insert_text((20, 40), "SEC\nRET", fontsize=12)
        rects, warnings = processor._find_text_rects(page, "SECRET", normalize_settings({"redaction_scope": scope}))
    assert rects and warnings
    for warning in warnings:
        assert_contract(warning, "cross_line")
        assert warning["lines"] == ["SEC", "RET"]
        assert [region["text"] for region in warning["affectedRegions"]] == ["SEC", "RET"]
        assert "整行" not in warning["message"]  # Normal scope does not promise a whole line.


@pytest.mark.parametrize("source", ["local", "baidu", "paddle"])
def test_ocr_cross_line_keeps_real_text_and_type(processor, source):
    rects, warnings = processor._find_ocr_rects_with_warnings(
        cross_tokens(source), "SECRET", 200, 200, 1, normalize_settings({}))
    assert rects
    cross = [w for w in warnings if w.get("type") == "cross_line"]
    assert len(cross) == 1
    assert_contract(cross[0], "cross_line")
    assert cross[0]["lines"] == ["SEC", "RET"]


@pytest.mark.parametrize("scope", ["strict", "normal", "loose", "line", "paragraph"])
def test_paddle_fallback_does_not_call_line_ids_text(processor, scope):
    tokens = [{"text": "prefix SECRET suffix", "x": 20, "y": 20, "w": 140, "h": 12,
               "line_id": "opaque-line-999", "block_id": "opaque-block", "source": "paddle", "coarse": True}]
    rects, warnings = processor._find_ocr_rects_with_warnings(
        tokens, "SECRET", 200, 200, 1, normalize_settings({"redaction_scope": scope}))
    assert rects and len(warnings) == 1
    warning = warnings[0]
    assert_contract(warning, "coarse_location")
    assert warning["lines"] == ["prefix SECRET suffix"]
    assert all("opaque" not in region["text"] for region in warning["affectedRegions"])
    assert warning["affectedRegions"][0]["kind"] == ("block" if scope == "paragraph" else "line")


def scanned_file(tmp_path):
    image = io.BytesIO()
    Image.new("RGB", (200, 200), "white").save(image, format="PNG")
    source = tmp_path / "scan.pdf"
    with fitz.open() as document:
        page = document.new_page(width=200, height=200)
        page.insert_image(page.rect, stream=image.getvalue())
        document.save(source)
    return source


@pytest.mark.parametrize("score,low,matched", [
    (79.9, True, True), (80, False, True), (95, False, True), (0, True, False),
    (-1, False, False), ("invalid", False, False), (float("nan"), False, False),
    (float("inf"), False, False), (100, False, True),
])
def test_local_ocr_score_warning_is_per_page_not_a_matching_threshold(processor, tmp_path, monkeypatch, score, low, matched):
    source = scanned_file(tmp_path)
    original = source.read_bytes()
    data = {"text": ["SECRET"], "conf": [score], "left": [20], "top": [20], "width": [80], "height": [20],
            "block_num": [1], "par_num": [1], "line_num": [1]}
    monkeypatch.setattr("pdf_processor.read_ocr_data", lambda *a, **k: data)
    result = processor.desensitize(str(source), ["SECRET"], {"export_dpi": 150})
    warnings = result.get("warnings", [])
    low_warnings = [w for w in warnings if w.get("type") == "low_confidence"]
    assert len(low_warnings) == int(low)
    for warning in low_warnings:
        assert_contract(warning, "low_confidence")
        assert warning["page"] == 1
        assert warning["lines"] == ["SECRET"]
    missing = [w for w in warnings if w.get("type") == "no_match"]
    assert bool(missing) is not matched
    assert source.read_bytes() == original


@pytest.mark.parametrize("keywords", [["SECRET", "ABSENT"], ["ABSENT", "ABSENT"]])
def test_no_match_is_reported_once_after_all_pages_and_has_no_fake_page(processor, tmp_path, keywords):
    source = tmp_path / "two-pages.pdf"
    with fitz.open() as document:
        document.new_page().insert_text((20, 40), "PUBLIC")
        document.new_page().insert_text((20, 40), "SECRET")
        document.save(source)
    result = processor.desensitize(str(source), keywords)
    missing = [w for w in result.get("warnings", []) if w.get("type") == "no_match"]
    assert len(missing) == 1
    assert_contract(missing[0], "no_match")
    assert missing[0]["keyword"] == "ABSENT" and missing[0]["page"] is None
    assert missing[0]["affectedRegions"] == [{"kind": "document"}]
