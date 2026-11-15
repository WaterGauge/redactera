"""Paddle destinations are tested with synthetic HTTP; never contact the network."""

import json
import io
import socket
from unittest.mock import Mock

import pytest
import requests

from pdf_processor import PDFProcessor
from paddle_http import (paddle_request, normalize_paddle_url, validate_paddle_api_url,
                         _PublicHTTPConnection, _PublicHTTPSConnection)


def response(body, status=200, headers=None):
    result = requests.Response()
    result.status_code = status
    result.headers.update(headers or {})
    result._content = (body if isinstance(body, str) else json.dumps(body)).encode()
    result._content_consumed = True
    return result


def paddle_exchange(tmp_path, monkeypatch, result_url, redirect_stage=None, location=None):
    source = tmp_path / "synthetic.pdf"
    source.write_bytes(b"synthetic upload; no real PDF or credential")
    replies = [response({"data": {"jobId": "synthetic-job"}}),
               response({"data": {"state": "done", "resultUrl": {"jsonUrl": result_url}}}),
               response('{"result":{"layoutParsingResults":[]}}')]
    if redirect_stage is not None:
        replies[redirect_stage] = response("", 302, {"Location": location})
    sent = []

    def send(session, prepared, **kwargs):
        sent.append((prepared, kwargs, session.trust_env))
        result = replies[len(sent) - 1]
        result.request = prepared
        result.url = prepared.url
        return result

    monkeypatch.setattr(requests.sessions.Session, "send", send)
    monkeypatch.setattr("pdf_processor.time.sleep", lambda _: None)
    return lambda: PDFProcessor()._fetch_paddle_all_pages(
        str(source), "https://8.8.8.8", "synthetic-token"), sent


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/private", "https://10.0.0.1/private",
    "http://169.254.169.254/latest/meta-data/", "https://[::1]/private",
])
def test_service_result_cannot_request_a_private_destination(tmp_path, monkeypatch, url):
    run, sent = paddle_exchange(tmp_path, monkeypatch, url)
    with pytest.raises(RuntimeError, match="PaddleOCR"):
        run()
    assert len(sent) == 2


@pytest.mark.parametrize("stage", [0, 1, 2])
@pytest.mark.parametrize("location", [
    "http://127.0.0.1/private", "https://other.example.test/first-of-many",
    "http://8.8.8.8/downgrade", "/relative-redirect",
])
def test_every_paddle_stage_refuses_redirects(tmp_path, monkeypatch, stage, location):
    run, sent = paddle_exchange(tmp_path, monkeypatch, "https://files.example.test/result?signature=synthetic",
                                stage, location)
    with pytest.raises(RuntimeError, match="redirect"):
        run()
    assert len(sent) == stage + 1
    assert all(kwargs.get("allow_redirects") is False for _, kwargs, _ in sent)


def test_cross_origin_signed_public_result_keeps_no_credentials(tmp_path, monkeypatch):
    run, sent = paddle_exchange(tmp_path, monkeypatch, "https://files.example.test/result?signature=a%2Fb%2Bz")
    assert run() == []
    assert len(sent) == 3
    assert sent[0][0].headers["Authorization"] == "bearer synthetic-token"
    assert sent[1][0].headers["Authorization"] == "bearer synthetic-token"
    assert "Authorization" not in sent[2][0].headers
    assert sent[2][0].url.endswith("?signature=a%2Fb%2Bz")
    assert all(trust_env is False for _, _, trust_env in sent)


def answer(address, port=443):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
            (address, port, 0, 0) if family == socket.AF_INET6 else (address, port))


@pytest.mark.parametrize("address", [
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "192.0.2.1", "::1", "fe80::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::",
])
@pytest.mark.parametrize("connection", [_PublicHTTPConnection, _PublicHTTPSConnection])
def test_entire_dns_answer_is_rejected_before_opening_a_socket(monkeypatch, address, connection):
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[answer("8.8.8.8"), answer(address)]))
    create = Mock(side_effect=AssertionError("No socket may be opened"))
    monkeypatch.setattr("paddle_http.socket.socket", create)
    with pytest.raises(ValueError, match="non-public"):
        connection("ocr.example.test", 443, timeout=10)._new_conn()
    create.assert_not_called()


@pytest.mark.parametrize("url", [
    "https://user:pass@8.8.8.8/x", "https://%31%32%37.0.0.1/x",
    "https://8.8.8.8\\@127.0.0.1/x", "https://8.8.8.8\r\n/x",
    "https://[fe80::1%25en0]/x", "file:///etc/passwd", "//8.8.8.8/x",
    "https://8.8.8.8:0/x", "https://8.8.8.8:65536/x", "https://8.8.8.8/#",
])
def test_ambiguous_url_rejected_before_http(monkeypatch, url):
    send = Mock(side_effect=AssertionError("No HTTP dispatch"))
    monkeypatch.setattr(requests.sessions.Session, "send", send)
    with pytest.raises(ValueError):
        paddle_request("GET", url, timeout=5)
    send.assert_not_called()


@pytest.mark.parametrize("suffix", ["?q=synthetic", "#fragment", "?"])
def test_api_base_rejects_query_and_fragment(suffix):
    with pytest.raises(ValueError):
        normalize_paddle_url("https://8.8.8.8/base" + suffix, base=True)


class WireSocket:
    def __init__(self, reply=b"", peer=None):
        self.reply, self.peer = reply, peer
        self.target, self.sent, self.closed = None, [], False
        self.timeout = None

    def connect(self, target):
        self.target = target

    def getpeername(self):
        return self.peer or self.target

    def settimeout(self, timeout):
        self.timeout = timeout

    def setsockopt(self, *args):
        pass

    def sendall(self, body):
        self.sent.append(body)

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.reply)

    def close(self):
        self.closed = True


def wire_reply(body=b"{}", status=b"200 OK", headers=b""):
    return b"HTTP/1.1 " + status + b"\r\nContent-Length: " + str(len(body)).encode() + b"\r\n" + headers + b"Connection: close\r\n\r\n" + body


def test_real_adapter_binds_single_dns_answer_and_keeps_https_identity(monkeypatch):
    dns = Mock(side_effect=[[answer("8.8.8.8")], [answer("127.0.0.1")]])
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", dns)
    wire = WireSocket(wire_reply())
    monkeypatch.setattr("paddle_http.socket.socket", Mock(return_value=wire))
    tls = Mock(return_value=(wire, True))
    monkeypatch.setattr("urllib3.connection._ssl_wrap_socket_and_match_hostname", tls)
    result = paddle_request("GET", "https://ocr.example.test/result?sig=a%2Fb", timeout=9)
    assert result.json() == {}
    dns.assert_called_once_with("ocr.example.test", 443, type=socket.SOCK_STREAM)
    assert wire.target == ("8.8.8.8", 443)
    assert b"Host: ocr.example.test\r\n" in b"".join(wire.sent)
    assert b"GET /result?sig=a%2Fb HTTP/1.1" in b"".join(wire.sent)
    assert tls.call_args.kwargs["server_hostname"] == "ocr.example.test"
    assert tls.call_args.kwargs["cert_reqs"] == "CERT_REQUIRED"
    assert wire.closed


def test_settings_precheck_is_not_reused_for_connection(monkeypatch):
    dns = Mock(side_effect=[[answer("8.8.8.8")], [answer("127.0.0.1")]])
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", dns)
    assert validate_paddle_api_url("https://ocr.example.test") == "https://ocr.example.test"
    create = Mock(side_effect=AssertionError("No socket may be opened"))
    monkeypatch.setattr("paddle_http.socket.socket", create)
    with pytest.raises(ValueError, match="non-public"):
        paddle_request("GET", "https://ocr.example.test/result", timeout=5)
    assert dns.call_count == 2
    create.assert_not_called()


def test_fully_qualified_dns_name_keeps_its_absolute_lookup(monkeypatch):
    dns = Mock(return_value=[answer("8.8.8.8")])
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", dns)
    wire = WireSocket()
    monkeypatch.setattr("paddle_http.socket.socket", Mock(return_value=wire))
    assert _PublicHTTPSConnection("api.example.test.", 443, timeout=5)._new_conn() is wire
    dns.assert_called_once_with("api.example.test.", 443, type=socket.SOCK_STREAM)
    assert wire.target == ("8.8.8.8", 443)


@pytest.mark.parametrize("alias", ["2130706433", "0177.0.0.1", "0x7f000001"])
def test_numeric_aliases_checked_after_resolution(monkeypatch, alias):
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[answer("127.0.0.1", 443)]))
    create = Mock(side_effect=AssertionError("No socket may be opened"))
    monkeypatch.setattr("paddle_http.socket.socket", create)
    with pytest.raises(ValueError, match="non-public"):
        paddle_request("GET", f"https://{alias}/x", timeout=5)
    create.assert_not_called()


def test_empty_dns_and_mismatched_peer_fail_closed(monkeypatch):
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[]))
    with pytest.raises(ValueError, match="no addresses"):
        _PublicHTTPConnection("ocr.example.test", 443, timeout=5)._new_conn()
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[answer("8.8.8.8")]))
    wire = WireSocket(peer=("127.0.0.1", 443))
    monkeypatch.setattr("paddle_http.socket.socket", Mock(return_value=wire))
    with pytest.raises(ValueError, match="peer"):
        _PublicHTTPConnection("ocr.example.test", 443, timeout=5)._new_conn()
    assert wire.closed and not wire.sent


@pytest.mark.parametrize("status", [b"301 Moved", b"302 Found", b"303 Other", b"307 Temporary", b"308 Permanent"])
def test_actual_requests_redirect_does_not_open_another_connection(monkeypatch, status):
    dns = Mock(return_value=[answer("8.8.8.8", 443)])
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", dns)
    wire = WireSocket(wire_reply(status=status, headers=b"Location: http://127.0.0.1/private\r\n"))
    create = Mock(return_value=wire)
    monkeypatch.setattr("paddle_http.socket.socket", create)
    monkeypatch.setattr("urllib3.connection._ssl_wrap_socket_and_match_hostname",
                        lambda **kwargs: (kwargs["sock"], True))
    with pytest.raises(requests.HTTPError, match="redirect"):
        paddle_request("GET", "https://ocr.example.test/result", timeout=5)
    assert create.call_count == 1 and dns.call_count == 1


def test_proxy_and_netrc_are_not_implicit_authority(monkeypatch, tmp_path):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:8000")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:8000")
    netrc = tmp_path / "synthetic.netrc"
    netrc.write_text("machine files.example.test login synthetic password synthetic\n")
    monkeypatch.setenv("NETRC", str(netrc))
    seen = []
    def send(session, prepared, **kwargs):
        seen.append((prepared, kwargs, session.trust_env))
        return response({})
    monkeypatch.setattr(requests.sessions.Session, "send", send)
    paddle_request("GET", "https://files.example.test/result", timeout=5)
    assert "Authorization" not in seen[0][0].headers
    assert not seen[0][1].get("proxies") and seen[0][2] is False


@pytest.mark.parametrize("result_origin", ["ocr.example.test", "files.example.test"])
def test_complete_paddle_exchange_uses_guarded_sockets_without_reusing_cookies(tmp_path, monkeypatch, result_origin):
    source = tmp_path / "synthetic.pdf"
    source.write_bytes(b"synthetic PDF upload")
    bodies = [json.dumps({"data": {"jobId": "job/?query#fragment"}}),
              json.dumps({"data": {"state": "done", "resultUrl": {
                  "jsonUrl": f"https://{result_origin}/result?signature=a%2Fb"}}}),
              json.dumps({"result": {"layoutParsingResults": [{"prunedResult": {
                  "width": 100, "height": 200, "parsing_res_list": []}}]}})]
    wires = [WireSocket(wire_reply(body.encode(), headers=b"Set-Cookie: private=synthetic; Domain=example.test\r\n"))
             for body in bodies]
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[answer("8.8.8.8")]))
    create = Mock(side_effect=wires)
    monkeypatch.setattr("paddle_http.socket.socket", create)
    monkeypatch.setattr("urllib3.connection._ssl_wrap_socket_and_match_hostname",
                        lambda **kwargs: (kwargs["sock"], True))
    monkeypatch.setattr("pdf_processor.time.sleep", lambda _: None)
    pages = PDFProcessor()._fetch_paddle_all_pages(str(source), "https://ocr.example.test/prefix", "synthetic-token")
    assert pages == [{"tokens": [], "img_w": 100, "img_h": 200}]
    messages = [b"".join(wire.sent) for wire in wires]
    assert b"synthetic PDF upload" in messages[0]
    assert b"POST /prefix/api/v2/ocr/jobs HTTP/1.1" in messages[0]
    assert b"GET /prefix/api/v2/ocr/jobs/job%2F%3Fquery%23fragment HTTP/1.1" in messages[1]
    assert b"GET /result?signature=a%2Fb HTTP/1.1" in messages[2]
    assert all(b"Authorization: bearer synthetic-token" in message for message in messages[:2])
    assert b"Authorization:" not in messages[2] and all(b"Cookie:" not in message for message in messages)
    assert create.call_count == 3 and all(wire.closed for wire in wires)


def test_public_ipv6_fallback_and_socket_errors_preserve_request_failures(monkeypatch):
    from urllib3.exceptions import NewConnectionError
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", Mock(return_value=[answer("8.8.8.8"), answer("2606:4700:4700::1111")]))
    wire = WireSocket()
    create = Mock(side_effect=[OSError("synthetic socket failure"), wire])
    monkeypatch.setattr("paddle_http.socket.socket", create)
    assert _PublicHTTPSConnection("ocr.example.test", 443, timeout=7)._new_conn() is wire
    assert wire.target == ("2606:4700:4700::1111", 443, 0, 0) and wire.timeout == 7
    create.side_effect = OSError("synthetic socket failure")
    with pytest.raises(NewConnectionError):
        _PublicHTTPSConnection("ocr.example.test", 443, timeout=7)._new_conn()


def test_dns_delay_cannot_open_socket_after_deadline(monkeypatch):
    import request_context
    tick = [0.0]
    monkeypatch.setattr(request_context.time, "time", lambda: 1000)
    monkeypatch.setattr(request_context.time, "monotonic", lambda: tick[0])
    def resolve(*args, **kwargs):
        tick[0] = 3
        return [answer("8.8.8.8")]
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", resolve)
    create = Mock(side_effect=AssertionError("No socket after budget expires"))
    monkeypatch.setattr("paddle_http.socket.socket", create)
    with request_context.request_scope(1002000), pytest.raises(TimeoutError):
        paddle_request("GET", "https://ocr.example.test/result", timeout=10)
    create.assert_not_called()
