"""Wire byte budget tests; no huge allocations or actual user payloads."""
import json
from unittest.mock import Mock

import pytest

import main
from request_context import report_progress


@pytest.fixture(autouse=True)
def small_budget(monkeypatch):
    monkeypatch.setattr(main, 'MAX_RESPONSE_FRAME_BYTES', 1024)
    monkeypatch.setattr(main, 'MAX_RESPONSE_BYTES', 2048)


def message(identifier='synthetic'):
    return {'action': 'upload', 'payload': {'file_path': '/synthetic.pdf'},
            'requestId': identifier, 'generation': 'one'}


def test_complete_ascii_wire_limit_and_next_request(monkeypatch, capsys):
    processor = Mock()
    processor.extract_text.side_effect = [{'pages': [{'text': '中文😀' * 100}]}, {'pages': [{'text': '中文😀'}]}]
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message(message())
    main.handle_message(message('next'))
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 2
    first, second = map(json.loads, lines)
    assert first == {'type': 'result', 'success': False, 'requestId': 'synthetic',
                     'generation': 'one', 'error': main.RESPONSE_LIMIT_ERROR}
    assert second['success'] is True and second['data']['pages'][0]['text'] == '中文😀'
    assert all(len(line.encode('ascii')) <= 1024 for line in lines)


def test_progress_aggregate_reserves_failure_terminal(monkeypatch, capsys):
    processor = Mock()

    def work(_path):
        for _ in range(100):
            report_progress('ocr', 'synthetic' * 30)
        return {'pages': [{'text': 'must not publish'}]}

    processor.extract_text.side_effect = work
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message(message())
    lines = capsys.readouterr().out.splitlines()
    rows = list(map(json.loads, lines))
    assert all(row['type'] == 'progress' for row in rows[:-1])
    assert rows[-1]['success'] is False and rows[-1]['error'] == main.RESPONSE_LIMIT_ERROR
    assert sum(len(line.encode('ascii')) + 2 for line in lines) <= 2048
    assert 'must not publish' not in ''.join(lines)


def test_nonfinite_result_fails_without_emitting_invalid_json(monkeypatch, capsys):
    processor = Mock()
    processor.extract_text.return_value = {'pages': [{'text': float('nan')}]}
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message(message())
    assert json.loads(capsys.readouterr().out)['error'] == main.RESPONSE_JSON_ERROR


@pytest.mark.parametrize('platform', ['win32', 'darwin'])
def test_frame_limit_counts_windows_cr(monkeypatch, capsys, platform):
    monkeypatch.setattr(main.sys, 'platform', platform)
    budget = main.ResponseBudget()
    value = {'x': 'a' * (1024 - len(json.dumps({'x': ''})) - (1 if platform == 'win32' else 0))}
    budget.emit(value, terminal=True)
    line = capsys.readouterr().out.rstrip('\n')
    assert len(line) + (1 if platform == 'win32' else 0) == 1024
    with pytest.raises(main.ResponseLimitError):
        budget.emit({'x': value['x'] + 'a'}, terminal=True)
    assert capsys.readouterr().out == ''
