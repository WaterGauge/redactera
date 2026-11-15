"""R2-MATCH-004: short terms stay exact and match provenance survives into review."""
from pathlib import Path

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor, normalize_settings


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


@pytest.mark.parametrize("layer", ["text", "ocr"])
@pytest.mark.parametrize("keyword,candidate", [
    ("张三", "张某三"), ("李明", "李小明"), ("ID", "IXD"),
    ("AB", "AXB"), ("张三丰", "张三"), ("ABC", "AB"), ("A12", "A2"),
])
def test_short_keyword_false_positive_goldens(processor, layer, keyword, candidate):
    settings = normalize_settings({"fuzzy_match_enabled": True, "fuzzy_match_threshold": 0.7})
    if layer == "text":
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((40, 70), candidate, fontname="china-s", fontsize=14)
            rects = processor._find_text_rects(page, keyword, settings)[0]
    else:
        rects = processor._find_ocr_rects_with_warnings([
            {"text": candidate, "x": 40, "y": 55, "w": 100, "h": 20,
             "line_id": "l", "block_id": "b"}],
            keyword, 400, 500, 1, settings)[0]
    assert not rects


@pytest.mark.parametrize("layer", ["text", "ocr"])
@pytest.mark.parametrize("keyword,candidate", [
    ("张三", "张三"), ("ABC", "ABC"), ("X", "X"),
    ("SECRET", "SECRE7"), ("王小明甲", "王小明乙"),
])
def test_exact_short_and_intended_long_matches_remain(processor, layer, keyword, candidate):
    settings = normalize_settings({"fuzzy_match_enabled": True})
    if layer == "text":
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((40, 70), candidate, fontname="china-s", fontsize=14)
            rects = processor._find_text_rects(page, keyword, settings)[0]
    else:
        rects = processor._find_ocr_rects_with_warnings([
            {"text": candidate, "x": 40, "y": 55, "w": 100, "h": 20,
             "line_id": "l", "block_id": "b"}],
            keyword, 400, 500, 1, settings)[0]
    assert rects


def test_approximate_ranges_do_not_expand_a_known_exact_occurrence(processor):
    assert list(processor._iter_approximate_ranges("PUBLIC SECRET PUBLIC", "SECRET", 0.7)) == []


@pytest.mark.parametrize("scope", ["normal", "line"])
def test_final_masks_preserve_match_kind_per_keyword(processor, tmp_path, scope):
    source = tmp_path / "original.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), "SECRET", fontsize=14)
        page.insert_text((40, 110), "SECRE7", fontsize=14)
        page.insert_text((40, 250), "PUBLIC", fontsize=14)
        doc.save(source)
    original = source.read_bytes()
    result = processor.desensitize(str(source), ["SECRET", "SECRE7"], {
        "fuzzy_match_enabled": True, "redaction_scope": scope,
    })
    regions = sorted(result["review"]["regions"], key=lambda item: item["polygon"][0][1])
    assert len(regions) == 2
    assert regions[0]["matchKinds"] == {"SECRET": "exact", "SECRE7": "approximate"}
    assert regions[1]["matchKinds"] == {"SECRET": "approximate", "SECRE7": "exact"}
    with fitz.open(result["output_path"]) as final:
        text = final[0].get_text()
        assert "SECRET" not in text and "SECRE7" not in text
        assert "PUBLIC" in text
    assert source.read_bytes() == original
    assert Path(result["output_path"]).is_file()

@pytest.mark.parametrize("scope", ["strict", "normal"])
def test_normalized_same_line_exact_does_not_get_lost_when_fuzzy_overlap_is_skipped(processor, tmp_path, scope):
    source = tmp_path / "spaced.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), "AB CD", fontsize=14)
        doc.save(source)
    result = processor.desensitize(str(source), ["ABCD"], {
        "fuzzy_match_enabled": True, "redaction_scope": scope,
    })
    assert result["review"]["regions"][0]["matchKinds"] == {"ABCD": "exact"}
    with fitz.open(result["output_path"]) as final:
        assert "AB" not in final[0].get_text() and "CD" not in final[0].get_text()


def test_expanded_line_records_both_methods_for_the_same_keyword(processor, tmp_path):
    source = tmp_path / "mixed-method.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), "SECRET SECRE7", fontsize=14)
        doc.save(source)
    result = processor.desensitize(str(source), ["SECRET"], {
        "fuzzy_match_enabled": True, "redaction_scope": "line",
    })
    assert len(result["review"]["regions"]) == 1
    assert result["review"]["regions"][0]["matchKinds"] == {"SECRET": "mixed"}


def test_ocr_metadata_uses_actual_method_with_scaled_final_boxes(processor):
    details = []
    rects, _ = processor._find_ocr_rects_with_warnings([
        {"text": "SECRET", "x": 40, "y": 55, "w": 100, "h": 20, "line_id": "l1", "block_id": "b"},
        {"text": "SECRE7", "x": 40, "y": 150, "w": 100, "h": 20, "line_id": "l2", "block_id": "b"},
    ], "SECRET", 400, 500, 0.5, normalize_settings({"fuzzy_match_enabled": True}),
        scale_y_to_pdf=0.75, match_details=details)
    assert rects and {method for _, method in details} == {False, True}
    assert all(any(rect.contains(candidate) for rect in rects) for candidate, _ in details)


@pytest.mark.parametrize("kinds", [None, [], {"OTHER": "exact"}, {"SECRET": "unknown"}])
def test_final_report_rejects_invalid_match_kind_extensions(processor, tmp_path, kinds):
    source = tmp_path / "validation.pdf"
    with fitz.open() as doc:
        doc.new_page().insert_text((40, 70), "SECRET")
        doc.save(source)
    result = processor.desensitize(str(source), ["SECRET"], {})
    result["review"]["regions"][0]["matchKinds"] = kinds
    with pytest.raises(ValueError, match="输出文件检查未通过"):
        processor._validate_final_output(result["output_path"], result["review"])
