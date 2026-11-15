import json
from unittest.mock import Mock

import main


def test_sanitize_error_message_scrubs_path_fragments():
    message = "failed to open /Users/example/Desktop/Test Documents/secret/report.pdf from Test Documents/secret/report.pdf"
    payload = {
        "file_path": "/Users/example/Desktop/Test Documents/secret/report.pdf",
        "save_path": "/tmp/output/report.pdf",
    }

    sanitized = main.sanitize_error_message(message, payload)

    assert "/Users/example/Desktop/Test Documents/secret/report.pdf" not in sanitized
    assert "Test Documents/secret/report.pdf" not in sanitized
    assert "report.pdf" not in sanitized
    assert "<path>" in sanitized or "<file>" in sanitized


def test_send_progress_emits_json(capsys):
    main.send_progress("processing")

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload == {"type": "progress", "message": "processing"}


def test_handle_message_sanitizes_processor_errors(monkeypatch, capsys):
    fake_processor = Mock()
    fake_processor.extract_text.side_effect = RuntimeError(
        "boom opening /Users/example/Desktop/private/report.pdf via private/report.pdf"
    )
    monkeypatch.setattr(main, "processor", fake_processor)
    monkeypatch.setattr(main, "DEBUG_MODE", False)

    main.handle_message(
        {
            "action": "upload",
            "payload": {"file_path": "/Users/example/Desktop/private/report.pdf"},
            "requestId": "req-1",
        }
    )

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is False
    assert "/Users/example/Desktop/private/report.pdf" not in response["error"]
    assert "private/report.pdf" not in response["error"]
    assert "report.pdf" not in response["error"]


def test_handle_message_rejects_missing_required_fields(capsys):
    main.handle_message({"payload": {}, "requestId": "req-2"})

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is False
    assert response["error"] == "Missing required fields: action or requestId"
    assert response["requestId"] == "req-2"


def test_handle_message_returns_success_for_export(monkeypatch, capsys):
    fake_processor = Mock()
    fake_processor.export.return_value = {"output_path": "/tmp/output.pdf"}
    monkeypatch.setattr(main, "processor", fake_processor)

    main.handle_message(
        {
            "action": "export",
            "payload": {
                "file_path": "/tmp/input.pdf",
                "format": "pdf",
                "save_path": "/tmp/output.pdf",
            },
            "requestId": "req-3",
        }
    )

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is True
    assert response["data"] == {"output_path": "/tmp/output.pdf"}
    fake_processor.export.assert_called_once_with("/tmp/input.pdf", "pdf", "/tmp/output.pdf", dpi=150)


def test_handle_message_returns_success_for_desensitize(monkeypatch, capsys):
    fake_processor = Mock()
    fake_processor.desensitize.return_value = {"output_path": "/tmp/desensitized.pdf"}
    monkeypatch.setattr(main, "processor", fake_processor)

    main.handle_message(
        {
            "action": "desensitize",
            "payload": {
                "file_path": "/tmp/input.pdf",
                "keywords": ["SECRET"],
                "settings": {"redaction_scope": "normal"},
            },
            "requestId": "req-5",
        }
    )

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is True
    assert response["data"] == {"output_path": "/tmp/desensitized.pdf"}
    kwargs = fake_processor.desensitize.call_args.kwargs
    assert kwargs["settings"] == {"redaction_scope": "normal"}
    assert callable(kwargs["progress_callback"])


def test_handle_message_returns_unknown_action_payload(capsys):
    main.handle_message(
        {
            "action": "noop",
            "payload": {},
            "requestId": "req-4",
        }
    )

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is True
    assert response["data"] == {"error": "Unknown action"}


def test_handle_message_requires_file_path_for_upload(capsys):
    main.handle_message(
        {
            "action": "upload",
            "payload": {},
            "requestId": "req-6",
        }
    )

    response = json.loads(capsys.readouterr().out.strip())
    assert response["success"] is False
    assert response["error"] == "Missing required field: file_path"
