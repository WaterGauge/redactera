"""Rendered-output regressions for CR-002, independent of OCR accuracy."""

import io
import math
import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pymupdf as fitz
import pytest
from PIL import Image

from pdf_processor import PDFProcessor

ROTATIONS = [0, 90, 180, 270]
SCOPES = ["strict", "normal", "loose", "line", "paragraph"]


@pytest.fixture
def processor():
    instance = PDFProcessor()
    yield instance
    instance.cleanup()


def new_page(document, cropped):
    page = document.new_page(width=720 if cropped else 600, height=500 if cropped else 400)
    if cropped:
        page.set_cropbox(fitz.Rect(60, 40, 660, 440))
    return page


def make_source(path, rotation, cropped, raster=False, keyword="SECRET", user_unit=1):
    with fitz.open() as text:
        page = new_page(text, cropped)
        # Asymmetric positions close to three edges prevent a wrong rotation
        # from accidentally covering a second occurrence at a symmetric point.
        for point in [(1, 22), (526, 94), (415, 394)]:
            page.insert_text(point, keyword, fontsize=18)
        page.insert_text((250, 220), "PUBLIC", fontsize=18)
        secret_rects = page.search_for(keyword)
        public_rect = page.search_for("PUBLIC")[0]
        assert len(secret_rects) == 3
        if raster:
            image = page.get_pixmap(dpi=72, alpha=False).tobytes("png")
            with fitz.open() as scan:
                target = new_page(scan, cropped)
                target.insert_image(target.rect, stream=image)
                scan.xref_set_key(target.xref, "UserUnit", str(user_unit))
                target = scan.reload_page(target)
                target.set_rotation(rotation)
                scan.save(path)
        else:
            text.xref_set_key(page.xref, "UserUnit", str(user_unit))
            page = text.reload_page(page)
            page.set_rotation(rotation)
            text.save(path)
    scale = fitz.Matrix(user_unit, user_unit)
    return [rect * scale for rect in secret_rects], public_rect * scale


def display_rect(rect, rotation, user_unit):
    # Independent fixture oracle. PyMuPDF 1.24.14's own rotation matrices
    # omit UserUnit from their translation, so they cannot be our test oracle.
    width, height = 600 * user_unit, 400 * user_unit
    if rotation == 90:
        return fitz.Rect(height - rect.y1, rect.x0, height - rect.y0, rect.x1)
    if rotation == 180:
        return fitz.Rect(width - rect.x1, height - rect.y1, width - rect.x0, height - rect.y0)
    if rotation == 270:
        return fitz.Rect(rect.y0, width - rect.x1, rect.y1, width - rect.x0)
    return rect


def visible_pixels(page, rect):
    return page.get_pixmap(dpi=72, alpha=False, clip=rect).samples


def assert_scan_objects_cleared(paths, secret_rects, user_unit):
    # A correctly positioned black overlay is insufficient: also inspect every
    # stored image, including objects no longer referenced by the visible page.
    for path in paths:
        with fitz.open(path) as document:
            images = [xref for xref in range(1, document.xref_length())
                      if document.xref_get_key(xref, "Subtype") == ("name", "/Image")]
            assert images
            for xref in images:
                pix = fitz.Pixmap(document, xref)
                assert (pix.width, pix.height) == (600, 400)
                samples = pix.samples
                for rect in secret_rects:
                    box = rect * fitz.Matrix(1 / user_unit, 1 / user_unit)
                    x0, y0, x1, y1 = box.irect
                    region = b"".join(samples[y * pix.stride + x0 * pix.n:
                                              y * pix.stride + x1 * pix.n]
                                      for y in range(y0, y1))
                    assert region == region[:pix.n] * (len(region) // pix.n)


def outputs(processor, source, tmp_path, settings):
    result = processor.desensitize(str(source), ["SECRET"], settings)
    output = Path(result["output_path"])
    exported = tmp_path / "exported.pdf"
    processor.export(str(output), "pdf", str(exported))
    return [output, exported], result


def assert_redacted(paths, source, secret_rects, public_rect, rotation, user_unit):
    with fitz.open(source) as before:
        page = before[0]
        display_secrets = [display_rect(rect, rotation, user_unit) for rect in secret_rects]
        display_public = display_rect(public_rect, rotation, user_unit)
        public_pixels = visible_pixels(page, display_public)
        assert min(public_pixels) < 255
        for rect in display_secrets:
            # Ensure the pixel oracle actually observes the input letters.
            values = visible_pixels(page, rect)
            assert min(values) < 255 and max(values) > 0
        bounds, cropbox = page.rect, page.cropbox

    for path in paths:
        with fitz.open(path) as document:
            assert len(document) == 1
            page = document[0]
            assert page.rotation == rotation
            assert page.rect == bounds
            assert page.cropbox == cropbox
            assert "SECRET" not in page.get_text()
            for rect in display_secrets:
                assert set(visible_pixels(page, rect)) == {0}
            assert visible_pixels(page, display_public) == public_pixels


@pytest.mark.parametrize("rotation", ROTATIONS)
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_rotated_text_redacts_in_unrotated_pdf_space(
    processor, tmp_path, rotation, cropped, scope, user_unit
):
    source = tmp_path / "source.pdf"
    secret_rects, public_rect = make_source(source, rotation, cropped, user_unit=user_unit)
    original = source.read_bytes()
    paths, _ = outputs(processor, source, tmp_path, {
        "redaction_scope": scope, "fuzzy_match_threshold": 1.0,
    })
    assert_redacted(paths, source, secret_rects, public_rect, rotation, user_unit)
    with fitz.open(paths[0]) as document:
        assert "PUBLIC" in document[0].get_text()
    assert source.read_bytes() == original


@contextmanager
def known_ocr(processor, source, secret_rects, public_rect, mode, rotation, user_unit):
    with fitz.open(source) as document:
        page = document[0]
        rendered = page.get_pixmap(dpi=150, alpha=False)
        expected_size = (rendered.width, rendered.height)
        pixel_rects = [
            display_rect(rect, rotation, user_unit) * fitz.Matrix(150 / 72, 150 / 72)
            for rect in [*secret_rects, public_rect]
        ]
    words = ["SECRET"] * len(secret_rects) + ["PUBLIC"]
    boxes = [{"left": math.floor(r.x0), "top": math.floor(r.y0),
              "width": math.ceil(r.x1) - math.floor(r.x0),
              "height": math.ceil(r.y1) - math.floor(r.y0)} for r in pixel_rects]
    local_data = {"text": words, "conf": [99] * len(words),
                  "block_num": list(range(1, len(words) + 1)),
                  "par_num": [1] * len(words), "line_num": [1] * len(words)}
    for key in ("left", "top", "width", "height"):
        local_data[key] = [box[key] for box in boxes]

    def local_result(png, *args, **kwargs):
        with Image.open(io.BytesIO(png)) as image:
            assert image.size == expected_size
        return local_data

    response = Mock(status_code=200)
    response.json.return_value = {"words_result": [
        {"words": word, "location": box} for word, box in zip(words, boxes)
    ]}
    paddle_tokens = [
        {"text": "ACCOUNT SECRET" if word == "SECRET" else word,
         "x": box["left"], "y": box["top"], "w": box["width"], "h": box["height"],
         "line_id": f"line-{i}", "block_id": f"block-{i}",
         "source": "paddle", "coarse": True}
        for i, (word, box) in enumerate(zip(words, boxes))
    ]
    with patch("pdf_processor.read_ocr_data", side_effect=local_result), \
            patch.object(processor, "_get_baidu_token", return_value="synthetic-token"), \
            patch("pdf_processor.requests.post", return_value=response), \
            patch("pdf_processor.requests.get", side_effect=AssertionError("Network disabled")), \
            patch("pdf_processor.time.sleep"), \
            patch.object(processor, "_fetch_paddle_all_pages", return_value=[{
                "tokens": paddle_tokens, "img_w": expected_size[0], "img_h": expected_size[1],
            }]):
        yield


@pytest.mark.parametrize("rotation", ROTATIONS)
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("scope", SCOPES)
@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_rotated_scan_redacts_rendered_ocr_coordinates(
    processor, tmp_path, rotation, cropped, scope, mode, user_unit
):
    source = tmp_path / "scan.pdf"
    secret_rects, public_rect = make_source(source, rotation, cropped, raster=True, user_unit=user_unit)
    original = source.read_bytes()
    settings = {"ocr_mode": mode, "redaction_scope": scope, "export_dpi": 150,
                "fuzzy_match_threshold": 1.0, "baidu_api_key": "synthetic",
                "baidu_secret_key": "synthetic", "paddle_api_url": "https://8.8.8.8",
                "paddle_token": "synthetic"}
    with known_ocr(processor, source, secret_rects, public_rect, mode, rotation, user_unit):
        paths, result = outputs(processor, source, tmp_path, settings)
    assert_redacted(paths, source, secret_rects, public_rect, rotation, user_unit)
    assert_scan_objects_cleared(paths, secret_rects, user_unit)
    if mode == "paddle":
        # Existing loose matching may emit duplicate exact/approximate warnings;
        # require every coarse region without changing that separate behavior.
        coarse = [warning for warning in result["warnings"] if warning["type"] == "coarse_location"]
        assert {region["id"] for warning in coarse for region in warning["affectedRegions"]} == {
            f"{'block' if scope == 'paragraph' else 'line'}-{i}" for i in range(3)}
        assert all(warning["lines"] == ["ACCOUNT SECRET"] for warning in coarse)
        assert all(warning["page"] == 1 for warning in result["warnings"])
    assert source.read_bytes() == original


@pytest.mark.parametrize("rotation", ROTATIONS)
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_no_match_preserves_rotated_page(processor, tmp_path, rotation, cropped, user_unit):
    source = tmp_path / "public.pdf"
    make_source(source, rotation, cropped, keyword="OPEN", user_unit=user_unit)
    original = source.read_bytes()
    with fitz.open(source) as document:
        before = document[0].get_pixmap(dpi=72, alpha=False).samples
        cropbox = document[0].cropbox
    paths, _ = outputs(processor, source, tmp_path, {})
    for path in paths:
        with fitz.open(path) as document:
            assert document[0].rotation == rotation
            assert document[0].cropbox == cropbox
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == before
    assert source.read_bytes() == original


@pytest.mark.parametrize("width,height", [
    (None, 400), (600, None), (0, 400), (600, 0),
    (-600, 400), (600, -400), (float("inf"), 400), (600, float("nan")),
])
def test_paddle_rejects_dimensions_that_cannot_map_to_the_page(
    processor, tmp_path, width, height
):
    source = tmp_path / "scan.pdf"
    make_source(source, 90, True, raster=True)
    original = source.read_bytes()
    with patch.object(processor, "_fetch_paddle_all_pages", return_value=[{
        "tokens": [], "img_w": width, "img_h": height,
    }]):
        with pytest.raises(ValueError, match="invalid page image dimensions"):
            processor.desensitize(str(source), ["SECRET"], {
                "ocr_mode": "paddle", "paddle_api_url": "https://8.8.8.8",
                "paddle_token": "synthetic",
            })
    assert source.read_bytes() == original


def test_apply_failure_restores_original_rotation(processor, tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    make_source(source, 270, True)
    original = source.read_bytes()
    restored = []
    real_set_rotation = fitz.Page.set_rotation

    def track_rotation(page, rotation):
        real_set_rotation(page, rotation)
        restored.append(page.rotation)

    def fail_apply(page, *args, **kwargs):
        assert page.rotation == 0
        raise RuntimeError("synthetic application failure")

    monkeypatch.setattr(fitz.Page, "set_rotation", track_rotation)
    monkeypatch.setattr(fitz.Page, "apply_redactions", fail_apply)
    with pytest.raises(RuntimeError, match="synthetic application failure"):
        processor.desensitize(str(source), ["SECRET"])
    assert restored[-1] == 270
    assert source.read_bytes() == original


@pytest.mark.parametrize("metadata,accepted", [
    ({}, True),
    ({"doc_preprocessor_res": {"angle": -1, "model_settings": {}}}, True),
    ({"doc_preprocessor_res": {"angle": 0, "model_settings": {
        "use_doc_orientation_classify": True, "use_doc_unwarping": False}}}, True),
    ({"doc_preprocessor_res": {"angle": 90}}, False),
    ({"doc_preprocessor_res": {"angle": 180}}, False),
    ({"doc_preprocessor_res": {"angle": 270}}, False),
    ({"doc_preprocessor_res": {"angle": 0, "model_settings": {"use_doc_unwarping": True}}}, False),
    ({"doc_preprocessor_res": {"model_settings": {"use_doc_orientation_classify": True}}}, False),
    ({"model_settings": {"use_doc_preprocessor": True}}, False),
])
def test_paddle_keeps_original_coordinate_frame(processor, tmp_path, metadata, accepted):
    source = tmp_path / "scan.pdf"
    make_source(source, 90, True, raster=True)
    submitted = Mock(status_code=200)
    submitted.json.return_value = {"data": {"jobId": "synthetic-job"}}
    polled = Mock()
    polled.json.return_value = {"data": {"state": "done", "resultUrl": {
        "jsonUrl": "https://result.example.test/result.jsonl",
    }}}
    result = Mock()
    result.text = json.dumps({"result": {"layoutParsingResults": [{"prunedResult": {
        "width": 834, "height": 1250, "parsing_res_list": [], **metadata,
    }}]}})
    with patch("pdf_processor.paddle_request", side_effect=[submitted, polled, result]) as post, \
            patch("pdf_processor.time.sleep"):
        if accepted:
            pages = processor._fetch_paddle_all_pages(str(source), "https://8.8.8.8", "synthetic")
            assert pages[0]["img_w"] == 834
            assert pages[0]["img_h"] == 1250
        else:
            with pytest.raises(RuntimeError, match="transformed page coordinates"):
                processor._fetch_paddle_all_pages(str(source), "https://8.8.8.8", "synthetic")
    options = json.loads(post.call_args_list[0].kwargs["data"]["optionalPayload"])
    assert options == {"useDocOrientationClassify": False, "useDocUnwarping": False}
