import importlib
import json
import time
from unittest.mock import Mock

import pytest
import main


def messages(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_progress_has_request_and_generation_without_ending_the_request(monkeypatch, capsys):
    processor = Mock()
    def process(*args, **kwargs):
        kwargs['progress_callback']('waiting for OCR')
        return {'output_path': '/tmp/result.pdf'}
    processor.desensitize.side_effect = process
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message({'action': 'desensitize', 'requestId': 'req-A', 'generation': 'gen-A',
                         'deadlineMs': int(time.time() * 1000) + 60000,
                         'payload': {'file_path': '/tmp/source.pdf', 'keywords': ['SECRET']}})
    progress, result = messages(capsys)
    assert progress['type'] == 'progress'
    assert progress['requestId'] == result['requestId'] == 'req-A'
    assert progress['generation'] == result['generation'] == 'gen-A'
    assert progress['stage'] == 'ocr'
    assert progress['elapsedMs'] >= 0
    assert result['type'] == 'result' and result['success'] is True


@pytest.mark.parametrize('deadline', [0, -1, True, 'later', float('inf'), float('nan')])
def test_invalid_or_expired_deadline_never_invokes_processor(deadline, monkeypatch, capsys):
    processor = Mock()
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message({'action': 'upload', 'requestId': 'req-A', 'generation': 'gen-A',
                         'deadlineMs': deadline, 'payload': {'file_path': '/tmp/source.pdf'}})
    result, = messages(capsys)
    assert result['success'] is False
    assert result['type'] == 'result'
    processor.extract_text.assert_not_called()


def test_absolute_deadline_caps_network_wait_and_uses_monotonic_time(monkeypatch):
    context = importlib.import_module('request_context')
    wall, tick = [1000.0], [10.0]
    monkeypatch.setattr(context.time, 'time', lambda: wall[0])
    monkeypatch.setattr(context.time, 'monotonic', lambda: tick[0])
    with context.request_scope(1002000):
        assert context.request_timeout(30) == pytest.approx(2)
        wall[0] = -999999  # A wall-clock correction must not extend the budget.
        tick[0] += 1.5
        assert context.request_timeout(30) == pytest.approx(0.5)
        tick[0] += 0.5
        with pytest.raises(TimeoutError):
            context.check_deadline()
    assert context.request_timeout(30) == 30


def test_wait_never_sleeps_past_the_remaining_budget(monkeypatch):
    context = importlib.import_module('request_context')
    monkeypatch.setattr(context.time, 'time', lambda: 1000)
    tick, sleeps = [10.0], []
    monkeypatch.setattr(context.time, 'monotonic', lambda: tick[0])
    def sleep(seconds):
        sleeps.append(seconds)
        tick[0] += seconds
    monkeypatch.setattr(context.time, 'sleep', sleep)
    with context.request_scope(1001000):
        with pytest.raises(TimeoutError):
            context.wait_for(5)
    assert sleeps == [1]


def test_progress_does_not_refresh_deadline_and_scope_is_restored(monkeypatch):
    context = importlib.import_module('request_context')
    monkeypatch.setattr(context.time, 'time', lambda: 1000)
    tick, events = [10.0], []
    monkeypatch.setattr(context.time, 'monotonic', lambda: tick[0])
    with context.request_scope(1001000, events.append):
        context.report_progress('redacting', 'page', completed=1, total=2)
        assert events[0]['completed'] == 1 and events[0]['total'] == 2
        tick[0] += 1
        with pytest.raises(TimeoutError):
            context.report_progress('ocr', 'heartbeat')
    context.report_progress('ocr', 'outside request')
    assert len(events) == 1


def test_legacy_cli_request_without_deadline_still_returns_a_terminal(monkeypatch, capsys):
    processor = Mock()
    processor.extract_text.return_value = {'pages': []}
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message({'action': 'upload', 'requestId': 'legacy', 'payload': {'file_path': '/tmp/a.pdf'}})
    result, = messages(capsys)
    assert result['success'] is True and result['data'] == {'pages': []}


def clock(monkeypatch):
    context = importlib.import_module('request_context')
    tick = [0.0]
    monkeypatch.setattr(context.time, 'time', lambda: 1000)
    monkeypatch.setattr(context.time, 'monotonic', lambda: tick[0])
    monkeypatch.setattr(context.time, 'sleep', lambda seconds: tick.__setitem__(0, tick[0] + seconds))
    return context, tick


@pytest.mark.parametrize('queue_full', [False, True])
def test_paddle_submit_and_poll_backoff_stop_at_the_shared_deadline(tmp_path, monkeypatch, queue_full):
    import pdf_processor
    context, tick = clock(monkeypatch)
    source = tmp_path / 'synthetic.pdf'
    source.write_bytes(b'synthetic upload; HTTP is stubbed')
    response = Mock(status_code=429 if queue_full else 200, headers={'content-type': 'application/json'})
    response.json.return_value = {'code': 10010} if queue_full else {'data': {'jobId': 'job'}}
    post, get = Mock(return_value=response), Mock()
    monkeypatch.setattr(pdf_processor, 'paddle_request',
                        lambda method, url, **kwargs: (post if method == 'POST' else get)(url, **kwargs))
    with context.request_scope(1002000):
        with pytest.raises(TimeoutError):
            pdf_processor.PDFProcessor()._fetch_paddle_all_pages(str(source), 'https://ocr.invalid', 'synthetic-token')
    assert post.call_count == 1 and post.call_args.kwargs['timeout'] == 2
    get.assert_not_called()
    assert tick[0] == 2


def test_paddle_result_download_is_capped_by_remaining_budget(tmp_path, monkeypatch):
    import pdf_processor
    context, tick = clock(monkeypatch)
    source = tmp_path / 'synthetic.pdf'; source.write_bytes(b'synthetic upload')
    submitted = Mock(status_code=200); submitted.json.return_value = {'data': {'jobId': 'job'}}
    poll = Mock(); poll.json.return_value = {'data': {'state': 'done', 'resultUrl': {'jsonUrl': 'https://ocr.invalid/result'}}}
    download = Mock(text='{"result":{"layoutParsingResults":[]}}')
    calls = []
    def get(url, **kwargs):
        calls.append(kwargs['timeout'])
        tick[0] += 0.5
        return poll if len(calls) == 1 else download
    monkeypatch.setattr(pdf_processor, 'paddle_request',
                        lambda method, url, **kwargs: submitted if method == 'POST' else get(url, **kwargs))
    with context.request_scope(1008000):
        assert pdf_processor.PDFProcessor()._fetch_paddle_all_pages(str(source), 'https://ocr.invalid', 'synthetic-token') == []
    assert calls == [3, 2.5]  # Five seconds of polling wait, then the actual HTTP time.


def test_local_tesseract_receives_the_remaining_budget(monkeypatch):
    import pdf_processor
    context, _ = clock(monkeypatch)
    pix = Mock(width=1, height=1); pix.tobytes.return_value = b'fake-png'
    page = Mock(); page.get_pixmap.return_value = pix
    ocr = Mock(return_value={'text': []})
    monkeypatch.setattr(pdf_processor, 'read_ocr_data', ocr)
    with context.request_scope(1002000):
        pdf_processor.PDFProcessor()._get_page_ocr_data(page)
    assert ocr.call_args.kwargs['timeout'] == 2


def test_processor_finishing_after_deadline_cannot_return_success(monkeypatch, capsys):
    _, tick = clock(monkeypatch)
    processor = Mock()
    def late(*args):
        tick[0] += 2
        return {'pages': []}
    processor.extract_text.side_effect = late
    monkeypatch.setattr(main, 'processor', processor)
    main.handle_message({'action': 'upload', 'requestId': 'late', 'deadlineMs': 1001000,
                         'payload': {'file_path': '/tmp/a.pdf'}})
    result, = messages(capsys)
    assert result['success'] is False and 'deadline' in result['error']
    assert 'data' not in result
