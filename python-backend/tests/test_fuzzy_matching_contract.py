"""CR-009: matching preference is independent of redaction coverage."""
import math
from pathlib import Path

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor, normalize_settings

SCOPES = ["strict", "normal", "loose", "line", "paragraph"]


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


def find(processor, layer, word, scope, enabled, threshold=0.7):
    settings = normalize_settings({"redaction_scope": scope, "fuzzy_match_enabled": enabled,
                                   "fuzzy_match_threshold": threshold})
    if layer == "text":
        with fitz.open() as doc:
            page = doc.new_page(width=500, height=400)
            page.insert_text((40, 70), word, fontsize=14)
            return processor._find_text_rects(page, "SECRET", settings)[0]
    return processor._find_ocr_rects_with_warnings(
        [{"text": word, "x": 40, "y": 55, "w": 80, "h": 20,
          "line_id": "a", "block_id": "a"}],
        "SECRET", 400, 500, 1, settings)[0]


@pytest.mark.parametrize("layer", ["text", "ocr"])
@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("word,expected", [("SECRET", True), ("SECRE7", None), ("UVWXYZ", False)])
def test_scope_switch_matrix(processor, layer, scope, enabled, word, expected):
    assert bool(find(processor, layer, word, scope, enabled)) == (enabled if expected is None else expected)


@pytest.mark.parametrize("layer", ["text", "ocr"])
@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("threshold,expected", [
    (10 / 11, True), (math.nextafter(10 / 11, 1), False), (1, False)
])
def test_actual_window_similarity_threshold_is_inclusive(processor, layer, scope, threshold, expected):
    # SECRE (length 5) is the closest existing window to SECRET: ratio 10/11.
    assert bool(find(processor, layer, "SECRE7", scope, True, threshold)) == expected


@pytest.mark.parametrize("layer", ["text", "ocr"])
@pytest.mark.parametrize("scope", ["strict", "normal", "loose"])
def test_approximate_matching_does_not_join_public_next_line(processor, layer, scope):
    settings = normalize_settings({"redaction_scope": scope, "fuzzy_match_enabled": True})
    if layer == "text":
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((40, 70), "SECRE7", fontsize=14)
            page.insert_text((40, 96), "PUBLIC", fontsize=14)
            public = page.search_for("PUBLIC")[0]
            rects = processor._find_text_rects(page, "SECRET", settings)[0]
    else:
        public = fitz.Rect(40, 90, 100, 110)
        tokens = [{"text": "SECRE7", "x": 40, "y": 55, "w": 80, "h": 20, "line_id": "a"},
                  {"text": "PUBLIC", "x": 40, "y": 90, "w": 60, "h": 20, "line_id": "b"}]
        rects = processor._find_ocr_rects_with_warnings(tokens, "SECRET", 400, 500, 1, settings)[0]
    assert rects
    assert not any(rect.intersects(public) for rect in rects)


@pytest.mark.parametrize("scope", SCOPES)
def test_strict_ocr_keeps_single_token_boundary(processor, scope):
    settings = normalize_settings({"redaction_scope": scope, "fuzzy_match_enabled": True})
    tokens = [{"text": "SEC", "x": 40, "y": 55, "w": 30, "h": 20, "line_id": "a"},
              {"text": "RE7", "x": 70, "y": 55, "w": 30, "h": 20, "line_id": "a"}]
    rects = processor._find_ocr_rects_with_warnings(tokens, "SECRET", 400, 500, 1, settings)[0]
    assert bool(rects) == (scope != "strict")


@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("enabled", [False, True])
def test_real_text_redaction_and_original_preserved(processor, tmp_path, scope, enabled):
    source = tmp_path / "original.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), "SECRE7", fontsize=14)
        page.insert_text((40, 250), "PUBLIC", fontsize=14)
        doc.save(source)
    original = source.read_bytes()
    result = processor.desensitize(str(source), ["SECRET"], {
        "redaction_scope": scope, "fuzzy_match_enabled": enabled})
    with fitz.open(result["output_path"]) as doc:
        assert ("SECRE7" not in doc[0].get_text()) == enabled
        assert "PUBLIC" in doc[0].get_text()
    assert source.read_bytes() == original
    assert Path(result["output_path"]).is_file()
