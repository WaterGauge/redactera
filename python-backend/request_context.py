"""Per-request progress and a monotonic budget derived from Main's deadline."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import math
import time
from typing import Any, Callable, Iterator, Optional

ProgressSink = Callable[[dict[str, Any]], None]


@dataclass
class _Request:
    started: float
    deadline: Optional[float]
    progress: Optional[ProgressSink]


_current: ContextVar[Optional[_Request]] = ContextVar('pdf_request', default=None)


@contextmanager
def request_scope(deadline_ms: object = None, progress: Optional[ProgressSink] = None) -> Iterator[None]:
    started = time.monotonic()
    deadline: Optional[float] = None
    if deadline_ms is not None:
        if isinstance(deadline_ms, bool) or not isinstance(deadline_ms, (int, float)) or not math.isfinite(deadline_ms):
            raise ValueError('Invalid request deadline')
        remaining = float(deadline_ms) / 1000 - time.time()
        if remaining <= 0:
            raise TimeoutError('Request deadline exceeded')
        deadline = started + min(remaining, 15 * 60)
    token = _current.set(_Request(started, deadline, progress))
    try:
        check_deadline()
        yield
    finally:
        _current.reset(token)


def check_deadline() -> None:
    request = _current.get()
    if request and request.deadline is not None and time.monotonic() >= request.deadline:
        raise TimeoutError('Request deadline exceeded')


def request_timeout(default: float) -> float:
    request = _current.get()
    if request and request.deadline is not None:
        remaining = request.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Request deadline exceeded')
        return min(default, remaining)
    return default


def has_deadline() -> bool:
    request = _current.get()
    return request is not None and request.deadline is not None


def wait_for(seconds: float) -> None:
    time.sleep(request_timeout(seconds))
    check_deadline()


def report_progress(stage: str, message: str, completed: Optional[int] = None, total: Optional[int] = None) -> None:
    check_deadline()
    request = _current.get()
    if not request or not request.progress:
        return
    event: dict[str, Any] = {'stage': stage, 'message': message,
                             'elapsedMs': max(0, int((time.monotonic() - request.started) * 1000))}
    if completed is not None and total is not None and total > 0:
        event.update(completed=completed, total=total)
    request.progress(event)
