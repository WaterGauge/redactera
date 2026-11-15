"""CR-005: a static visible-page result must not carry private PDF objects."""

import io
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import pytest
from PIL import Image, ImageChops, ImageDraw, ImageStat
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.cffLib import CFFFontSet
from fontTools.ttLib import TTFont

from pdf_processor import PDFProcessor
from .test_redaction_rotation import display_rect, new_page, visible_pixels

PRIVATE = "CR005_PRIVATE_CARRIER"


@pytest.fixture(autouse=True)
def ignore_outline_recognition_accuracy(monkeypatch):
    # These cases exercise PDF carriers, not OCR accuracy. The real outline
    # workflow runs separately with a pinned Tesseract in Electron E2E.
    monkeypatch.setattr("pdf_processor.read_ocr_data", lambda *_args, **_kwargs: {"text": []})


@pytest.fixture
def processor():
    processor = PDFProcessor()
    yield processor
    processor.cleanup()


def object_bytes(document):
    parts = []
    for xref in range(1, document.xref_length()):
        parts.append(document.xref_object(xref).encode())
        if document.xref_is_stream(xref):
            parts.append(document.xref_stream(xref))
            parts.append(document.xref_stream_raw(xref))
    return b"\n".join(parts)


def appearance_reference(page, rotation=0, user_unit=1):
    pix = page.get_pixmap(dpi=72, alpha=False)
    # Independent fixture locations, expanded for the stock icons' NoRotate /
    # NoZoom flags. The old engine's Annot.rect varies with page rotation.
    icons = [display_rect(fitz.Rect(390, y - 30, 470, y + 50)
                          * fitz.Matrix(user_unit, user_unit), rotation, user_unit)
             for y in (60, 180)]
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples), icons


def assert_same_appearance(page, reference):
    expected, icons = reference
    pix = page.get_pixmap(dpi=72, alpha=False)
    actual = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    difference = ImageChops.difference(expected, actual)
    # Rewriting the stock note/file icons changes their antialiasing slightly
    # on this pinned engine. Every non-icon pixel must remain byte-identical.
    stats = ImageStat.Stat(difference)
    assert max(stats.mean) < 0.01
    assert max(high for _low, high in stats.extrema) <= 32
    outside_icons = difference.copy()
    draw = ImageDraw.Draw(outside_icons)
    for rect in icons:
        draw.rectangle((rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2), fill=(0, 0, 0))
    assert outside_icons.getbbox() is None


def carrier_source(path, rotation=0, cropped=False, user_unit=1,
                   appearance="PUBLIC_FORM", canonical=PRIVATE, hidden_flags=2, redact=False):
    with fitz.open() as document:
        page = new_page(document, cropped)
        page.insert_text((30, 35), "PUBLIC NATIVE", fontsize=14)
        public_rect = page.search_for("PUBLIC NATIVE")[0] * fitz.Matrix(user_unit, user_unit)
        document.set_metadata({"title": PRIVATE, "author": PRIVATE})
        info = int(document.xref_get_key(-1, "Info")[1].split()[0])
        document.xref_set_key(info, "Private", fitz.get_pdf_str(PRIVATE))
        xml = f'<x:xmpmeta xmlns:x="adobe:ns:meta/">{PRIVATE}</x:xmpmeta>'
        document.set_xml_metadata(xml)
        document.set_toc([[1, PRIVATE, 1]])
        file_xref = document.embfile_add(PRIVATE + ".txt", PRIVATE.encode(), filename=PRIVATE)
        # Alternate associated-file references survive merely deleting Names.
        spec = document.get_new_xref()
        document.update_object(spec, f"<< /Type /Filespec /F ({PRIVATE}) /UF ({PRIVATE}) /EF << /F {file_xref} 0 R >> >>")
        for xref in [document.pdf_catalog(), page.xref]:
            document.xref_set_key(xref, "AF", f"[{spec} 0 R]")
            document.xref_set_key(xref, "AA", f"<< /O << /S /JavaScript /JS ({PRIVATE}) >> >>")
            document.xref_set_key(xref, "Private", fitz.get_pdf_str(PRIVATE))
        document.xref_set_key(document.pdf_catalog(), "OpenAction", f"<< /S /JavaScript /JS ({PRIVATE}) >>")
        font = page.get_fonts()[0][0]
        metadata = document.get_new_xref()
        document.update_object(metadata, "<< /Type /Metadata /Subtype /XML >>")
        document.update_stream(metadata, xml.encode())
        document.xref_set_key(font, "Metadata", f"{metadata} 0 R")
        document.xref_set_key(font, "Private", fitz.get_pdf_str(PRIVATE))
        widget = fitz.Widget()
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_name = PRIVATE
        widget.field_value = appearance
        widget.rect = fitz.Rect(60, 100, 300, 145)
        widget.text_fontsize = 16
        page.add_widget(widget)
        widget_xref = next(page.widgets()).xref
        document.xref_set_key(widget_xref, "V", fitz.get_pdf_str(canonical))
        document.xref_set_key(widget_xref, "DV", fitz.get_pdf_str(PRIVATE))
        document.xref_set_key(widget_xref, "TU", fitz.get_pdf_str(PRIVATE))
        note = page.add_text_annot((420, 60), PRIVATE)
        note.set_info(title=PRIVATE, subject=PRIVATE)
        hidden = page.add_freetext_annot(fitz.Rect(60, 230, 300, 265), PRIVATE)
        hidden.set_flags(hidden_flags)
        page.add_freetext_annot(fitz.Rect(60, 180, 300, 215), "PUBLIC NOTE")
        page.add_file_annot((420, 180), PRIVATE.encode(), PRIVATE + ".txt")
        page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(400, 280, 530, 310),
                          "uri": "https://example.invalid/" + PRIVATE})
        if redact:
            page.add_redact_annot(fitz.Rect(55, 95, 305, 150))
        document.xref_set_key(page.xref, "UserUnit", str(user_unit))
        page = document.reload_page(page)
        page.set_rotation(rotation)
        document.save(path, garbage=4, deflate=True)
    return public_rect


def outputs(processor, source, tmp_path, keywords=("ABSENT",), settings=None):
    result = processor.desensitize(str(source), keywords, settings)
    exported = tmp_path / "exported.pdf"
    processor.export(result["output_path"], "pdf", str(exported))
    return result, [Path(result["output_path"]), exported]


def assert_no_carriers(path):
    with fitz.open(path) as document:
        assert not any(document.metadata.get(key) for key in
                       ["title", "author", "subject", "keywords", "creator", "producer"])
        assert not document.get_xml_metadata()
        assert not document.get_toc()
        assert document.embfile_count() == 0
        assert not document.is_form_pdf
        assert document.xref_get_key(document.pdf_catalog(), "Names")[0] == "null"
        assert document.xref_get_key(document.pdf_catalog(), "OpenAction")[0] == "null"
        for page in document:
            assert not list(page.widgets() or [])
            assert not list(page.annots() or [])
            assert not page.get_links()
            assert PRIVATE not in page.get_text()
        content = object_bytes(document)
        assert PRIVATE.encode() not in content
        assert PRIVATE.encode("utf-16-be") not in content
        assert PRIVATE.encode().hex().encode() not in content.lower()


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_cleans_all_carriers_without_a_keyword_hit_and_keeps_public_geometry(
    processor, tmp_path, rotation, cropped, user_unit
):
    source = tmp_path / "carriers.pdf"
    public = carrier_source(source, rotation, cropped, user_unit)
    original = source.read_bytes()
    with fitz.open(source) as document:
        expected = appearance_reference(document[0], rotation, user_unit)
        crop, media, bounds = document[0].cropbox, document[0].mediabox, document[0].rect
        public_pixels = visible_pixels(document[0], display_rect(public, rotation, user_unit))
    result, paths = outputs(processor, source, tmp_path)
    assert result["sanitization"]["policy"] == "visible-page-content"
    assert result["sanitization"]["form_fields"] == 1
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            page = document[0]
            assert page.rotation == rotation and page.cropbox == crop and page.mediabox == media and page.rect == bounds
            assert "PUBLIC_FORM" in page.get_text() and "PUBLIC NOTE" in page.get_text()
            assert_same_appearance(page, expected)
            assert visible_pixels(page, display_rect(public, rotation, user_unit)) == public_pixels
    assert source.read_bytes() == original


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_redacts_visible_form_appearance_even_when_its_canonical_value_is_public(
    processor, tmp_path, rotation, user_unit
):
    source = tmp_path / "appearance.pdf"
    carrier_source(source, rotation, True, user_unit, appearance="TARGET", canonical="PUBLIC_VALUE")
    _, paths = outputs(processor, source, tmp_path, ["TARGET"], {"redaction_scope": "strict"})
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert "TARGET" not in document[0].get_text()
            assert "PUBLIC NATIVE" in document[0].get_text()
            assert b"(TARGET)" not in object_bytes(document)


@pytest.mark.parametrize("flags", [1, 2, 32, 3, 34])
def test_invisible_annotations_are_not_promoted_into_visible_content(processor, tmp_path, flags):
    source = tmp_path / "hidden.pdf"
    carrier_source(source, hidden_flags=flags)
    with fitz.open(source) as document:
        expected = appearance_reference(document[0])
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert_same_appearance(document[0], expected)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("user_unit", [0.5, 1, 2])
def test_existing_redaction_is_applied_after_visible_content_normalization(processor, tmp_path, rotation, user_unit):
    source = tmp_path / "annotated.pdf"
    carrier_source(source, rotation, True, user_unit, appearance="TARGET", canonical="PUBLIC_VALUE", redact=True)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert "TARGET" not in document[0].get_text()
            area = fitz.Rect(60, 100, 300, 145) * fitz.Matrix(user_unit, user_unit)
            assert set(visible_pixels(document[0], display_rect(area, rotation, user_unit))) == {0}


def test_keeps_hidden_layers_hidden_and_drops_their_payload(processor, tmp_path):
    source = tmp_path / "layers.pdf"
    with fitz.open() as document:
        page = document.new_page()
        page.insert_text((40, 40), "PUBLIC")
        off = document.add_ocg(PRIVATE, on=False)
        page.insert_text((40, 90), PRIVATE, oc=off)
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert not document.get_ocgs()
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


@pytest.mark.parametrize("kind", ["signature", "direct-signature", "xfa"])
def test_unsupported_signed_or_dynamic_forms_fail_without_output_or_source_change(processor, tmp_path, kind):
    source = tmp_path / "unsupported.pdf"
    with fitz.open() as document:
        page = document.new_page(); page.insert_text((40, 40), "PUBLIC")
        if kind == "xfa":
            document.xref_set_key(document.pdf_catalog(), "AcroForm", "<< /XFA (dynamic XML) >>")
        else:
            widget = fitz.Widget(); widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
            widget.field_name = "signature"; widget.rect = fitz.Rect(40, 80, 200, 120)
            page.add_widget(widget)
            document.xref_set_key(next(page.widgets()).xref, "FT", "/Sig")
            sig = "<< /Type /Sig /ByteRange [0 1 2 3] /Contents <01> >>"
            if kind == "signature":
                xref = document.get_new_xref(); document.update_object(xref, sig); sig = f"{xref} 0 R"
            document.xref_set_key(next(page.widgets()).xref, "V", sig)
        document.save(source)
    original = source.read_bytes()
    with pytest.raises(RuntimeError, match="签名|XFA"):
        processor.desensitize(str(source), ["ABSENT"])
    assert source.read_bytes() == original


def test_normalization_failure_is_not_a_successful_result(processor, tmp_path):
    source = tmp_path / "source.pdf"; carrier_source(source)
    with patch.object(processor, "_render_visible_pdf", create=True, side_effect=RuntimeError("normalization failed")):
        with pytest.raises(RuntimeError, match="normalization failed"):
            processor.desensitize(str(source), ["ABSENT"])


def test_paddle_receives_the_same_clean_page_copy_that_is_matched(processor, tmp_path):
    source = tmp_path / "source.pdf"; carrier_source(source)
    with fitz.open(source) as original:
        image = original[0].get_pixmap(dpi=72, alpha=False).tobytes("png")
    with fitz.open(source) as document:
        document[0].insert_image(fitz.Rect(350, 250, 500, 350), stream=image)
        document.save(tmp_path / "mixed.pdf")
    source = tmp_path / "mixed.pdf"

    def fetch(path, *args, **kwargs):
        assert path != str(source)
        assert_no_carriers(path)
        with fitz.open(path) as document:
            page = document[0]
            return [{"tokens": [], "img_w": page.rect.width, "img_h": page.rect.height}]

    with patch.object(processor, "_fetch_paddle_all_pages", side_effect=fetch):
        _, paths = outputs(processor, source, tmp_path, ["ABSENT"], {
            "ocr_mode": "paddle", "paddle_api_url": "https://8.8.8.8", "paddle_token": "synthetic",
        })
    for path in paths:
        assert_no_carriers(path)


def test_drops_jpeg_exif_without_changing_decoded_public_pixels(processor, tmp_path):
    image = Image.new("RGB", (64, 48))
    image.putdata([(x * 3, y * 4, (x + y) * 2) for y in range(48) for x in range(64)])
    exif = Image.Exif(); exif[270] = PRIVATE; exif[315] = PRIVATE
    encoded = io.BytesIO(); image.save(encoded, format="JPEG", exif=exif)
    source = tmp_path / "jpeg.pdf"
    with fitz.open() as document:
        page = document.new_page(width=400, height=300)
        page.insert_text((30, 35), "PUBLIC")
        page.insert_image(fitz.Rect(30, 70, 286, 262), stream=encoded.getvalue())
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        assert PRIVATE.encode() in object_bytes(document)
        document.save(source)
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value={"tokens": [], "scale_to_pdf": 1}):
        _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


@pytest.mark.parametrize("carrier", ["actualtext", "visible-layer-name"])
def test_drops_marked_content_metadata_and_visible_layer_labels(processor, tmp_path, carrier):
    source = tmp_path / "marked.pdf"
    with fitz.open() as document:
        page = document.new_page()
        layer = document.add_ocg(PRIVATE, on=True) if carrier == "visible-layer-name" else 0
        page.insert_text((50, 50), "PUBLIC", oc=layer)
        if carrier == "actualtext":
            xref = page.get_contents()[0]
            document.update_stream(xref, f"/Span << /ActualText ({PRIVATE}) /Alt ({PRIVATE}) >> BDC\n".encode()
                                   + document.xref_stream(xref) + b"\nEMC")
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        assert PRIVATE.encode() in object_bytes(document)
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert "PUBLIC" in document[0].get_text()
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


def test_chinese_text_remains_searchable_and_public_pixels_are_preserved(processor, tmp_path):
    source = tmp_path / "chinese.pdf"
    with fitz.open() as document:
        page = new_page(document, True)
        page.insert_text((60, 80), "机密", fontname="china-s", fontsize=20)
        page.insert_text((60, 180), "公开内容", fontname="china-s", fontsize=20)
        public = page.search_for("公开内容")[0] * fitz.Matrix(2, 2)
        document.set_metadata({"author": PRIVATE})
        document.xref_set_key(page.xref, "UserUnit", "2")
        page = document.reload_page(page); page.set_rotation(90)
        expected = visible_pixels(page, display_rect(public, 90, 2))
        document.save(source)
    _, paths = outputs(processor, source, tmp_path, ["机密"])
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert "机密" not in document[0].get_text()
            assert "公开内容" in document[0].get_text()
            assert visible_pixels(document[0], display_rect(public, 90, 2)) == expected


def private_font():
    builder = FontBuilder(1000, isTTF=True)
    order = [".notdef", *dict.fromkeys("PUBLIC")]
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({ord(char): char for char in "PUBLIC"})
    glyphs = {}
    for glyph in order:
        pen = TTGlyphPen(None)
        pen.moveTo((50, 0)); pen.lineTo((500, 0)); pen.lineTo((500, 700)); pen.lineTo((50, 700)); pen.closePath()
        glyphs[glyph] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (600, 50) for name in order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupNameTable({"familyName": "Fixture", "styleName": "Regular", "fullName": "Fixture",
                            "psName": "Fixture", "uniqueFontIdentifier": PRIVATE,
                            "copyright": PRIVATE, "description": PRIVATE})
    builder.setupPost(); builder.setupMaxp()
    buffer = io.BytesIO(); builder.save(buffer)
    return buffer.getvalue()


@pytest.mark.parametrize("mode", ["local", "paddle"])
def test_embedded_font_name_metadata_is_absent_from_result_and_cloud_copy(processor, tmp_path, mode):
    source = tmp_path / "font.pdf"
    with fitz.open() as document:
        page = new_page(document, False)
        page.insert_font(fontname="fixture", fontbuffer=private_font())
        page.insert_text((40, 60), "PUBLIC", fontname="fixture", fontsize=24)
        if mode == "paddle":
            image = Image.new("RGB", (10, 10), "blue"); stream = io.BytesIO(); image.save(stream, "PNG")
            page.insert_image(fitz.Rect(50, 100, 100, 150), stream=stream.getvalue())
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        assert PRIVATE.encode("utf-16-be") in object_bytes(document)
        document.save(source)

    def fetch(path, *args, **kwargs):
        assert_no_carriers(path)
        return [{"tokens": [], "img_w": 600, "img_h": 400}]

    with patch.object(processor, "_fetch_paddle_all_pages", side_effect=fetch):
        _, paths = outputs(processor, source, tmp_path, ["ABSENT"], {
            "ocr_mode": mode, "paddle_api_url": "https://8.8.8.8", "paddle_token": "synthetic",
        })
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert "PUBLIC" in document[0].get_text()
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


def test_cropbox_hidden_image_pixels_are_removed_while_public_pixels_are_unchanged(processor, tmp_path):
    source = tmp_path / "cropped-image.pdf"
    image = Image.new("RGB", (400, 100), "white")
    image.paste((13, 91, 173), (200, 0, 400, 100))
    encoded = io.BytesIO(); image.save(encoded, "PNG")
    original_pixels = image.tobytes()
    with fitz.open() as document:
        page = document.new_page(width=400, height=200)
        page.insert_image(fitz.Rect(0, 0, 400, 100), stream=encoded.getvalue())
        page.insert_text((40, 150), "PUBLIC")
        page.set_cropbox(fitz.Rect(0, 0, 200, 200))
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        document.save(source)
    with patch.object(processor, "_get_page_ocr_data_by_mode", return_value={"tokens": [], "scale_to_pdf": 1}):
        _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as document:
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected
            for xref in range(1, document.xref_length()):
                if document.xref_get_key(xref, "Subtype") != ("name", "/Image"):
                    continue
                pix = fitz.Pixmap(document, xref)
                assert pix.samples != original_pixels
                if pix.width == 400:
                    hidden = b"".join(pix.samples[y * pix.stride + 200 * pix.n:(y + 1) * pix.stride]
                                      for y in range(pix.height))
                    assert len(set(hidden)) == 1


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [0.5, 2])
def test_disjoint_source_redaction_quads_do_not_delete_public_text_between_them(processor, tmp_path, rotation, unit):
    source = tmp_path / "quads.pdf"
    with fitz.open() as document:
        page = new_page(document, False)
        page.insert_text((50, 60), "SECRET_A", fontsize=18)
        page.insert_text((50, 130), "PUBLIC_MIDDLE", fontsize=18)
        page.insert_text((50, 200), "SECRET_B", fontsize=18)
        first, last = page.search_for("SECRET_A")[0], page.search_for("SECRET_B")[0]
        public = page.search_for("PUBLIC_MIDDLE")[0] * fitz.Matrix(unit, unit)
        annotation = page.add_redact_annot(first | last)
        transform = ~page.transformation_matrix
        points = [point * transform for rect in (first, last) for point in (rect.tl, rect.tr, rect.bl, rect.br)]
        document.xref_set_key(annotation.xref, "QuadPoints", "[" + " ".join(str(value) for point in points for value in point) + "]")
        document.xref_set_key(page.xref, "UserUnit", str(unit))
        page = document.reload_page(page); page.set_rotation(rotation)
        expected = page.get_pixmap(dpi=72, alpha=False, annots=False,
                                  clip=display_rect(public, rotation, unit)).samples
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as document:
            assert "SECRET" not in document[0].get_text()
            assert "PUBLIC_MIDDLE" in document[0].get_text()
            assert visible_pixels(document[0], display_rect(public, rotation, unit)) == expected


def test_indirect_userunit_keeps_a_valid_page_usable(processor, tmp_path):
    source = tmp_path / "indirect.pdf"
    with fitz.open() as document:
        page = document.new_page(width=400, height=300); page.insert_text((40, 50), "PUBLIC")
        unit = document.get_new_xref(); document.update_object(unit, "2")
        document.xref_set_key(page.xref, "UserUnit", f"{unit} 0 R")
        page = document.reload_page(page)
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        with fitz.open(path) as document:
            assert document[0].rect == fitz.Rect(0, 0, 800, 600)
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


def test_invisible_text_layer_is_not_retained(processor, tmp_path):
    source = tmp_path / "invisible.pdf"
    with fitz.open() as document:
        page = document.new_page(); page.insert_text((40, 40), "PUBLIC")
        page.insert_text((40, 100), PRIVATE, render_mode=3)
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert document[0].get_text().strip() == "PUBLIC"
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


@pytest.mark.parametrize("fontname", ["helv", "hebo", "heit", "hebi", "cour", "cobo", "coit", "cobi", "tiro", "tibo", "tiit", "tibi"])
def test_font_styles_keep_their_public_appearance_after_metadata_cleanup(processor, tmp_path, fontname):
    source = tmp_path / "style.pdf"
    with fitz.open() as document:
        page = document.new_page(); page.insert_text((40, 50), "PUBLIC", fontname=fontname, fontsize=24)
        document.set_metadata({"author": PRIVATE})
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected


def test_cff_copyright_metadata_is_removed_without_changing_glyphs(processor, tmp_path):
    font_context = TTFont(recalcBBoxes=False)
    cff = CFFFontSet(); cff.decompile(io.BytesIO(fitz.Font("helv").buffer), font_context)
    cff.topDictIndex[0].Notice = PRIVATE
    cff.topDictIndex[0].Copyright = PRIVATE
    stream = io.BytesIO(); cff.compile(stream, font_context)
    source = tmp_path / "cff.pdf"
    with fitz.open() as document:
        page = document.new_page(); page.insert_font(fontname="fixture", fontbuffer=stream.getvalue())
        page.insert_text((40, 60), "PUBLIC", fontname="fixture", fontsize=24)
        expected = page.get_pixmap(dpi=72, alpha=False).samples
        assert PRIVATE.encode() in object_bytes(document)
        document.save(source)
    _, paths = outputs(processor, source, tmp_path)
    for path in paths:
        assert_no_carriers(path)
        with fitz.open(path) as document:
            assert document[0].get_pixmap(dpi=72, alpha=False).samples == expected
