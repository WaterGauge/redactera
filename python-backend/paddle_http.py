"""Direct, public-only Paddle HTTP connections with DNS-to-socket binding."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any, Mapping, Optional
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError

from request_context import check_deadline, request_timeout


def _disallowed(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.scope_id or ip.sixtofour or ip.teredo:
            return True
        if ip.ipv4_mapped and _disallowed(str(ip.ipv4_mapped)):
            return True
    return (not ip.is_global or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_private)


def normalize_paddle_url(url: str, *, base: bool = False) -> str:
    """Validate the exact URL Requests will use, without changing signed queries."""
    if not isinstance(url, str) or not url or "\\" in url or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise ValueError("Paddle URL contains invalid characters")
    raw = urlsplit(url)
    if raw.scheme != "https":
        raise ValueError("Paddle URL must use the https scheme")
    if not raw.hostname or raw.username is not None or raw.password is not None or "%" in raw.netloc:
        raise ValueError("Paddle URL must have an unambiguous hostname without credentials")
    if raw.port == 0:
        raise ValueError("Paddle URL has an invalid port")
    if "#" in url or (base and "?" in url):
        raise ValueError("Paddle URL cannot contain a fragment or a base query")
    # Requests performs IDNA and percent normalization. Validate that representation
    # too; never validate one parser's hostname then send another representation.
    prepared_url = requests.Request("GET", url).prepare().url
    if not isinstance(prepared_url, str):
        raise ValueError("Paddle URL is invalid")
    parsed = urlsplit(prepared_url)
    host = parsed.hostname or ""
    port = parsed.port  # Explicitly reject malformed/out-of-range ports.
    if port == 0 or not host or "%" in host:
        raise ValueError("Paddle URL has an invalid host or port")
    lowered = host.lower().rstrip(".")
    if lowered in {"localhost", "localhost.localdomain"} or lowered.endswith((".local", ".localhost")):
        raise ValueError("Paddle URL cannot target local addresses")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass  # Numeric aliases and DNS names are checked at the connection boundary.
    else:
        if _disallowed(host):
            raise ValueError("Paddle URL cannot target private or other non-public addresses")
    return prepared_url


def _public_addresses(host: str, port: int) -> list[Any]:
    check_deadline()
    try:
        addresses: list[Any] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("Paddle hostname could not be resolved") from exc
    check_deadline()
    if not addresses:
        raise ValueError("Paddle hostname returned no addresses")
    # Reject the entire answer before opening any socket, including mixed answers.
    for family, kind, _, _, target in addresses:
        if family not in (socket.AF_INET, socket.AF_INET6) or kind != socket.SOCK_STREAM or _disallowed(target[0]):
            raise ValueError("Paddle hostname resolves to a non-public address")
        if target[1] != port or (family == socket.AF_INET6 and target[3] != 0):
            raise ValueError("Paddle hostname returned an invalid connection target")
    return addresses


def validate_paddle_api_url(url: str) -> str:
    candidate = normalize_paddle_url(url.strip(), base=True)
    parsed = urlsplit(candidate)
    _public_addresses(str(parsed.hostname), parsed.port or (443 if parsed.scheme == "https" else 80))
    # Keep the existing settings representation (no added slash on a bare origin).
    return candidate.rstrip("/") if not urlsplit(url.strip()).path else candidate


class _PublicHTTPConnection(HTTPConnection):
    def _new_conn(self) -> socket.socket:
        # Each new physical connection resolves exactly once. connect() receives
        # the validated numeric sockaddr, never the hostname for a second lookup.
        addresses = _public_addresses(self._dns_host, self.port)
        if not isinstance(self.timeout, (int, float)):
            raise ValueError("Paddle connection requires a finite timeout")
        last_error: Optional[OSError] = None
        for family, kind, protocol, _, target in addresses:
            check_deadline()
            sock: Optional[socket.socket] = None
            try:
                sock = socket.socket(family, kind, protocol)
                sock.settimeout(request_timeout(float(self.timeout)))
                for option in self.socket_options or []:
                    sock.setsockopt(*option)
                sock.connect(target)
                peer = sock.getpeername()
                if ipaddress.ip_address(peer[0]) != ipaddress.ip_address(target[0]) or peer[1] != target[1]:
                    raise ValueError("Paddle connection peer does not match its validated address")
                check_deadline()
                return sock
            except OSError as exc:
                if sock is not None:
                    sock.close()
                last_error = exc
            except BaseException:
                if sock is not None:
                    sock.close()
                raise
        if isinstance(last_error, socket.timeout):
            raise ConnectTimeoutError(self, "Paddle connection timed out") from last_error
        raise NewConnectionError(self, "Paddle connection failed") from last_error


class _PublicHTTPSConnection(HTTPSConnection, _PublicHTTPConnection):
    """Keep urllib3's original hostname, SNI, CA and certificate verification."""


class _PublicHTTPPool(HTTPConnectionPool):
    ConnectionCls = _PublicHTTPConnection


class _PublicHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = _PublicHTTPSConnection


class _PublicAdapter(HTTPAdapter):
    def init_poolmanager(self, connections: int, maxsize: int, block: bool = False, **pool_kwargs: Any) -> None:
        super().init_poolmanager(connections, maxsize, block=block, **pool_kwargs)
        # PoolManager's default dictionary is shared; replace it on this instance.
        self.poolmanager.pool_classes_by_scheme = {"http": _PublicHTTPPool, "https": _PublicHTTPSPool}


def paddle_request(method: str, url: str, *, timeout: float,
                   headers: Optional[Mapping[str, str]] = None, data: Any = None,
                   files: Any = None) -> requests.Response:
    canonical = normalize_paddle_url(url)
    # A fresh session per call also prevents API cookies or auth reaching the
    # service-delegated result origin. No implicit proxy/netrc/CA environment.
    with requests.Session() as session:
        session.trust_env = False
        adapter = _PublicAdapter(max_retries=0)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        try:
            result = session.request(method, canonical, headers=headers, data=data, files=files,
                                     timeout=request_timeout(timeout), allow_redirects=False)
        except requests.RequestException:
            # urllib3 can translate our TimeoutError into a socket timeout.
            # The request's shared deadline must still take precedence.
            check_deadline()
            raise
        check_deadline()
        if 300 <= result.status_code < 400:
            result.close()
            raise requests.HTTPError("Paddle redirects are not allowed")
        return result
