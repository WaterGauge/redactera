"""Exports must not depend on a PDF viewer discovering an invalid saved file."""
from pathlib import Path
from typing import Any

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor


def source_pdf(path: Path, pages: int = 2) -> None:
    with fitz.open() as document:
        for _ in range(pages):
            document.new_page().insert_text((40, 60), "SECRET PUBLIC")
        document.save(path)


def test_saved_result_is_checked_without_a_preview(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source_pdf(source)
    processor = PDFProcessor()
    try:
        result = processor.desensitize(str(source), ["SECRET"], {})
        with fitz.open(result["output_path"]) as saved:
            assert saved.page_count == result["review"]["pageCount"] == 2
            assert all("SECRET" not in page.get_text() and "PUBLIC" in page.get_text() for page in saved)
    finally:
        processor.cleanup()


@pytest.mark.parametrize("replacement", [b"", b"%PDF-1.7 broken output", "one-page"])
def test_real_saved_file_corruption_or_truncation_is_not_a_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replacement: Any,
) -> None:
    source, other = tmp_path / "source.pdf", tmp_path / "other.pdf"
    source_pdf(source)
    source_pdf(other, 1)
    payload = other.read_bytes() if replacement == "one-page" else replacement
    original = fitz.Document.save

    def damaged_save(document: Any, filename: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(document, filename, *args, **kwargs)
        if isinstance(filename, (str, Path)):
            Path(filename).write_bytes(payload)
        return result

    processor = PDFProcessor()
    monkeypatch.setattr(fitz.Document, "save", damaged_save)
    try:
        with pytest.raises(ValueError, match="输出文件检查未通过"):
            processor.desensitize(str(source), ["SECRET"], {})
    finally:
        processor.cleanup()


@pytest.mark.parametrize("report", [
    {"version": 1, "pageCount": 1, "regions": []},
    {"version": 1, "pageCount": 0, "regions": []},
    {"version": 1, "pageCount": True, "regions": []},
    {"version": 1, "pageCount": 2, "regions": [{"id": "r1", "page": 3}]},
    {"version": 1, "pageCount": 2, "regions": [
        {"id": "r1", "page": 1, "origin": "keyword", "keywords": ["SECRET"],
         "polygon": [[.1, .1], [.1, .1], [.1, .1]]}]},
])
def test_inconsistent_report_is_rejected(tmp_path: Path, report: dict[str, Any]) -> None:
    target = tmp_path / "saved.pdf"
    source_pdf(target)
    with pytest.raises(ValueError, match="输出文件检查未通过"):
        PDFProcessor._validate_final_output(str(target), report)
