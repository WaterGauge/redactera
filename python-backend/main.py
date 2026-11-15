import sys
import json
import os
import re
import tempfile
from typing import Any, Iterable, Mapping

# Only the backend entry point owns its streams; importing must preserve the host.
if sys.platform == 'win32' and __name__ == '__main__':
    import io
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding='utf-8')

# The read-only recovery probe must not initialize PDF/OCR or a worker job.
if __name__ == '__main__' and sys.argv[1:] == ['--session-probe']:
    from windows_lifecycle import snapshot
    from build_info import backend_contract
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError('Process query is too large')
        print(json.dumps({'type': 'session-process-snapshot',
                          'contract': backend_contract(), **snapshot(json.loads(raw))}), flush=True)
    except Exception:
        print(json.dumps({'type': 'session-process-snapshot', 'error': 'unavailable'}), flush=True)
        sys.exit(1)
    sys.exit(0)

import logging
from windows_lifecycle import worker_identity
from datetime import datetime
from pdf_processor import PDFProcessor
from request_context import check_deadline, report_progress, request_scope
from diagnostics import configure_diagnostics, log_event
from build_info import backend_contract, self_check

DEBUG_MODE = os.getenv('DEBUG_MODE', '0') == '1'

# 配置日志
log_enabled = os.getenv('LOG_ENABLED', '0') == '1'
log_file_path = os.getenv('LOG_FILE_PATH', '')


processor = PDFProcessor()


def send_progress(message: str, request_id: object = None, generation: object = None, **details: Any) -> None:
    """发送进度通知到前端"""
    progress: dict[str, Any] = {"type": "progress", "message": message}
    if request_id is not None:
        progress.update(requestId=request_id, generation=generation, **details)
    print(json.dumps(progress), flush=True)


def _looks_like_path(value: str) -> bool:
    """Heuristically identify path-like strings that should be scrubbed."""

    return any(separator in value for separator in ('/', '\\')) or bool(re.match(r'^[A-Za-z]:[\\/]', value))


def _iter_payload_paths(payload: Mapping[str, Any]) -> list[str]:
    """Collect path-like values from nested payload structures."""

    discovered: list[str] = []

    def visit(value: Any, key_hint: str = '') -> None:
        if isinstance(value, Mapping):
            for key, item in value.items():
                visit(item, str(key))
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                visit(item, key_hint)
            return
        if not isinstance(value, str):
            return
        lowered_hint = key_hint.lower()
        if 'path' in lowered_hint or _looks_like_path(value):
            discovered.append(value)

    visit(payload)
    return discovered


def _path_replacements(path_value: str) -> list[tuple[str, str]]:
    """Build raw and fragment replacements for a sensitive path."""

    raw = path_value.strip()
    if not raw:
        return []

    normalized = os.path.normpath(raw)
    variants: list[tuple[str, str]] = [
        (raw, '<path>'),
        (normalized, '<path>'),
    ]

    basename = os.path.basename(normalized)
    if basename:
        variants.append((basename, '<file>'))

    parts = [part for part in re.split(r'[\\/]+', normalized) if part and part not in ('.', '..')]
    for index in range(len(parts)):
        fragment = '/'.join(parts[index:])
        if len(fragment) >= len(basename or '') and _looks_like_path(fragment):
            variants.append((fragment, '<path>'))

    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for variant in sorted(variants, key=lambda item: len(item[0]), reverse=True):
        if not variant[0] or variant in seen:
            continue
        seen.add(variant)
        unique.append(variant)
    return unique


def sanitize_error_message(message: str, payload: Mapping[str, Any]) -> str:
    """Scrub path values and trailing path fragments from an error message."""

    sanitized = message
    for path_value in _iter_payload_paths(payload):
        for target, replacement in _path_replacements(path_value):
            sanitized = re.sub(re.escape(target), replacement, sanitized, flags=re.IGNORECASE)
    return sanitized


def handle_message(message: Mapping[str, Any]) -> None:
    """Handle one frontend request message and emit a JSON response."""

    action = message.get('action')
    payload = message.get('payload', {})
    request_id = message.get('requestId')

    log_event('request.received', action)

    # Validate required fields
    if not action or not request_id:
        log_event('request.invalid', action)
        print(json.dumps({
            'success': False,
            'error': 'Missing required fields: action or requestId',
            'requestId': request_id or 'unknown'
        }), flush=True)
        return

    def execute() -> Any:
        result: Any
        if action == 'upload':
            if not isinstance(payload, Mapping) or 'file_path' not in payload:
                raise ValueError('Missing required field: file_path')
            result = processor.extract_text(str(payload['file_path']))
        elif action == 'desensitize':
            if not isinstance(payload, Mapping) or 'file_path' not in payload or 'keywords' not in payload:
                raise ValueError('Missing required fields: file_path or keywords')
            result = processor.desensitize(
                str(payload['file_path']),
                payload['keywords'],
                settings=payload.get('settings', {}),
                progress_callback=lambda message: report_progress('ocr', message)
            )
        elif action == 'export':
            if not isinstance(payload, Mapping) or 'file_path' not in payload or 'format' not in payload:
                raise ValueError('Missing required fields: file_path or format')
            result = processor.export(
                str(payload['file_path']),
                str(payload['format']),
                str(payload['save_path']) if payload.get('save_path') else None,
                dpi=payload.get('dpi', 150),
            )
        else:
            result = {'error': 'Unknown action'}
        return result

    try:
        def progress(event: dict[str, Any]) -> None:
            send_progress(event['message'], request_id=request_id, generation=message.get('generation'),
                          **{key: value for key, value in event.items() if key != 'message'})
        with request_scope(message.get('deadlineMs'), progress):
            result = execute()
            check_deadline()
        log_event('request.completed', action)
        response: dict[str, Any] = {
            'success': True,
            'data': result,
            'requestId': request_id
        }
    except Exception as e:
        log_event('request.failed', action, e)
        error_msg = str(e)
        if not DEBUG_MODE and isinstance(payload, Mapping):
            error_msg = sanitize_error_message(error_msg, payload)
        response = {
            'success': False,
            'error': error_msg,
            'requestId': request_id
        }

    response.update(type='result', generation=message.get('generation'))
    print(json.dumps(response), flush=True)

def _record_worker_state(state: str) -> bool:
    """Persist this worker's identity before accepting any document request."""
    root = os.getenv('PDF_DESENSITIZATION_TEMP_ROOT')
    if not root:
        return False
    session = os.environ['PDF_DESENSITIZATION_SESSION']
    generation = os.environ['PDF_DESENSITIZATION_GENERATION']
    if not os.path.isabs(root) or not os.path.isdir(root) or os.path.islink(root):
        raise RuntimeError('Application temporary directory is unavailable')
    # Explicitly pin tempfile instead of letting an invalid TMPDIR fall back.
    tempfile.tempdir = root
    record = {'session': session, 'generation': generation, 'pid': os.getpid(),
              'parentPid': os.getppid(), 'state': state,
              'groupPid': os.getpgrp() if hasattr(os, 'getpgrp') else None}
    record.update(worker_identity(session, generation))
    fd, temporary = tempfile.mkstemp(prefix='.worker-', dir=root)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, os.path.join(root, 'worker.json'))
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return True


def serve(lines: Iterable[str]) -> None:
    for line in lines:
        try:
            message = json.loads(line)
            if not isinstance(message, Mapping):
                log_event('request.invalid')
                continue
            handle_message(message)
        except json.JSONDecodeError as error:
            log_event('protocol.invalid_json', error=error)
        except Exception as error:
            log_event('protocol.failed', error=error)


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-check']:
        print(json.dumps(self_check()), flush=True)
        sys.exit(0)
    registered_worker = False
    try:
        configure_diagnostics(log_enabled, log_file_path)
        registered_worker = _record_worker_state('running')
        log_event('backend.started')
        print(json.dumps({'type': 'ready', **backend_contract()}), flush=True)
        serve(sys.stdin)
    except Exception as e:
        log_event('backend.failed', error=e)
    finally:
        log_event('backend.stopping')
        try:
            processor.cleanup()
            if registered_worker:
                _record_worker_state('stopped')
        except Exception as error:
            log_event('backend.failed', error=error)
            sys.exit(1)
