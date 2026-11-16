"""P2-02: exercise the independent saved-file oracle, including deliberate bad outputs."""
import importlib.util
from pathlib import Path

import pymupdf as fitz
import pytest

from pdf_processor import PDFProcessor

ROOT = Path(__file__).resolve().parents[2]
SUPPORT = ROOT / 'e2e/support/verify-output.py'
spec = importlib.util.spec_from_file_location('saved_output_oracle', SUPPORT)
assert spec and spec.loader
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
SECRET = 'SYNTHETIC_PRIVATE_84F7D2'
PUBLIC = 'SYNTHETIC_PUBLIC_17B6'
CONTRACT = {'pageCount': 2, 'keywords': [SECRET], 'public': [PUBLIC], 'objectMarkers': [SECRET]}


@pytest.fixture
def source(tmp_path):
    path = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        for _ in range(2):
            page = doc.new_page()
            page.insert_text((40, 70), PUBLIC)
            page.insert_text((40, 120), SECRET)
        doc.set_metadata({'title': SECRET})
        doc.embfile_add('synthetic.txt', SECRET.encode())
        doc.save(path, garbage=4, deflate=True)
    return path


@pytest.fixture
def result(source, tmp_path):
    original = source.read_bytes()
    processor = PDFProcessor()
    try:
        receipt = processor.desensitize(str(source), [SECRET], {'ocr_mode': 'local'})
        target = tmp_path / 'result.pdf'
        target.write_bytes(Path(receipt['output_path']).read_bytes())
        assert source.read_bytes() == original
        oracle.verify_pdf(target, source, CONTRACT)
        return target
    finally:
        processor.cleanup()


def test_actual_saved_pdf(result, source):
    oracle.verify_pdf(result, source, CONTRACT)


def test_black_overlay_cannot_pass(source, tmp_path):
    bad = tmp_path / 'overlay.pdf'
    with fitz.open(source) as doc:
        for page in doc:
            for rect in page.search_for(SECRET):
                page.draw_rect(rect, color=None, fill=(0, 0, 0))
        doc.set_metadata({})
        doc.embfile_del('synthetic.txt')
        doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Sensitive'):
        oracle.verify_pdf(bad, source, CONTRACT)


@pytest.mark.parametrize('carrier', ['metadata', 'embedded', 'raw_revision'])
def test_hidden_or_historical_marker_cannot_pass(source, result, tmp_path, carrier):
    bad = tmp_path / 'hidden.pdf'
    if carrier == 'raw_revision':
        bad.write_bytes(result.read_bytes() + b'\n% ' + SECRET.encode() + b'\n')
    else:
        with fitz.open(result) as doc:
            if carrier == 'metadata':
                doc.set_metadata({'subject': SECRET})
            else:
                doc.embfile_add('hidden.txt', SECRET.encode())
            doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Sensitive'):
        oracle.verify_pdf(bad, source, CONTRACT)


def test_public_control_cannot_move_to_wrong_page(source, result, tmp_path):
    bad = tmp_path / 'public.pdf'
    with fitz.open(result) as doc:
        page = doc[1]
        for rect in page.search_for(PUBLIC):
            page.add_redact_annot(rect)
        page.apply_redactions()
        doc[0].insert_text((40, 200), PUBLIC)
        doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Public control text missing'):
        oracle.verify_pdf(bad, source, CONTRACT)


def test_missing_source_target_cannot_certify(result, source):
    with pytest.raises(AssertionError, match='Missing source sensitive control'):
        oracle.verify_pdf(result, source, {**CONTRACT, 'keywords': ['NOT_IN_SOURCE']})


@pytest.mark.parametrize('carrier', ['metadata', 'embedded', 'raw_revision'])
def test_unicode_keyword_in_default_contract_cannot_pass(tmp_path, carrier):
    original = tmp_path / 'unicode-source.pdf'
    result = tmp_path / 'unicode-result.pdf'
    bad = tmp_path / 'unicode-bad.pdf'
    contract = {'pageCount': 1, 'keywords': ['SECRET', '张三'], 'public': ['PUBLIC CONTROL']}
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), 'PUBLIC CONTROL')
        page.insert_text((40, 120), 'SECRET')
        page.insert_text((40, 160), '张三', fontname='china-s')
        doc.save(original)
    with fitz.open(original) as doc:
        for word in contract['keywords']:
            for rect in doc[0].search_for(word):
                doc[0].add_redact_annot(rect)
        doc[0].apply_redactions()
        doc.save(result, garbage=4, deflate=True)
    oracle.verify_pdf(result, original, contract)
    if carrier == 'raw_revision':
        bad.write_bytes(result.read_bytes() + b'\n% ' + '张三'.encode('utf-16-be') + b'\n')
    else:
        with fitz.open(result) as doc:
            if carrier == 'metadata':
                doc.set_metadata({'subject': '张三'})
            else:
                doc.embfile_add('hidden.txt', '张三'.encode('utf-8'))
            doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Sensitive'):
        oracle.verify_pdf(bad, original, contract)


def test_public_black_overlay_cannot_pass(source, result, tmp_path):
    bad = tmp_path / 'covered.pdf'
    with fitz.open(result) as doc:
        page = doc[0]
        for rect in page.search_for(PUBLIC):
            page.draw_rect(rect, color=None, fill=(0, 0, 0))
        assert PUBLIC in page.get_text()  # extractable, but not visible
        doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Public control pixels changed'):
        oracle.verify_pdf(bad, source, CONTRACT)


def test_crossline_fragments_in_pdf_string_are_rejected(tmp_path):
    original = tmp_path / 'split-source.pdf'
    output = tmp_path / 'split-result.pdf'
    bad = tmp_path / 'split-bad.pdf'
    contract = {'pageCount': 1, 'keywords': ['SECRET'], 'splitTarget': ['SEC', 'RET'], 'public': ['PUBLIC CONTROL']}
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 70), 'PUBLIC CONTROL')
        page.insert_text((40, 120), 'SEC')
        page.insert_text((40, 160), 'RET')
        doc.save(original)
    # The independent oracle accepts a genuinely removed split fixture,
    # then rejects a hidden PDF literal containing one split piece.
    with fitz.open(original) as doc:
        for word in contract['splitTarget']:
            for rect in doc[0].search_for(word):
                doc[0].add_redact_annot(rect)
        doc[0].apply_redactions()
        doc.save(output, garbage=4, deflate=True)
    oracle.verify_pdf(output, original, contract)
    with fitz.open(output) as doc:
        doc.set_metadata({'subject': 'RET'})
        doc.save(bad, garbage=4, deflate=True)
    with pytest.raises(AssertionError, match='Sensitive'):
        oracle.verify_pdf(bad, original, contract)
