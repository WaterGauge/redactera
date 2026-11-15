"""CR-010: conservative OCR continuation in page reading order."""
from pathlib import Path
from unittest.mock import patch
from unittest.mock import Mock

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor, normalize_settings


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


def tokens(source="local", inferred=False, parts=("SEC", "RET")):
    return [{"text": text, "x": 40, "y": 50 + i * 30, "w": 60, "h": 20,
             "line_id": f"line-{i}", "block_id": "" if inferred else "paragraph",
             "source": source, "coarse": source == "paddle"} for i, text in enumerate(parts)]


def find(processor, values, scope="normal", enabled=False, sx=1, sy=1):
    return processor._find_ocr_rects_with_warnings(
        values, "SECRET", 500, 500, sx,
        normalize_settings({"redaction_scope": scope, "fuzzy_match_enabled": enabled,
                            "fuzzy_match_threshold": 1}), scale_y_to_pdf=sy)


@pytest.mark.parametrize("source", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("scope", ["strict", "normal", "loose", "line", "paragraph"])
@pytest.mark.parametrize("inferred", [False, True])
@pytest.mark.parametrize("parts", [("SEC", "RET"), ("SE", "CR", "ET")])
@pytest.mark.parametrize("enabled", [False, True])
def test_exact_cross_line_matrix(processor, source, scope, inferred, parts, enabled):
    values = tokens(source, inferred, parts)
    rects, warnings = find(processor, values, scope, enabled)
    if scope == "strict":
        assert rects == [] and warnings == []
        return
    assert rects
    assert any("跨" in entry["message"] and entry["lines"] == list(parts) for entry in warnings)
    if scope != "paragraph":
        assert len(rects) == len(parts)
        assert all(rect.height < 25 for rect in rects)


@pytest.mark.parametrize("variant", ["block", "column", "gap", "backward", "overlap",
                                     "intervening", "repeated_line", "token_order", "invalid"])
def test_does_not_join_unsafe_or_nonadjacent_lines(processor, variant):
    values = tokens()
    if variant == "block":
        values[1]["block_id"] = "other-paragraph"
    elif variant == "column":
        values[1]["x"] = 250
    elif variant == "gap":
        values[1]["y"] = 150
    elif variant == "backward":
        values.reverse()
    elif variant == "overlap":
        values[1]["y"] = 52
    elif variant == "intervening":
        middle = {**values[0], "text": "PUBLIC", "y": 80, "line_id": "middle"}
        values[1]["y"] = 110
        values.insert(1, middle)
    elif variant == "repeated_line":
        values.append({**values[0], "text": "EXTRA", "y": 110})
    elif variant == "token_order":
        values.insert(0, {**values[0], "text": "PUBLIC", "x": 120})
    else:
        values[1]["h"] = 0
    rects, warnings = find(processor, values)
    assert not rects and not warnings


@pytest.mark.parametrize("sx,sy", [(1, 1), (0.5, 2), (2, 0.5)])
def test_returns_separate_scaled_line_rectangles(processor, sx, sy):
    rects, _ = find(processor, tokens(), sx=sx, sy=sy)
    assert len(rects) == 2
    assert tuple(rects[0]) == pytest.approx((40*sx-2, 50*sy-2, 100*sx+2, 70*sy+2))
    assert tuple(rects[1]) == pytest.approx((40*sx-2, 80*sy-2, 100*sx+2, 100*sy+2))


def test_baidu_line_only_response_can_use_geometric_continuation(processor):
    response = Mock(status_code=200)
    response.json.return_value = {"words_result": [
        {"words": "SEC", "location": {"left": 40, "top": 50, "width": 60, "height": 20}},
        {"words": "RET", "location": {"left": 40, "top": 80, "width": 60, "height": 20}},
    ]}
    with fitz.open() as doc, patch.object(processor, "_get_baidu_token", return_value="synthetic"), \
            patch("pdf_processor.requests.post", return_value=response), patch("pdf_processor.time.sleep"):
        page = doc.new_page()
        data = processor._get_page_ocr_data_baidu(page, "synthetic", "synthetic", dpi=72)
    rects, warnings = find(processor, data["tokens"])
    assert len(rects) == 2 and any("跨" in w["message"] for w in warnings)


@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
def test_separate_pages_cannot_form_one_keyword(processor, tmp_path, mode):
    source = tmp_path / "two-pages.pdf"
    with fitz.open() as text:
        p = text.new_page(); p.insert_text((40, 70), "PUBLIC")
        png = p.get_pixmap(dpi=72).tobytes("png")
        with fitz.open() as doc:
            for _ in range(2):
                page = doc.new_page(); page.insert_image(page.rect, stream=png)
            doc.save(source)
    pages = [{"tokens": tokens(mode, parts=(part,)), "img_w": 595, "img_h": 842, "scale_to_pdf": 1}
             for part in ["SEC", "RET"]]
    with patch.object(processor, "_get_page_ocr_data_by_mode", side_effect=lambda page, *_args: pages[page.number]), \
            patch.object(processor, "_fetch_paddle_all_pages", return_value=pages):
        result = processor.desensitize(str(source), ["SECRET"], {"ocr_mode": mode,
            "paddle_api_url": "https://8.8.8.8", "paddle_token": "synthetic",
            "baidu_api_key": "synthetic", "baidu_secret_key": "synthetic"})
    assert len(result["warnings"]) == 1
    assert result["warnings"][0]["type"] == "no_match"
    assert result["warnings"][0]["keyword"] == "SECRET"
    assert result["warnings"][0]["page"] is None
    with fitz.open(source) as before, fitz.open(result["output_path"]) as after:
        for i in range(2):
            assert before[i].get_pixmap().samples == after[i].get_pixmap().samples


def make_scan(file):
    with fitz.open() as text:
        p = text.new_page(width=500, height=300)
        p.insert_text((40, 80), "SEC", fontsize=14)
        p.insert_text((40, 112), "RET", fontsize=14)
        p.insert_text((220, 96), "PUBLIC", fontsize=14)
        pieces = [p.search_for(word)[0] for word in ["SEC", "RET"]]
        public = p.search_for("PUBLIC")[0]
        png = p.get_pixmap(dpi=72, alpha=False).tobytes("png")
        with fitz.open() as doc:
            p = doc.new_page(width=500, height=300)
            p.insert_image(p.rect, stream=png)
            doc.save(file)
    return pieces, public


@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("scope", ["strict", "normal", "loose", "line", "paragraph"])
def test_actual_scan_redaction_preserves_public_pixels_and_original(processor, tmp_path, mode, scope):
    original = tmp_path / "original.pdf"
    pieces, public = make_scan(original)
    source_bytes = original.read_bytes()
    values = [{"text": word, "x": rect.x0, "y": rect.y0, "w": rect.width, "h": rect.height,
               "line_id": f"line-{i}", "block_id": "same", "source": mode,
               "coarse": mode == "paddle"} for i, (word, rect) in enumerate(zip(["SEC", "RET"], pieces))]
    data = {"tokens": values, "scale_to_pdf": 1, "scale_y_to_pdf": 1, "img_w": 500, "img_h": 300}
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value=data), \
            patch.object(processor, "_fetch_paddle_all_pages", return_value=[data]):
        result = processor.desensitize(str(original), ["SECRET"], {
            "ocr_mode": mode, "redaction_scope": scope, "paddle_api_url": "https://8.8.8.8",
            "paddle_token": "synthetic", "baidu_api_key": "synthetic", "baidu_secret_key": "synthetic"})
    with fitz.open(result["output_path"]) as after, fitz.open(original) as before:
        assert after[0].get_pixmap(dpi=72, alpha=False, clip=public).samples == before[0].get_pixmap(dpi=72, alpha=False, clip=public).samples
        for rect in pieces:
            pixels = after[0].get_pixmap(dpi=72, alpha=False, clip=rect).samples
            assert (set(pixels) == {0}) == (scope != "strict")
        if scope not in ("strict", "paragraph"):
            gap = fitz.Rect(40, pieces[0].y1 + 3, 70, pieces[1].y0 - 3)
            assert after[0].get_pixmap(dpi=72, alpha=False, clip=gap).samples == before[0].get_pixmap(dpi=72, alpha=False, clip=gap).samples
        if scope != "strict":
            assert any(w["page"] == 1 and "跨" in w["message"] for w in result["warnings"])
    assert original.read_bytes() == source_bytes
    assert Path(result["output_path"]).exists()
