"""CR-003: preserve the text path while inspecting rendered images too."""

import json
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import pytest
import requests

from pdf_processor import PDFProcessor
from .test_redaction_rotation import display_rect, known_ocr, new_page, visible_pixels


@pytest.fixture
def processor():
    instance = PDFProcessor()
    yield instance
    instance.cleanup()


def make_mixed(path, kind="xobject", rotation=0, cropped=False, user_unit=1,
               text_sensitive=False, image_word="SECRET", aligned=False):
    image_rect = fitz.Rect(60, 120, 540, 360)
    with fitz.open() as text:
        page = text.new_page(width=480, height=240)
        page.insert_text((60, 80), image_word, fontsize=18)
        page.insert_text((220, 160), "PUBLIC", fontsize=18)
        secret = page.search_for(image_word)[0]
        public = page.search_for("PUBLIC")[0]
        pix = page.get_pixmap(dpi=72, alpha=False)
        png, raw = pix.tobytes("png"), pix.samples
        with fitz.open() as raster, fitz.open() as document:
            image_page = raster.new_page(width=480, height=240)
            image_page.insert_image(image_page.rect, stream=png)
            target = new_page(document, cropped)
            if kind == "form":
                target.show_pdf_page(image_rect, raster, 0)
            elif kind != "none":
                target.insert_image(image_rect, stream=png)
                if kind in ("inline", "unused"):
                    xref = target.get_contents()[-1]
                    stream = document.xref_stream(xref)
                    name = target.get_images(full=True)[0][7]
                    replacement = b""
                    if kind == "inline":
                        replacement = (b"BI /W 480 /H 240 /CS /RGB /BPC 8 /F /AHx ID\n"
                                       + raw.hex().encode() + b">\nEI\n")
                    document.update_stream(xref, stream.replace(f"/{name} Do".encode(), replacement))
                    if kind == "inline":
                        resources = int(document.xref_get_key(target.xref, "Resources")[1].split()[0])
                        document.xref_set_key(resources, "XObject", "null")
            target.insert_text((30, 30), "PUBLIC HEADER", fontsize=14)
            if text_sensitive:
                target.insert_text((118, 200) if aligned else (100, 80), "SECRET", fontsize=18)
            document.xref_set_key(target.xref, "UserUnit", str(user_unit))
            target = document.reload_page(target)
            target.set_rotation(rotation)
            document.save(path, deflate=True)
    offset = fitz.Matrix(1, 0, 0, 1, image_rect.x0, image_rect.y0)
    scale = fitz.Matrix(user_unit, user_unit)
    return secret * offset * scale, public * offset * scale


def settings(mode, scope="normal"):
    return {"ocr_mode": mode, "redaction_scope": scope, "fuzzy_match_threshold": 1.0,
            "baidu_api_key": "synthetic", "baidu_secret_key": "synthetic",
            "paddle_api_url": "https://8.8.8.8", "paddle_token": "synthetic"}


def check_outputs(paths, source, secret, public, rotation, user_unit):
    with fitz.open(source) as document:
        expected_public = visible_pixels(document[0], display_rect(public, rotation, user_unit))
        cropbox, bounds = document[0].cropbox, document[0].rect
    for path in paths:
        with fitz.open(path) as document:
            page = document[0]
            assert "SECRET" not in page.get_text()
            assert "PUBLIC HEADER" in page.get_text()
            assert set(visible_pixels(page, display_rect(secret, rotation, user_unit))) == {0}
            assert visible_pixels(page, display_rect(public, rotation, user_unit)) == expected_public
            assert page.rotation == rotation and page.cropbox == cropbox and page.rect == bounds
            # Also check stored image pixels; a visible overlay alone is unsafe.
            images = [xref for xref in range(1, document.xref_length())
                      if document.xref_get_key(xref, "Subtype") == ("name", "/Image")]
            assert images
            for xref in images:
                pix = fitz.Pixmap(document, xref)
                assert (pix.width, pix.height) == (480, 240)
                # The fixture's secret image text starts at (60, 80).
                box = (secret * fitz.Matrix(1 / user_unit, 1 / user_unit)
                       * fitz.Matrix(1, 0, 0, 1, -60, -120)).irect
                x0, y0, x1, y1 = box
                data = pix.samples
                region = b"".join(data[y * pix.stride + x0 * pix.n:y * pix.stride + x1 * pix.n]
                                  for y in range(y0, y1))
                assert region == region[:pix.n] * (len(region) // pix.n)


def run_mixed(processor, tmp_path, kind, rotation, cropped, user_unit, text_sensitive,
              mode, scope="normal", aligned=False):
    source = tmp_path / "source.pdf"
    secret, public = make_mixed(source, kind, rotation, cropped, user_unit,
                                text_sensitive=text_sensitive, aligned=aligned)
    original = source.read_bytes()
    with known_ocr(processor, source, [secret], public, mode, rotation, user_unit), \
            patch.object(processor, "_get_page_ocr_data_by_mode",
                         wraps=processor._get_page_ocr_data_by_mode) as ocr:
        result = processor.desensitize(str(source), ["SECRET", "ABSENT"], settings(mode, scope))
    assert ocr.call_count == 1
    output = Path(result["output_path"])
    exported = tmp_path / "exported.pdf"
    processor.export(str(output), "pdf", str(exported))
    check_outputs([output, exported], source, secret, public, rotation, user_unit)
    assert source.read_bytes() == original


@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("alias", ["unused", "drawn"])
@pytest.mark.parametrize("in_form", [False, True])
def test_inline_image_digest_alias_cannot_bypass_safe_failure(processor, tmp_path, mode, alias, in_form):
    seed, source = tmp_path / "seed.pdf", tmp_path / "alias.pdf"
    secret, public = make_mixed(seed, "inline")
    with fitz.open(seed) as document:
        page = document[0]
        image = next(x for x in range(1, document.xref_length())
                     if document.xref_get_key(x, "Subtype") == ("name", "/Image"))
        resources = int(document.xref_get_key(page.xref, "Resources")[1].split()[0])
        document.xref_set_key(resources, "XObject", f"<< /Alias {image} 0 R >>")
        if alias == "drawn":
            xref = page.get_contents()[-1]
            document.update_stream(xref, document.xref_stream(xref)
                                   + b"\nq 10 0 0 10 0 0 cm /Alias Do Q\n")
        if in_form:
            with fitz.open() as outer:
                target = outer.new_page(width=600, height=400)
                target.show_pdf_page(target.rect, document, 0)
                outer.save(source)
        else:
            document.save(source)
    with fitz.open(source) as document:
        # get_image_info associates by digest, so even the inline occurrence
        # inherits a positive xref. This is not evidence of its storage type.
        assert all(info["xref"] > 0 for info in document[0].get_image_info(xrefs=True))
    original = source.read_bytes()
    with known_ocr(processor, source, [secret], public, mode, 0, 1):
        with pytest.raises(RuntimeError, match="无法安全.*局部"):
            processor.desensitize(str(source), ["SECRET"], settings(mode))
    assert source.read_bytes() == original


def test_inline_guard_ignores_bi_in_comments_names_and_strings(processor, tmp_path):
    seed, source = tmp_path / "seed.pdf", tmp_path / "ordinary.pdf"
    secret, public = make_mixed(seed, text_sensitive=True)
    with fitz.open(seed) as document:
        page = document[0]
        xref = page.get_contents()[-1]
        document.update_stream(xref, document.xref_stream(xref)
                               + b"\n% BI is a comment\n/Span << /Label (BI) /BI true >> BDC EMC\n")
        document.save(source)
    with known_ocr(processor, source, [secret], public, "local", 0, 1):
        result = processor.desensitize(str(source), ["SECRET"])
    check_outputs([result["output_path"]], source, secret, public, 0, 1)


def test_existing_redaction_on_inline_image_is_also_rejected(processor, tmp_path):
    seed, source = tmp_path / "seed.pdf", tmp_path / "annotated.pdf"
    secret, _ = make_mixed(seed, "inline")
    with fitz.open(seed) as document:
        document[0].add_redact_annot(secret)
        document.save(source)
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value={"tokens": [], "scale_to_pdf": 1}):
        with pytest.raises(RuntimeError, match="无法安全.*局部"):
            processor.desensitize(str(source), ["ABSENT"])


def http_response(status, body):
    response = requests.Response()
    response.status_code = status
    response.url = "https://example.invalid/synthetic"
    response._content = json.dumps(body).encode()
    response.headers["content-type"] = "application/json"
    return response


@pytest.mark.parametrize("status,body", [
    (503, {"error": "upstream unavailable"}),
    (503, {"words_result": []}),
    (200, {"error": "upstream unavailable"}),
    (200, {"words_result": None}),
    (200, {"words_result": {}}),
    (200, []),
])
def test_baidu_bad_response_does_not_export_text_only_success(processor, tmp_path, status, body):
    source = tmp_path / "mixed.pdf"
    make_mixed(source, text_sensitive=True)
    with patch.object(processor, "_get_baidu_token", return_value="synthetic"), \
            patch("pdf_processor.requests.post", return_value=http_response(status, body)), \
            patch("pdf_processor.time.sleep"):
        with pytest.raises(RuntimeError, match="Baidu"):
            processor.desensitize(str(source), ["SECRET"], settings("baidu"))


def test_baidu_retry_checks_http_status(processor, tmp_path):
    source = tmp_path / "mixed.pdf"
    make_mixed(source)
    responses = [http_response(200, {"error_code": 18}), http_response(503, {"words_result": []})]
    with patch.object(processor, "_get_baidu_token", return_value="synthetic"), \
            patch("pdf_processor.requests.post", side_effect=responses), patch("pdf_processor.time.sleep"):
        with pytest.raises(RuntimeError, match="Baidu"):
            processor.desensitize(str(source), ["SECRET"], settings("baidu"))


def test_baidu_reuses_tokens_only_within_one_document(processor, tmp_path):
    source = tmp_path / "two-pages.pdf"
    with fitz.open() as document:
        document.new_page(width=144, height=144)
        document.new_page(width=144, height=144)
        document.save(source)

    empty_page = http_response(200, {"words_result": []})
    with patch("pdf_processor.requests.post", side_effect=[
        http_response(200, {"access_token": "synthetic-first"}), empty_page, empty_page,
        http_response(200, {"access_token": "synthetic-second"}), empty_page, empty_page,
        http_response(401, {"error": "invalid_client"}),
    ]) as post:
        for account in ("first", "second"):
            post.reset_mock()
            result = processor.desensitize(str(source), ["SECRET"], {
                **settings("baidu"), "baidu_api_key": account, "baidu_secret_key": f"synthetic-{account}-secret",
            })
            assert result["review"]["pageCount"] == 2
            auth, *pages = post.call_args_list
            assert auth.kwargs["data"]["client_id"] == account
            assert auth.kwargs["data"]["client_secret"] == f"synthetic-{account}-secret"
            assert len(pages) == 2
            assert all(call.args[0].endswith(f"access_token=synthetic-{account}") for call in pages)
            assert processor._baidu_token_cache == {}

        post.reset_mock()
        with pytest.raises(RuntimeError, match="Failed to get Baidu token"):
            processor.desensitize(str(source), ["SECRET"], {
                **settings("baidu"), "baidu_api_key": "invalid",
            })
        post.assert_called_once()
        assert post.call_args.kwargs["data"]["client_id"] == "invalid"
        assert processor._baidu_token_cache == {}


def test_baidu_valid_empty_result_preserves_public_image(processor, tmp_path):
    source = tmp_path / "public.pdf"
    _, public = make_mixed(source, text_sensitive=True, image_word="OPEN")
    with fitz.open(source) as document:
        before = visible_pixels(document[0], public)
    with patch.object(processor, "_get_baidu_token", return_value="synthetic"), \
            patch("pdf_processor.requests.post", return_value=http_response(200, {"words_result": []})), \
            patch("pdf_processor.time.sleep"):
        result = processor.desensitize(str(source), ["SECRET"], settings("baidu"))
    with fitz.open(result["output_path"]) as document:
        assert "SECRET" not in document[0].get_text()
        assert visible_pixels(document[0], public) == before


@pytest.mark.parametrize("stage", ["poll", "result"])
def test_paddle_http_failure_is_not_a_successful_empty_result(processor, tmp_path, stage):
    source = tmp_path / "mixed.pdf"
    make_mixed(source, text_sensitive=True)
    submitted = http_response(200, {"data": {"jobId": "synthetic"}})
    poll = http_response(503 if stage == "poll" else 200,
                         {"data": {"state": "done", "resultUrl": {"jsonUrl": "https://example.invalid/results"}}})
    downloaded = http_response(503, {"result": {"layoutParsingResults": [{"prunedResult": {
        "width": 600, "height": 400, "parsing_res_list": [],
    }}]}})
    with patch("pdf_processor.paddle_request", side_effect=[submitted, poll, downloaded]), \
            patch("pdf_processor.time.sleep"):
        with pytest.raises(RuntimeError, match="PaddleOCR"):
            processor.desensitize(str(source), ["SECRET"], settings("paddle"))


@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("kind", ["xobject", "form"])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("user_unit", [1, 2])
@pytest.mark.parametrize("text_sensitive", [False, True])
def test_mixed_page_combines_text_and_image_matches(
    processor, tmp_path, mode, kind, rotation, cropped, user_unit, text_sensitive
):
    run_mixed(processor, tmp_path, kind, rotation, cropped, user_unit, text_sensitive, mode)


@pytest.mark.parametrize("scope", ["strict", "normal", "loose", "line", "paragraph"])
@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
def test_mixed_page_keeps_both_paths_for_each_scope(processor, tmp_path, scope, mode):
    run_mixed(processor, tmp_path, "form", 90, True, 0.5, True, mode, scope)


def test_nearby_text_match_does_not_discard_larger_ocr_coverage(processor, tmp_path):
    run_mixed(processor, tmp_path, "xobject", 0, False, 1, True, "local", "strict", aligned=True)


@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("user_unit", [1, 2])
def test_inline_hit_fails_without_dropping_unrelated_image_content(
    processor, tmp_path, mode, rotation, cropped, user_unit
):
    source = tmp_path / "inline.pdf"
    secret, public = make_mixed(source, "inline", rotation, cropped, user_unit)
    original = source.read_bytes()
    with fitz.open(source) as document:
        assert document[0].get_images(full=True) == []
        assert document[0].get_image_info()
    with known_ocr(processor, source, [secret], public, mode, rotation, user_unit):
        with pytest.raises(RuntimeError, match="无法安全.*局部"):
            processor.desensitize(str(source), ["SECRET"], settings(mode))
    assert source.read_bytes() == original


@pytest.mark.parametrize("kind", ["none", "unused"])
@pytest.mark.parametrize("mode", ["local", "baidu", "paddle"])
def test_text_only_and_unused_resources_do_not_start_ocr(processor, tmp_path, kind, mode):
    source = tmp_path / "text.pdf"
    make_mixed(source, kind, text_sensitive=True, image_word="OPEN")
    with fitz.open(source) as document:
        assert document[0].get_image_info() == []
        if kind == "unused":
            assert document[0].get_images(full=True)
    with patch.object(processor, "_get_page_ocr_data_by_mode", side_effect=AssertionError("No OCR")), \
            patch.object(processor, "_fetch_paddle_all_pages", side_effect=AssertionError("No upload")):
        result = processor.desensitize(str(source), ["SECRET"], settings(mode))
    with fitz.open(result["output_path"]) as document:
        assert "SECRET" not in document[0].get_text()
        assert "PUBLIC HEADER" in document[0].get_text()


@pytest.mark.parametrize("text_sensitive", [False, True])
def test_inline_without_image_hit_preserves_the_image(processor, tmp_path, text_sensitive):
    source = tmp_path / "inline-public.pdf"
    _, public = make_mixed(source, "inline", text_sensitive=text_sensitive, image_word="OPEN")
    with fitz.open(source) as document:
        before = visible_pixels(document[0], public)
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value={
        "tokens": [], "scale_to_pdf": 1.0,
    }) as ocr:
        result = processor.desensitize(str(source), ["SECRET"])
    assert ocr.call_count == 1
    with fitz.open(result["output_path"]) as document:
        assert "SECRET" not in document[0].get_text()
        assert document[0].get_image_info()
        assert visible_pixels(document[0], public) == before


def test_mixed_ocr_failure_is_not_reported_as_text_success(processor, tmp_path):
    source = tmp_path / "mixed.pdf"
    make_mixed(source, text_sensitive=True)
    with patch.object(processor, "_get_page_ocr_data_by_mode", side_effect=RuntimeError("OCR unavailable")):
        with pytest.raises(RuntimeError, match="OCR unavailable"):
            processor.desensitize(str(source), ["SECRET"])


@pytest.mark.parametrize("pages", [[], [{}, {}]])
def test_paddle_page_count_must_match_document(processor, tmp_path, pages):
    source = tmp_path / "mixed.pdf"
    make_mixed(source)
    with patch.object(processor, "_fetch_paddle_all_pages", return_value=pages):
        with pytest.raises(ValueError, match="page count"):
            processor.desensitize(str(source), ["SECRET"], settings("paddle"))


@pytest.mark.parametrize("mixed_index", [0, 1])
def test_paddle_keeps_original_page_indices_when_only_one_page_needs_ocr(
    processor, tmp_path, mixed_index
):
    mixed = tmp_path / "mixed.pdf"
    text = tmp_path / "text.pdf"
    secret, public = make_mixed(mixed, "form", rotation=90, text_sensitive=True)
    make_mixed(text, "none", text_sensitive=True)
    source = tmp_path / "combined.pdf"
    with fitz.open() as combined:
        for path in ([mixed, text] if mixed_index == 0 else [text, mixed]):
            with fitz.open(path) as part:
                combined.insert_pdf(part)
        combined.save(source)
    original = source.read_bytes()
    with fitz.open(source) as document:
        expected_public = visible_pixels(document[mixed_index], display_rect(public, 90, 1))
    token_rect = display_rect(secret, 90, 1)
    pages = [{}, {}]  # Unused text-page metadata must not select a wrong cache slot.
    pages[mixed_index] = {"img_w": 400, "img_h": 600, "tokens": [{
        "text": "SECRET", "x": token_rect.x0, "y": token_rect.y0,
        "w": token_rect.width, "h": token_rect.height,
        "line_id": "image-line", "block_id": "image-block", "source": "paddle",
    }]}
    with patch.object(processor, "_fetch_paddle_all_pages", return_value=pages) as fetch:
        result = processor.desensitize(str(source), ["SECRET"], settings("paddle"))
    assert fetch.call_count == 1
    assert set(processor._ocr_cache) == {f"{source}_{mixed_index}"}
    exported = tmp_path / "exported.pdf"
    processor.export(result["output_path"], "pdf", str(exported))
    for path in [result["output_path"], exported]:
        with fitz.open(path) as document:
            assert len(document) == 2
            assert all("SECRET" not in page.get_text() for page in document)
            page = document[mixed_index]
            assert set(visible_pixels(page, display_rect(secret, 90, 1))) == {0}
            assert visible_pixels(page, display_rect(public, 90, 1)) == expected_public
    assert source.read_bytes() == original
