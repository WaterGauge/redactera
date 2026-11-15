"""Object-level regressions for newly generated redacted PDFs (CR-001)."""

import hashlib
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor


@pytest.fixture
def processor():
    instance = PDFProcessor()
    yield instance
    instance.cleanup()


def make_text_source(path):
    with fitz.open() as document:
        page = document.new_page(width=400, height=300)
        page.insert_text((50, 80), "SECRET", fontsize=18)
        page.insert_text((50, 180), "PUBLIC", fontsize=18)
        document.save(path)


def decoded_streams(document):
    return [
        document.xref_stream(xref)
        for xref in range(1, document.xref_length())
        if document.xref_is_stream(xref)
    ]


def image_fingerprints(document):
    # get_images() alone omits the unreferenced original image from CR-001.
    return {
        hashlib.sha256(fitz.Pixmap(document, xref).samples).digest()
        for xref in range(1, document.xref_length())
        if document.xref_get_key(xref, "Subtype") == ("name", "/Image")
    }


def pixels(page, clip=None):
    return page.get_pixmap(dpi=72, alpha=False, clip=clip).samples


def processed_and_exported(processor, source, tmp_path):
    output = Path(processor.desensitize(str(source), ["SECRET"])["output_path"])
    exported = tmp_path / "exported.pdf"
    processor.export(str(output), "pdf", str(exported))
    return output, exported


def test_old_sensitive_text_stream_is_absent_from_output_and_export(processor, tmp_path):
    source = tmp_path / "text.pdf"
    make_text_source(source)
    original_bytes = source.read_bytes()
    with fitz.open(source) as document:
        sensitive_stream = document.xref_stream(document[0].get_contents()[0])
        public_rect = document[0].search_for("PUBLIC")[0]
        public_pixels = pixels(document[0], public_rect)

    for path in processed_and_exported(processor, source, tmp_path):
        with fitz.open(path) as document:
            assert "SECRET" not in document[0].get_text()
            assert "PUBLIC" in document[0].get_text()
            # The visible text check passed even before the fix; this did not.
            assert sensitive_stream not in decoded_streams(document)
            assert pixels(document[0], public_rect) == public_pixels
    assert source.read_bytes() == original_bytes


@pytest.mark.parametrize("page_count", [1, 2])
def test_original_scan_pixels_are_absent_including_shared_image_objects(
    processor, tmp_path, page_count
):
    text = tmp_path / "text.pdf"
    make_text_source(text)
    with fitz.open(text) as document:
        page = document[0]
        secret_rect = page.search_for("SECRET")[0]
        public_rect = page.search_for("PUBLIC")[0]
        image = page.get_pixmap(dpi=72, alpha=False).tobytes("png")
        public_pixels = pixels(page, public_rect)

    source = tmp_path / "scan.pdf"
    with fitz.open() as document:
        xref = 0
        for _ in range(page_count):
            page = document.new_page(width=400, height=300)
            if xref:
                page.insert_image(page.rect, xref=xref)
            else:
                xref = page.insert_image(page.rect, stream=image)
        original_image = hashlib.sha256(fitz.Pixmap(document, xref).samples).digest()
        document.save(source)
    original_bytes = source.read_bytes()
    known_ocr = {
        "tokens": [{"text": "SECRET", "x": secret_rect.x0, "y": secret_rect.y0,
                    "w": secret_rect.width, "h": secret_rect.height, "line_id": "line-1"}],
        "scale_to_pdf": 1.0,
    }
    # Isolate PDF redaction from OCR accuracy; no OCR engine/network is invoked.
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value=known_ocr):
        outputs = processed_and_exported(processor, source, tmp_path)

    for path in outputs:
        with fitz.open(path) as document:
            assert len(document) == page_count
            assert original_image not in image_fingerprints(document)
            for page in document:
                assert set(pixels(page, secret_rect)) == {0}
                assert pixels(page, public_rect) == public_pixels
    assert source.read_bytes() == original_bytes


def test_no_match_preserves_page_and_non_sensitive_image(processor, tmp_path):
    text = tmp_path / "text.pdf"
    make_text_source(text)
    with fitz.open(text) as document:
        public_image = document[0].get_pixmap(
            dpi=72, alpha=False, clip=fitz.Rect(40, 145, 180, 190)
        ).tobytes("png")
    source = tmp_path / "public.pdf"
    with fitz.open() as document:
        page = document.new_page(width=400, height=300)
        page.insert_text((50, 80), "PUBLIC")
        page.insert_image(fitz.Rect(50, 140, 190, 185), stream=public_image)
        before_pixels = pixels(page)
        images = image_fingerprints(document)
        document.save(source)
    original_bytes = source.read_bytes()
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value={
        "tokens": [], "scale_to_pdf": 1.0,
    }):
        outputs = processed_and_exported(processor, source, tmp_path)
    for path in outputs:
        with fitz.open(path) as document:
            assert len(document) == 1
            assert document[0].rect == fitz.Rect(0, 0, 400, 300)
            assert "PUBLIC" in document[0].get_text()
            assert pixels(document[0]) == before_pixels
            assert images <= image_fingerprints(document)
    assert source.read_bytes() == original_bytes
