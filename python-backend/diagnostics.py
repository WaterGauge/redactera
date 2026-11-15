"""Allowlisted diagnostics; protocol/document data never becomes log text."""
from datetime import datetime, timezone
import errno
import logging
import sys
from typing import Optional

_LOGGER = 'pdf_desensitization'
_ACTIONS = {'upload', 'desensitize', 'export'}
_ERRORS = {'TimeoutError', 'PermissionError', 'FileNotFoundError', 'OSError', 'ValueError',
           'TypeError', 'KeyError', 'RuntimeError', 'JSONDecodeError', 'Error'}
_ERRNOS = {errno.EACCES: 'EACCES', errno.EPERM: 'EPERM', errno.ENOENT: 'ENOENT', errno.ENOSPC: 'ENOSPC',
           errno.EPIPE: 'EPIPE', errno.EIO: 'EIO', errno.EBUSY: 'EBUSY', errno.EEXIST: 'EEXIST'}
_EVENTS = {
    'backend.started': (logging.INFO, 'Backend started'),
    'backend.stopping': (logging.INFO, 'Backend stopping'),
    'backend.failed': (logging.ERROR, 'Backend failed'),
    'request.received': (logging.DEBUG, 'Request received'),
    'request.completed': (logging.INFO, 'Request completed'),
    'request.failed': (logging.ERROR, 'Request failed'),
    'request.invalid': (logging.ERROR, 'Invalid request'),
    'protocol.invalid_json': (logging.ERROR, 'Invalid protocol JSON'),
    'protocol.failed': (logging.ERROR, 'Protocol handling failed'),
    'cleanup.failed': (logging.WARNING, 'Temporary cleanup failed'),
}


def error_kind(error: BaseException) -> str:
    try:
        code = getattr(error, 'errno', None)
        if isinstance(code, int) and code in _ERRNOS:
            return _ERRNOS[code]
        for cls in (TimeoutError, PermissionError, FileNotFoundError, ValueError, TypeError, KeyError, RuntimeError, OSError):
            if isinstance(error, cls):
                return cls.__name__
    except Exception:
        pass
    return 'Error'


def log_event(event: str, action: object = None, error: Optional[BaseException] = None) -> None:
    level, text = _EVENTS.get(event, (logging.WARNING, 'Unknown diagnostic event'))
    logging.getLogger(_LOGGER).log(level, text, extra={
        'pdf_event': event,
        'pdf_action': action if isinstance(action, str) and action in _ACTIONS else 'unsupported',
        'pdf_error': error_kind(error) if error is not None else None,
    })


class DiagnosticFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # Never call getMessage(), formatException(), or formatStack(). Third
        # parties can put tokens/URLs/text in msg, args and exception objects.
        raw_event = getattr(record, 'pdf_event', None)
        event: Optional[str] = raw_event if record.name == _LOGGER and isinstance(raw_event, str) and raw_event in _EVENTS else None
        text = _EVENTS[event][1] if event is not None else 'External diagnostic'
        level = 'ERROR' if record.levelno >= logging.ERROR else 'WARN' if record.levelno >= logging.WARNING else 'INFO' if record.levelno >= logging.INFO else 'DEBUG'
        if event is not None and event.startswith('request.'):
            action = getattr(record, 'pdf_action', None)
            text += ' action=' + (action if isinstance(action, str) and action in _ACTIONS else 'unsupported')
        kind = getattr(record, 'pdf_error', None) if event is not None else None
        if isinstance(kind, str) and kind in _ERRORS | set(_ERRNOS.values()):
            text += ' error=' + kind
        return f'[{datetime.now(timezone.utc).isoformat()}] [{level}] {text}'


class _SafeHandler:
    def handleError(self, record: logging.LogRecord) -> None:
        # logging.Handler.handleError normally echoes raw msg/args to stderr.
        try:
            sys.stderr.write('Diagnostic log write failed\n')
        except Exception:
            pass


class DiagnosticStreamHandler(_SafeHandler, logging.StreamHandler):
    pass


class DiagnosticFileHandler(_SafeHandler, logging.FileHandler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            super().emit(record)
        except Exception:
            self.handleError(record)


def configure_diagnostics(enabled: bool, file_path: str) -> None:
    active = enabled and bool(file_path)
    handler: logging.Handler = (DiagnosticFileHandler(file_path, mode='a', encoding='utf-8', delay=True)
                                if active else DiagnosticStreamHandler(sys.stderr))
    handler.setFormatter(DiagnosticFormatter())
    logging.basicConfig(level=logging.DEBUG if active else logging.WARNING, handlers=[handler], force=True)
