"""Review locations must describe actual masks, not a second keyword search."""
import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor
from tests.test_redaction_rotation import make_source, display_rect, known_ocr


@pytest.fixture
def processor():
    instance = PDFProcessor()
    yield instance
    instance.cleanup()


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("unit", [0.5, 1, 2])
@pytest.mark.parametrize("raster", [False, True])
def test_report_matches_displayed_masks_and_public_content(processor, tmp_path, rotation, cropped, unit, raster):
    source = tmp_path / "input.pdf"
    secrets, public = make_source(source, rotation, cropped, raster=raster, user_unit=unit)
    before = source.read_bytes()
    settings = {"redaction_scope": "normal", "fuzzy_match_enabled": False}
    with known_ocr(processor, source, secrets, public, "local", rotation, unit):
        result = processor.desensitize(str(source), ["SECRET"], settings)
    report = result["review"]
    assert report["version"] == report["pageCount"] == 1
    assert len(report["regions"]) == 3
    with fitz.open(result["output_path"]) as document:
        page = document[0]
        assert page.rotation == rotation
        for expected in secrets:
            expected = display_rect(expected, rotation, unit)
            def bounds(region):
                points = region["polygon"]
                assert all(0 <= value <= 1 for point in points for value in point)
                return fitz.Rect(min(p[0] for p in points) * page.rect.width,
                                 min(p[1] for p in points) * page.rect.height,
                                 max(p[0] for p in points) * page.rect.width,
                                 max(p[1] for p in points) * page.rect.height)
            region = next(region for region in report["regions"] if bounds(region).contains(expected.tl + (expected.br - expected.tl) * 0.5))
            assert region["origin"] == "keyword" and region["keywords"] == ["SECRET"] and region["page"] == 1
            # The marker lies on the saved black mask, within two rendered
            # pixels for anti-aliased edges and OCR rounding.
            box = bounds(region)
            inside = fitz.Rect(box.x0 + 2, box.y0 + 2, box.x1 - 2, box.y1 - 2)
            pixels = page.get_pixmap(dpi=144, alpha=False, clip=inside)
            assert max(pixels.samples) == 0
        public_pixels = page.get_pixmap(dpi=72, alpha=False, clip=display_rect(public, rotation, unit)).samples
        assert min(public_pixels) < max(public_pixels)
        if not raster:
            assert "SECRET" not in page.get_text() and "PUBLIC" in page.get_text()
    assert source.read_bytes() == before


def test_contained_keyword_masks_are_one_region_with_both_input_labels(processor, tmp_path):
    source = tmp_path / "nested.pdf"
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((40, 50), "SECRET PUBLIC")
        document.save(source)
    result = processor.desensitize(str(source), ["SECRET", "SECRET PUBLIC"], {"fuzzy_match_enabled": False})
    regions = result["review"]["regions"]
    assert len(regions) == 1
    assert regions[0]["keywords"] == ["SECRET", "SECRET PUBLIC"]
    assert result["sanitization"]["applied_redactions"] == 0


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [0.5, 1, 2])
def test_existing_quads_are_separate_and_do_not_copy_original_text(processor, tmp_path, rotation, unit):
    source = tmp_path / "existing.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        page.insert_text((40, 70), "PRIVATE")
        page.insert_text((40, 200), "PUBLIC")
        page.add_redact_annot(fitz.Quad((32, 40), (120, 44), (30, 80), (118, 84)))
        document.xref_set_key(page.xref, "UserUnit", str(unit))
        page.set_rotation(rotation)
        document.save(source)
    result = processor.desensitize(str(source), ["MISSING"], {"fuzzy_match_enabled": False})
    regions = result["review"]["regions"]
    assert len(regions) == 1
    assert regions[0]["origin"] == "existing" and regions[0]["keywords"] == []
    assert len(regions[0]["polygon"]) == 4
    assert "PRIVATE" not in str(result["review"])
    with fitz.open(result["output_path"]) as document:
        assert "PRIVATE" not in document[0].get_text() and "PUBLIC" in document[0].get_text()
    assert result["warnings"][0]["type"] == "no_match"


def test_valid_zero_mask_report_retains_global_no_match(processor, tmp_path):
    source = tmp_path / "zero.pdf"
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((40, 50), "PUBLIC")
        document.save(source)
    result = processor.desensitize(str(source), ["MISSING"], {"fuzzy_match_enabled": False})
    assert result["review"] == {"version": 1, "pageCount": 1, "regions": []}
    assert result["warnings"][0]["page"] is None


def test_partly_off_page_quad_is_clipped_as_polygon(processor):
    with fitz.open() as document:
        page = document.new_page(width=100, height=100)
        region = processor._review_region(page, fitz.Quad((-20, 20), (50, -20), (10, 80), (80, 40)), "existing", [], "r1")
        assert region and len(region["polygon"]) > 4
        assert all(0 <= value <= 1 for point in region["polygon"] for value in point)
