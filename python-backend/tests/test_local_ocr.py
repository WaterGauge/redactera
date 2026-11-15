import subprocess
from unittest.mock import Mock

import pytest

import local_ocr


HEADER = b'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\r\n'
PAGE = b'1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t\r\n'


def test_windows_stdout_accepts_crlf_utf8_and_blank_pages(monkeypatch):
    word = '5\t1\t2\t1\t3\t1\t14\t19\t50\t20\t79.9\t张三\r\n'.encode()
    engine = Mock(side_effect=[Mock(stdout=HEADER + PAGE + word), Mock(stdout=HEADER + PAGE)])
    monkeypatch.setattr(local_ocr.subprocess, 'run', engine)

    result = local_ocr._windows_ocr_data(b'png', 'chi_sim+eng', 1.5, None)
    assert result['text'] == ['', '张三']
    assert result['block_num'] == [0, 2] and result['line_num'] == [0, 3]
    assert result['conf'] == [-1, 79]
    assert local_ocr._windows_ocr_data(b'png', 'eng', None, None)['text'] == ['']


@pytest.mark.parametrize('output', [b'', HEADER, HEADER + PAGE + b'truncated\trow', HEADER + b'\xff'])
def test_windows_missing_or_malformed_tsv_cannot_be_a_clean_scan(monkeypatch, output):
    monkeypatch.setattr(local_ocr.subprocess, 'run', Mock(return_value=Mock(stdout=output)))
    with pytest.raises(RuntimeError, match='invalid OCR data'):
        local_ocr._windows_ocr_data(b'png', 'eng', 5, None)


@pytest.mark.parametrize('failure, expected', [
    (subprocess.TimeoutExpired(['private-command'], 5, output=b'private-output'), TimeoutError),
    (subprocess.CalledProcessError(1, ['private-command'], output=b'private-output'), RuntimeError),
])
def test_windows_engine_failure_preserves_timeout_without_returning_ocr_content(monkeypatch, failure, expected):
    monkeypatch.setattr(local_ocr.subprocess, 'run', Mock(side_effect=failure))
    with pytest.raises(expected) as error:
        local_ocr._windows_ocr_data(b'png', 'eng', 5, None)
    assert 'private' not in str(error.value)
