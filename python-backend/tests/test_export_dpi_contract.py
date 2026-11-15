"""CR-011: image export DPI crosses the complete backend boundary."""
import io
import json
import math
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pymupdf as fitz
import pytest
from PIL import Image

import main
from pdf_processor import PDFProcessor


@pytest.fixture
def processor():
    value = PDFProcessor()
    yield value
    value.cleanup()


def source_pdf(file, rotation=0, unit=1):
    with fitz.open() as doc:
        page = doc.new_page(width=144, height=96)
        page.insert_text((20, 40), "PUBLIC", fontsize=10)
        page.set_cropbox(fitz.Rect(8, 6, 133, 83))
        doc.xref_set_key(page.xref, "UserUnit", str(unit))
        page.set_rotation(rotation)
        doc.save(file)


@pytest.mark.parametrize("format_type", ["png", "png_zip"])
@pytest.mark.parametrize("dpi", [150, 200, 300])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("unit", [1, 2])
def test_pixels_metadata_rotation_crop_and_units(processor, tmp_path, format_type, dpi, rotation, unit):
    source = tmp_path / "original.pdf"
    source_pdf(source, rotation, unit)
    original = source.read_bytes()
    result = processor.export(str(source), format_type, dpi=dpi)
    if format_type == "png":
        data = Path(result["output_files"][0]).read_bytes()
    else:
        with zipfile.ZipFile(result["zip_path"]) as archive:
            assert archive.namelist() == ["page_1.png"]
            data = archive.read("page_1.png")
    width, height = (77, 125) if rotation in (90, 270) else (125, 77)
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (math.ceil(width * unit * dpi / 72), math.ceil(height * unit * dpi / 72))
        assert image.info["dpi"] == pytest.approx((dpi, dpi), abs=0.02)
    assert source.read_bytes() == original


@pytest.mark.parametrize("dpi", [0, 149, 600, True, "300", None, 150.0, float("nan"), float("inf")])
@pytest.mark.parametrize("format_type", ["png", "png_zip", "pdf"])
def test_invalid_dpi_rejected_before_io(processor, dpi, format_type):
    with pytest.raises(ValueError, match="dpi"):
        processor.export("/missing/source.pdf", format_type, dpi=dpi)
    assert processor._temp_files == []


@pytest.mark.parametrize("format_type", ["png", "png_zip"])
def test_omitted_dpi_remains_150(processor, tmp_path, format_type):
    source = tmp_path / "original.pdf"
    source_pdf(source)
    result = processor.export(str(source), format_type)
    if format_type == "png":
        data = Path(result["output_files"][0]).read_bytes()
    else:
        with zipfile.ZipFile(result["zip_path"]) as archive:
            data = archive.read("page_1.png")
    with Image.open(io.BytesIO(data)) as image:
        assert image.info["dpi"] == pytest.approx((150, 150), abs=0.02)


def test_pdf_stays_vector_and_byte_identical(processor, tmp_path):
    source, target = tmp_path / "original.pdf", tmp_path / "export.pdf"
    source_pdf(source)
    processor.export(str(source), "pdf", str(target), dpi=300)
    assert source.read_bytes() == target.read_bytes()
    with fitz.open(target) as doc:
        assert "PUBLIC" in doc[0].get_text()
        assert not doc[0].get_images()


@pytest.mark.parametrize("dpi", [150, 200, 300])
def test_json_protocol_forwards_dpi(monkeypatch, capsys, dpi):
    fake = Mock()
    fake.export.return_value = {"output_files": []}
    monkeypatch.setattr(main, "processor", fake)
    main.handle_message({"requestId": "dpi-control", "action": "export",
                         "payload": {"file_path": "/synthetic.pdf", "format": "png", "dpi": dpi}})
    assert json.loads(capsys.readouterr().out)["success"]
    fake.export.assert_called_once_with("/synthetic.pdf", "png", None, dpi=dpi)
