"""Synthetic labelled matching diagnostic; no threshold selection or OCR accuracy claim."""
import json
from pathlib import Path
import sys

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python-backend'))
from pdf_processor import PDFProcessor, normalize_settings

# Labels express the intended meaning in this artificial fixture, not whether
# a real-world candidate is necessarily the same person/identifier.
CASES = (
    ('exact_latin', 'SECRET', 'SECRET', True),
    ('substitution_latin', 'SECRET', 'SECRE7', True),
    ('deletion_latin', 'SECRET', 'SECRT', True),
    ('insertion_latin', 'SECRET', 'SECXRET', True),
    ('public_latin', 'SECRET', 'SECTOR', False),
    ('unrelated_latin', 'SECRET', 'PUBLIC', False),
    ('exact_han', '合成甲乙', '合成甲乙', True),
    ('substitution_han', '合成甲乙', '合成甲丙', True),
    ('public_han', '合成甲乙', '合成丁戊', False),
    ('unrelated_han', '合成甲乙', '公开文书', False),
    ('short_exact', '张三', '张三', True),
    ('short_public', '张三', '张某三', False),
    ('short_latin_public', 'ABC', 'AXBC', False),
)
THRESHOLDS = (0.0, 0.5, 0.7, 0.85, 0.95, 1.0)


def evaluate():
    processor = PDFProcessor()
    try:
        rows = []
        for threshold in THRESHOLDS:
            for layer in ('text', 'synthetic-ocr-token'):
                settings = normalize_settings({'fuzzy_match_enabled': True, 'fuzzy_match_threshold': threshold,
                                               'redaction_scope': 'strict'})
                counts = dict(tp=0, fp=0, tn=0, fn=0)
                decisions = []
                for name, keyword, candidate, intended in CASES:
                    if layer == 'text':
                        with fitz.open() as doc:
                            page = doc.new_page(width=500, height=400)
                            page.insert_text((40, 70), candidate, fontname='china-s', fontsize=14)
                            assert candidate in page.get_text(), 'Missing positive glyph control'
                            regions = processor._find_text_rects(page, keyword, settings)[0]
                    else:
                        regions = processor._find_ocr_rects_with_warnings([
                            {'text': candidate, 'x': 40, 'y': 55, 'w': 100, 'h': 20,
                             'line_id': 'a', 'block_id': 'a'}], keyword, 400, 500, 1, settings)[0]
                    detected = bool(regions)
                    counts['tp' if intended and detected else 'fn' if intended else 'fp' if detected else 'tn'] += 1
                    decisions.append({'case': name, 'intended': intended, 'detected': detected})
                rows.append({'threshold': threshold, 'layer': layer, **counts, 'cases': decisions})
        return {'syntheticOnly': True, 'recognitionMeasured': False, 'defaultChanged': False, 'rows': rows}
    finally:
        processor.cleanup()


if __name__ == '__main__':
    print(json.dumps(evaluate(), ensure_ascii=False, indent=2))
