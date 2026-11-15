"""Cloud OCR must not send documents or credentials over plaintext HTTP."""

import json
import socket
from unittest.mock import Mock

import pytest
import requests

from paddle_http import paddle_request, validate_paddle_api_url
from pdf_processor import PDFProcessor, normalize_settings


def reply(body, status=200, location=None):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(body).encode()
    result._content_consumed = True
    if location:
        result.headers["Location"] = location
    return result


@pytest.mark.parametrize("url", ["http://8.8.8.8", "HTTP://8.8.8.8/base", "hTtP://ocr.example.test:8080/base",
                                 "http://8.8.8.8:443", " hTtP://8.8.8.8:443/base/ "])
@pytest.mark.parametrize("entry", ["url", "settings"])
def test_http_configuration_rejected_without_dns(monkeypatch, url, entry):
    dns = Mock(side_effect=lambda host, port, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))])
    monkeypatch.setattr("paddle_http.socket.getaddrinfo", dns)
    with pytest.raises(ValueError, match="https"):
        if entry == "url":
            validate_paddle_api_url(url)
        else:
            normalize_settings({"ocr_mode": "paddle", "paddle_api_url": url, "paddle_token": "synthetic"})
    dns.assert_not_called()


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("url", ["http://8.8.8.8/x", "HTTP://ocr.example.test/x"])
def test_direct_http_request_cannot_dispatch_credentials(monkeypatch, method, url):
    send = Mock(side_effect=AssertionError("Plain HTTP dispatch must never occur"))
    monkeypatch.setattr(requests.sessions.Session, "send", send)
    with pytest.raises(ValueError, match="https"):
        paddle_request(method, url, timeout=5, headers={"Authorization": "bearer synthetic"},
                       data={"document": "synthetic"})
    send.assert_not_called()


def test_direct_paddle_fetch_rejects_http_before_open_or_dispatch(tmp_path, monkeypatch):
    source = tmp_path / "synthetic.pdf"
    source.write_bytes(b"synthetic PDF")
    opened = Mock(side_effect=AssertionError("HTTP configuration must fail before opening PDF"))
    send = Mock(side_effect=AssertionError("Plain HTTP dispatch must never occur"))
    monkeypatch.setattr("builtins.open", opened)
    monkeypatch.setattr(requests.sessions.Session, "send", send)
    with pytest.raises(RuntimeError, match="https"):
        PDFProcessor()._fetch_paddle_all_pages(str(source), "http://8.8.8.8", "synthetic")
    opened.assert_not_called()
    send.assert_not_called()


@pytest.mark.parametrize("stage", ["token", "page"])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_baidu_never_follows_a_redirect_to_http(monkeypatch, stage, status):
    sent = []
    def send(adapter, prepared, **kwargs):
        sent.append(prepared)
        result = (reply({}, status, "http://8.8.8.8/plaintext") if len(sent) == 1
                  else reply({"access_token": "synthetic", "words_result": []}))
        result.request, result.url = prepared, prepared.url
        return result
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setattr("pdf_processor.time.sleep", lambda _: None)
    processor = PDFProcessor()
    page = Mock()
    page.get_pixmap.return_value.tobytes.return_value = b"synthetic image"
    with pytest.raises(RuntimeError, match="redirect"):
        if stage == "token":
            processor._get_baidu_token("synthetic", "synthetic")
        else:
            monkeypatch.setattr(processor, "_get_baidu_token", lambda *args: "synthetic")
            processor._get_page_ocr_data_baidu(page, "synthetic", "synthetic")
    assert len(sent) == 1 and sent[0].url.startswith("https://")


@pytest.mark.parametrize("mode", ["local", "baidu"])
def test_inactive_paddle_http_draft_does_not_reset_other_settings(mode):
    settings = normalize_settings({"ocr_mode": mode, "paddle_api_url": "http://old.example.test",
                                   "baidu_api_key": "synthetic", "baidu_secret_key": "synthetic"})
    assert settings.ocr_mode == mode


@pytest.mark.parametrize("stage", ["token", "page"])
def test_baidu_https_success_keeps_original_body_and_auth_flow(monkeypatch, stage):
    sent = []
    def send(adapter, prepared, **kwargs):
        sent.append(prepared)
        result = reply({"access_token": "synthetic", "words_result": []})
        result.request, result.url = prepared, prepared.url
        return result
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setattr("pdf_processor.time.sleep", lambda _: None)
    processor = PDFProcessor()
    if stage == "token":
        assert processor._get_baidu_token("synthetic", "synthetic") == "synthetic"
        assert "client_secret=synthetic" in str(sent[0].body)
    else:
        monkeypatch.setattr(processor, "_get_baidu_token", lambda *args: "synthetic")
        page = Mock(); page.get_pixmap.return_value.tobytes.return_value = b"synthetic image"
        assert processor._get_page_ocr_data_baidu(page, "synthetic", "synthetic")["tokens"] == []
        assert "access_token=synthetic" in sent[0].url
    assert len(sent) == 1 and sent[0].url.startswith("https://")
