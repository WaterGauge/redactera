"""Final-file vector removal and public-geometry regressions (R2-SEC-001)."""
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor


@pytest.fixture(autouse=True)
def ignore_outline_recognition_accuracy(monkeypatch):
    # Keep the final vector checks deterministic. The actual outline OCR is
    # exercised in the Electron workflow with a known source-positive fixture.
    monkeypatch.setattr("pdf_processor.read_ocr_data", lambda *_args, **_kwargs: {"text": []})


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


def red_paths(page):
    return [drawing for drawing in page.get_drawings()
            if any(color and len(color) == 3 and color[0] > .9 and color[1] < .1 and color[2] < .1
                   for color in (drawing.get("fill"), drawing.get("color")))]


def make_source(path, kind="fill", origin="native", rotation=0, unit=1):
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 80), "SECRET", fontsize=20)
        secret = page.search_for("SECRET")[0]
        if origin == "ocr":
            # Remove the native target; the controlled OCR box is the only hit.
            page.add_redact_annot(secret)
            page.apply_redactions()
        page.insert_text((40, 180), "PUBLIC CONTROL", fontsize=16)
        mark = fitz.Rect(secret.x0 + 7, secret.y0 + 8, secret.x0 + 15, secret.y0 + 16)
        shape = page.new_shape()
        if kind == "crossing":
            shape.draw_line((secret.x0 - 12, secret.y0 + 8), (secret.x1 + 40, secret.y0 + 8))
        elif kind == "bezier":
            shape.draw_bezier(mark.tl, mark.tr, mark.bl, mark.br)
        elif kind == "quad":
            shape.draw_quad(fitz.Quad(mark.tl + (1, 0), mark.tr, mark.bl, mark.br - (1, 0)))
        else:
            shape.draw_rect(mark)
            if kind == "compound":
                shape.draw_rect(mark + (25, 0, 25, 0))
            elif kind == "compound-crossing":
                shape.draw_rect(mark + (160, 0, 160, 0))
        shape.finish(color=(1, 0, 0) if kind in ("stroke", "crossing", "bezier") else None,
                     fill=None if kind in ("stroke", "crossing", "bezier") else (1, 0, 0), width=.2)
        shape.commit()
        page.draw_line((20, 230), (380, 230), color=(0, 0, 1), width=2)
        if origin == "existing":
            page.add_redact_annot(secret, fill=None)
        if origin == "ocr":
            image = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), False)
            image.clear_with(255)
            page.insert_image(fitz.Rect(350, 10, 370, 30), stream=image.tobytes("png"))
        doc.xref_set_key(page.xref, "UserUnit", str(unit))
        page.set_rotation(rotation)
        doc.save(path)
    return secret


def process_and_export(processor, source, tmp_path, origin="native", secret=None):
    kwargs = {"redaction_scope": "strict", "fuzzy_match_enabled": False}
    if origin == "ocr":
        assert secret is not None
        data = {"tokens": [{"text": "SECRET", "x": secret.x0, "y": secret.y0,
                           "w": secret.width, "h": secret.height, "line_id": "l1"}],
                "scale_to_pdf": 1.0}
        with patch.object(processor, "_get_page_ocr_data_by_mode", return_value=data):
            result = processor.desensitize(str(source), ["SECRET"], kwargs)
    else:
        result = processor.desensitize(str(source), ["SECRET"], kwargs)
    exported = tmp_path / "exported.pdf"
    processor.export(result["output_path"], "pdf", str(exported))
    return result, [Path(result["output_path"]), exported]


@pytest.mark.parametrize("kind", ["fill", "stroke", "bezier", "quad", "compound"])
@pytest.mark.parametrize("origin", ["native", "existing", "ocr"])
def test_contained_vector_is_removed_from_closed_result_and_export(processor, tmp_path, kind, origin):
    source = tmp_path / "source.pdf"
    secret = make_source(source, kind, origin)
    before = source.read_bytes()
    public_clip = fitz.Rect(15, 210, 385, 250)
    with fitz.open(source) as doc:
        assert red_paths(doc[0]), "Source-positive vector control missing"
        public = doc[0].get_pixmap(dpi=72, clip=public_clip, alpha=False, annots=False).samples
    result, paths = process_and_export(processor, source, tmp_path, origin, secret)
    assert result["review"]["regions"]
    for path in paths:
        with fitz.open(path) as doc:
            assert not red_paths(doc[0]), "Recoverable sensitive vector path remains"
            assert "SECRET" not in doc[0].get_text()
            assert "PUBLIC CONTROL" in doc[0].get_text()
            assert any(d.get("color") == (0, 0, 1) for d in doc[0].get_drawings())
            assert doc[0].get_pixmap(dpi=72, clip=public_clip, alpha=False).samples == public
    assert source.read_bytes() == before


@pytest.mark.parametrize("kind", ["crossing", "compound-crossing"])
@pytest.mark.parametrize("origin", ["native", "existing", "ocr"])
def test_cross_boundary_vector_fails_without_export_or_source_changes(processor, tmp_path, kind, origin):
    source = tmp_path / "source.pdf"
    secret = make_source(source, kind, origin)
    before = source.read_bytes()
    with pytest.raises(RuntimeError, match="图形跨越"):
        process_and_export(processor, source, tmp_path, origin, secret)
    assert not (tmp_path / "exported.pdf").exists()
    assert source.read_bytes() == before
    with fitz.open(source) as doc:
        assert red_paths(doc[0])


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [.5, 1, 2])
def test_vector_removal_keeps_rotation_userunit_and_report(processor, tmp_path, rotation, unit):
    source = tmp_path / "source.pdf"
    make_source(source, rotation=rotation, unit=unit)
    with fitz.open(source) as doc:
        geometry = (doc[0].rect, doc[0].rotation)
    result, paths = process_and_export(processor, source, tmp_path)
    assert len(result["review"]["regions"]) == 1
    for path in paths:
        with fitz.open(path) as doc:
            assert (doc[0].rect, doc[0].rotation) == geometry
            assert not red_paths(doc[0])
            assert "PUBLIC CONTROL" in doc[0].get_text()
            region = result["review"]["regions"][0]["polygon"]
            x = sum(p[0] for p in region) / len(region) * doc[0].rect.width
            y = sum(p[1] for p in region) / len(region) * doc[0].rect.height
            assert set(doc[0].get_pixmap(dpi=144, clip=fitz.Rect(x - 1, y - 1, x + 1, y + 1), alpha=False).samples) == {0}


def test_no_match_retains_public_vectors_and_does_not_reinterpret_input(processor, tmp_path):
    source = tmp_path / "public.pdf"
    make_source(source)
    with fitz.open(source) as doc:
        clips = [fitz.Rect(48, 68, 53, 72), fitz.Rect(15, 210, 385, 250)]
        before = [doc[0].get_pixmap(dpi=72, clip=clip, alpha=False).samples for clip in clips]
        paths_before = len(red_paths(doc[0]))
    result = processor.desensitize(str(source), ["ABSENT"])
    with fitz.open(result["output_path"]) as doc:
        assert len(red_paths(doc[0])) == paths_before
        assert [doc[0].get_pixmap(dpi=72, clip=clip, alpha=False).samples for clip in clips] == before
    assert result["review"]["regions"] == []



def test_nested_form_vector_is_removed(processor, tmp_path):
    inner = tmp_path / "inner.pdf"
    source = tmp_path / "form.pdf"
    make_source(inner)
    with fitz.open(inner) as original, fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.show_pdf_page(page.rect, original, 0)
        doc.save(source)
    _, paths = process_and_export(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as doc:
            assert not red_paths(doc[0])
            assert "PUBLIC CONTROL" in doc[0].get_text()


def test_later_keyword_keeps_entire_prior_mask(processor, tmp_path):
    source = tmp_path / "two-rounds.pdf"
    prior = fitz.Rect(110, 64, 120, 66)
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.insert_text((20, 80), "PUBLIC             SECRET", fontsize=12)
        page.insert_text((40, 180), "PUBLIC CONTROL", fontsize=16)
        page.add_redact_annot(prior, fill=None)
        doc.save(source)
    result = processor.desensitize(str(source), ["SECRET"], {"redaction_scope": "loose"})
    assert any(r["origin"] == "existing" for r in result["review"]["regions"])
    keyword = next(r for r in result["review"]["regions"] if r["origin"] == "keyword")
    polygon = keyword["polygon"]
    keyword_bounds = fitz.Rect(min(p[0] for p in polygon) * 400, min(p[1] for p in polygon) * 300,
                               max(p[0] for p in polygon) * 400, max(p[1] for p in polygon) * 300)
    assert keyword_bounds.intersects(prior) and not keyword_bounds.contains(prior)
    with fitz.open(result["output_path"]) as doc:
        assert "SECRET" not in doc[0].get_text()
        assert "PUBLIC CONTROL" in doc[0].get_text()
        assert set(doc[0].get_pixmap(dpi=144, clip=fitz.Rect(112, 64.2, 118, 64.8), alpha=False).samples) == {0}


def test_unconverted_shading_is_rejected_by_shared_redaction_boundary(processor, tmp_path):
    source = tmp_path / "shading.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 80), "SECRET", fontsize=20)
        page.insert_text((40, 180), "PUBLIC CONTROL", fontsize=16)
        shade = doc.get_new_xref()
        doc.update_object(shade, "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [40 220 120 220] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 1 0] /N 1 >> /Extend [true true] >>")
        resources = doc.xref_get_key(page.xref, "Resources")
        assert resources[0] == "xref"
        doc.xref_set_key(int(resources[1].split()[0]), "Shading", f"<< /SecretShade {shade} 0 R >>")
        stream = doc.get_new_xref()
        doc.update_object(stream, "<<>>")
        doc.update_stream(stream, b"q 40 214 80 28 re W n /SecretShade sh Q")
        page.set_contents(stream)
        # Keep native text so matching needs no OCR/network.
        page.insert_text((40, 80), "SECRET", fontsize=20)
        page.insert_text((40, 180), "PUBLIC CONTROL", fontsize=16)
        doc.save(source)
    before = source.read_bytes()
    with fitz.open(source) as doc:
        assert any(item[0] == "fill-shade" for item in doc[0].get_bboxlog())
        # The PDF-device normally rasterizes this primitive. Check the shared
        # boundary directly for any unconverted shade reaching it.
        rect = doc[0].search_for("SECRET")[0]
        with pytest.raises(RuntimeError, match="图形"):
            processor._apply_page_redactions(doc[0], [rect])
    assert source.read_bytes() == before


@pytest.mark.parametrize("origin", ["native", "existing"])
@pytest.mark.parametrize("geometry", [
    b"47 226 m 49 234 l 55 229 l 51 227 l h",
    b"47 226 8 8 re",
    b"47 226 m 49 234 52 227 55 229 c 47 226 l h",
])
def test_sensitive_clipping_geometry_cannot_survive_as_an_unpainted_path(
    processor, tmp_path, origin, geometry,
):
    source = tmp_path / "clip.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        stream = doc.get_new_xref()
        doc.update_object(stream, "<<>>")
        doc.update_stream(stream, b"q " + geometry + b" W n 1 0 0 rg 47 226 8 8 re f Q")
        page.set_contents(stream)
        page.insert_text((40, 80), "SECRET", fontsize=20)
        page.insert_text((40, 180), "PUBLIC CONTROL")
        if origin == "existing":
            page.add_redact_annot(page.search_for("SECRET")[0], fill=None)
        doc.save(source)
    before = source.read_bytes()
    with fitz.open(source) as doc:
        assert any(d["type"] == "clip" for d in doc[0].get_drawings(extended=True))
    _, paths = process_and_export(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as doc:
            assert not red_paths(doc[0])
            assert "SECRET" not in doc[0].get_text()
            assert "PUBLIC CONTROL" in doc[0].get_text()
            # Checking paint alone missed W/n paths in the first candidate.
            # The only permitted remaining clips in this fixture are page
            # viewports; no original sensitive polygon or small rect remains.
            for drawing in doc[0].get_drawings(extended=True):
                if drawing["type"] == "clip":
                    points = []
                    for item in drawing["items"]:
                        for value in item[1:]:
                            if isinstance(value, fitz.Point):
                                points.append(value)
                            elif isinstance(value, fitz.Rect):
                                points.extend((value.tl, value.br))
                    assert points
                    bounds = fitz.Rect(min(point.x for point in points), min(point.y for point in points),
                                       max(point.x for point in points), max(point.y for point in points))
                    assert bounds.contains(doc[0].rect), "Recoverable sensitive clip remains"
    assert source.read_bytes() == before


def test_nearby_public_stroke_outside_keyword_is_preserved(processor, tmp_path):
    source = tmp_path / "public-line.pdf"
    clip = fitz.Rect(35, 45, 165, 55)
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 80), "SECRET", fontsize=20)
        page.insert_text((40, 180), "PUBLIC CONTROL")
        page.draw_line((40, 50), (160, 50), color=(0, 0, 1), width=1)
        doc.save(source)
    with fitz.open(source) as doc:
        expected = doc[0].get_pixmap(dpi=144, clip=clip, alpha=False).samples
    _, paths = process_and_export(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as doc:
            assert "SECRET" not in doc[0].get_text()
            assert doc[0].get_pixmap(dpi=144, clip=clip, alpha=False).samples == expected
            assert any(d.get("color") == (0, 0, 1) for d in doc[0].get_drawings())


def test_page_viewport_clip_allows_partly_off_page_existing_redaction(processor, tmp_path):
    source = tmp_path / "off-page.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=100, height=100)
        page.insert_text((40, 70), "SECRET", fontsize=8)
        page.insert_text((10, 95), "PUBLIC", fontsize=4)
        page.draw_rect(fitz.Rect(44, 63, 48, 66), color=None, fill=(1, 0, 0))
        page.add_redact_annot(fitz.Rect(-5, 45, 80, 85), fill=None)
        doc.save(source)
    result = processor.desensitize(str(source), ["SECRET"])
    with fitz.open(result["output_path"]) as doc:
        assert not red_paths(doc[0])
        assert "SECRET" not in doc[0].get_text()
        assert "PUBLIC" in doc[0].get_text()
    assert result["review"]["regions"]


@pytest.mark.parametrize("geometry", [
    b"47 226 m 49 234 l 200 270 l 200 170 l 51 227 l h",
    b"47 170 153 100 re",
])
@pytest.mark.parametrize("origin", ["native", "existing"])
def test_nonempty_clip_crossing_selected_region_is_rejected(processor, tmp_path, geometry, origin):
    source = tmp_path / "nonempty-clip.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        stream = doc.get_new_xref()
        doc.update_object(stream, "<<>>")
        doc.update_stream(stream, b"q " + geometry + b" W n 0 0 1 rg 160 220 10 10 re f Q")
        page.set_contents(stream)
        page.insert_text((40, 80), "SECRET", fontsize=20)
        page.insert_text((40, 180), "PUBLIC CONTROL")
        if origin == "existing":
            page.add_redact_annot(page.search_for("SECRET")[0], fill=None)
        doc.save(source)
    before = source.read_bytes()
    with pytest.raises(RuntimeError, match="裁剪图形"):
        process_and_export(processor, source, tmp_path)
    assert not (tmp_path / "exported.pdf").exists()
    assert source.read_bytes() == before


def test_public_text_in_retained_form_clip_is_preserved(processor, tmp_path):
    source = tmp_path / "form-with-public-text.pdf"
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=300)
        widget = fitz.Widget()
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_name = "synthetic"
        widget.field_value = "PUBLIC SECRET MORE"
        widget.rect = fitz.Rect(25, 45, 360, 110)
        widget.text_fontsize = 20
        page.add_widget(widget)
        doc.save(source)
    with fitz.open(source) as doc:
        clip = fitz.Rect(28, 50, 100, 100)
        expected = doc[0].get_pixmap(dpi=144, clip=clip, alpha=False).samples
    _, paths = process_and_export(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as doc:
            text = doc[0].get_text()
            assert "SECRET" not in text
            assert "PUBLIC" in text and "MORE" in text
            assert doc[0].get_pixmap(dpi=144, clip=clip, alpha=False).samples == expected
