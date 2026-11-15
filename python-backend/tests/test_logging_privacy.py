import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SECRET = 'SYNTHETIC_凭证_"token\\keyword\nDOC_CONTENT'


@pytest.mark.parametrize('enabled', [False, True])
@pytest.mark.parametrize('debug', [False, True])
def test_cli_diagnostics_do_not_echo_inputs_or_errors_but_keep_protocol(tmp_path, enabled, debug):
    path = tmp_path / 'SYNTHETIC_DOCUMENT.pdf'
    logfile = tmp_path / 'application.log'
    env = {**os.environ, 'LOG_ENABLED': str(int(enabled)), 'LOG_FILE_PATH': str(logfile), 'DEBUG_MODE': str(int(debug))}
    for key in ('PDF_DESENSITIZATION_TEMP_ROOT', 'PDF_DESENSITIZATION_SESSION', 'PDF_DESENSITIZATION_GENERATION'):
        env.pop(key, None)
    payload = {'file_path': str(path), 'keywords': [SECRET], 'settings': {'paddle_token': SECRET}}
    lines = [f'{{"token":{json.dumps(SECRET)}, BROKEN', json.dumps({'action': SECRET, 'requestId': SECRET, 'payload': payload}),
             json.dumps({'action': 'upload', 'requestId': 'req-control', 'payload': payload})]
    result = subprocess.run([sys.executable, str(ROOT / 'main.py')], input='\n'.join(lines) + '\n', text=True,
                            capture_output=True, env=env, timeout=20, check=True)
    logs = (logfile.read_text() if logfile.exists() else '') + result.stderr
    assert 'SYNTHETIC' not in logs and str(path) not in logs
    responses = [json.loads(line) for line in result.stdout.splitlines()]
    from build_info import source_contract
    assert responses[0] == {'type': 'ready', **source_contract()}
    assert len(responses) == 3
    assert responses[1]['requestId'] == SECRET and responses[1]['success'] is True
    assert responses[2]['requestId'] == 'req-control' and responses[2]['success'] is False
    assert str(path) in responses[2]['error'] if debug else str(path) not in responses[2]['error']
    assert not enabled or 'upload' in logs
    assert 'ERROR' in logs  # Errors remain observable without their bodies.


@pytest.mark.parametrize('write_failure', [False, True])
def test_third_party_warning_debug_and_traceback_cannot_bypass_diagnostic_formatter(tmp_path, write_failure):
    logfile = tmp_path / 'application.log'
    code = """
import runpy, logging, os
module = runpy.run_path('main.py', run_name='privacy_probe')
module['configure_diagnostics'](True, os.environ['LOG_FILE_PATH'])
if FAILURE:
    class Broken:
        def write(self, value): raise OSError('SYNTHETIC_WRITE_ERROR')
        def flush(self): pass
        def close(self): pass
    for handler in logging.getLogger().handlers: handler.setStream(Broken())
logging.getLogger('urllib3.connectionpool').debug('SYNTHETIC_URL/%s', 'SYNTHETIC_TOKEN')
logging.getLogger('fontTools').warning('SYNTHETIC_DOCUMENT_CONTENT')
try: raise ValueError('SYNTHETIC_EXCEPTION')
except ValueError: logging.exception('SYNTHETIC_MESSAGE')
""".replace('FAILURE', repr(write_failure))
    env = {**os.environ, 'LOG_ENABLED': '1', 'LOG_FILE_PATH': str(logfile)}
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, text=True, capture_output=True, env=env, timeout=20, check=True)
    logs = (logfile.read_text() if logfile.exists() else '') + result.stderr
    assert 'SYNTHETIC' not in logs
    assert 'diagnostic' in logs.lower() or 'Diagnostic' in logs


def test_preconfigured_root_handler_cannot_keep_raw_diagnostic_copies(tmp_path):
    logfile, previous = tmp_path / 'application.log', tmp_path / 'preconfigured.log'
    code = """
import logging, runpy, os
logging.basicConfig(level=logging.DEBUG, filename=PREVIOUS)
host_handlers = tuple(logging.getLogger().handlers)
module = runpy.run_path('main.py', run_name='privacy_probe')
assert tuple(logging.getLogger().handlers) == host_handlers
module['configure_diagnostics'](True, os.environ['LOG_FILE_PATH'])
logging.warning('SYNTHETIC_WARNING')
logging.getLogger('urllib3.connectionpool').debug('SYNTHETIC_TOKEN')
""".replace('PREVIOUS', repr(str(previous)))
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, text=True, capture_output=True,
                            env={**os.environ, 'LOG_ENABLED': '1', 'LOG_FILE_PATH': str(logfile)}, timeout=20, check=True)
    logs = ''.join(p.read_text() for p in [logfile, previous] if p.exists()) + result.stderr
    assert 'SYNTHETIC' not in logs
    assert 'External diagnostic' in logfile.read_text()


def test_real_logfile_open_failure_never_echoes_record_or_log_path(tmp_path):
    parent = tmp_path / 'SYNTHETIC_PARENT'; parent.write_text('blocks directory creation')
    code = "import runpy,logging,os; m=runpy.run_path('main.py',run_name='privacy_probe'); m['configure_diagnostics'](True,os.environ['LOG_FILE_PATH']); logging.error('SYNTHETIC_RECORD')"
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, text=True, capture_output=True,
                            env={**os.environ, 'LOG_ENABLED': '1', 'LOG_FILE_PATH': str(parent / 'private.log')}, timeout=20, check=True)
    assert 'SYNTHETIC' not in result.stderr
    assert 'Diagnostic log write failed' in result.stderr


def test_formatter_never_formats_objects_or_untrusted_metadata():
    import logging
    from diagnostics import DiagnosticFormatter
    class MustNotFormat:
        def __str__(self):
            raise AssertionError('SYNTHETIC_FORMATTED')
    record = logging.LogRecord('pdf_desensitization', logging.WARNING, 'SYNTHETIC_PATH', 1, MustNotFormat(), (MustNotFormat(),), None)
    record.pdf_event = 'request.received'
    record.pdf_action = 'SYNTHETIC_ACTION'
    record.pdf_error = 'SYNTHETIC_ERROR'
    text = DiagnosticFormatter().format(record)
    assert 'SYNTHETIC' not in text and 'action=unsupported' in text


@pytest.mark.parametrize('failure', ['cleanup', 'worker_state'])
def test_shutdown_failure_keeps_nonzero_exit_without_path_traceback(tmp_path, failure):
    worker = tmp_path / 'SYNTHETIC_CLOSE_PATH'; worker.mkdir()
    logfile = tmp_path / 'application.log'
    code = """
import io,os,runpy,sys
from pathlib import Path
import pdf_processor
class EndOfInput(io.StringIO):
    def __next__(self):
        marker = Path(os.environ['PDF_DESENSITIZATION_TEMP_ROOT']) / 'worker.json'
        if FAILURE == 'worker_state':
            marker.unlink(); marker.mkdir()
        raise StopIteration
if FAILURE == 'cleanup':
    def fail_cleanup(self): raise RuntimeError('SYNTHETIC_CLEANUP_BODY')
    pdf_processor.PDFProcessor.cleanup = fail_cleanup
sys.stdin = EndOfInput('')
runpy.run_path('main.py',run_name='__main__')
""".replace('FAILURE', repr(failure))
    env = {**os.environ, 'LOG_ENABLED': '1', 'LOG_FILE_PATH': str(logfile), 'PDF_DESENSITIZATION_TEMP_ROOT': str(worker),
           'PDF_DESENSITIZATION_SESSION': 'test-session', 'PDF_DESENSITIZATION_GENERATION': 'test-generation'}
    result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, text=True, capture_output=True, env=env, timeout=20)
    assert result.returncode == 1
    logs = logfile.read_text() + result.stderr
    assert 'SYNTHETIC' not in logs and 'Traceback' not in result.stderr
    assert 'Backend failed' in logs
