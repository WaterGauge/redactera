"""P2-01: one intermediate PNG, identical pixels, no published partial archive."""
import io
from pathlib import Path
import tempfile
import zipfile

import pymupdf as fitz
import pytest
from PIL import Image

import pdf_processor
from pdf_processor import PDFProcessor


@pytest.fixture
def workload(tmp_path, monkeypatch):
    private = tmp_path / 'worker'
    private.mkdir()
    monkeypatch.setattr(tempfile, 'tempdir', str(private))
    source = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        for index in range(4):
            page = doc.new_page(width=144, height=96)
            page.insert_text((20, 40), f'PUBLIC {index}', fontsize=10)
            page.set_rotation(index * 90)
        doc.save(source)
    processor = PDFProcessor()
    try:
        yield processor, source, private
    finally:
        processor.cleanup()


@pytest.mark.parametrize('dpi', [150, 200, 300])
def test_streams_one_page_and_keeps_order_and_pixels(workload, monkeypatch, dpi):
    processor, source, private = workload
    original = source.read_bytes()
    write = zipfile.ZipFile.write
    observed = []

    def spy(archive, filename, arcname=None, *args, **kwargs):
        assert len(list(private.rglob('*.png'))) == 1
        observed.append(arcname)
        return write(archive, filename, arcname, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, 'write', spy)
    result = processor.export(str(source), 'png_zip', dpi=dpi)
    names = [f'page_{i}.png' for i in range(1, 5)]
    assert observed == names
    with fitz.open(source) as doc, zipfile.ZipFile(result['zip_path']) as archive:
        assert archive.namelist() == names and archive.testzip() is None
        for page, name in zip(doc, names):
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            with Image.open(io.BytesIO(archive.read(name))) as image:
                assert image.size == (pix.width, pix.height)
                assert image.info['dpi'] == pytest.approx((dpi, dpi), abs=.02)
                assert image.convert('RGB').tobytes() == pix.samples
    assert source.read_bytes() == original
    assert list(private.iterdir()) == [Path(result['zip_path'])]


@pytest.mark.parametrize('failure', ['zip_write', 'deadline'])
def test_failure_after_first_page_removes_partial_archive(workload, monkeypatch, failure):
    processor, source, private = workload
    original = source.read_bytes()
    write = zipfile.ZipFile.write
    written = []

    def spy(archive, filename, arcname=None, *args, **kwargs):
        if written and failure == 'zip_write':
            raise OSError('Synthetic write failure')
        value = write(archive, filename, arcname, *args, **kwargs)
        written.append(arcname)
        return value

    def deadline(stage, message, completed=None, total=None):
        if written and failure == 'deadline':
            raise TimeoutError('Synthetic deadline')

    monkeypatch.setattr(zipfile.ZipFile, 'write', spy)
    monkeypatch.setattr(pdf_processor, 'report_progress', deadline)
    with pytest.raises((OSError, TimeoutError), match='Synthetic'):
        processor.export(str(source), 'png_zip')
    assert written == ['page_1.png']
    assert list(private.iterdir()) == []
    assert source.read_bytes() == original
