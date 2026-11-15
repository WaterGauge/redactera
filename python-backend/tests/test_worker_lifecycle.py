import json
import os
import tempfile
from pathlib import Path

import pytest

import main
from main import _record_worker_state


@pytest.fixture(autouse=True)
def no_native_job_in_unit_test_host(monkeypatch):
    # Actual Job containment is exercised in isolated native child processes.
    monkeypatch.setattr(main, "worker_identity", lambda session, generation: {})


def configure(monkeypatch, root: Path):
    monkeypatch.setenv('PDF_DESENSITIZATION_TEMP_ROOT', str(root))
    monkeypatch.setenv('PDF_DESENSITIZATION_SESSION', 'test-session')
    monkeypatch.setenv('PDF_DESENSITIZATION_GENERATION', 'test-generation')
    monkeypatch.setattr(tempfile, 'tempdir', tempfile.tempdir)


def test_unmanaged_cli_keeps_its_existing_temp_behavior(monkeypatch):
    monkeypatch.delenv('PDF_DESENSITIZATION_TEMP_ROOT', raising=False)
    before = tempfile.tempdir
    assert _record_worker_state('running') is False
    assert tempfile.tempdir == before


def test_worker_identity_is_persisted_before_work_and_stopped_state_is_atomic(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    assert _record_worker_state('running') is True
    marker = json.loads((tmp_path / 'worker.json').read_text())
    assert marker == {'session': 'test-session', 'generation': 'test-generation',
                      'pid': os.getpid(), 'parentPid': os.getppid(), 'state': 'running',
                      'groupPid': os.getpgrp() if hasattr(os, 'getpgrp') else None}
    assert _record_worker_state('stopped') is True
    assert json.loads((tmp_path / 'worker.json').read_text())['state'] == 'stopped'
    assert not list(tmp_path.glob('.worker-*'))


def test_invalid_managed_directory_fails_instead_of_falling_back(monkeypatch, tmp_path):
    missing = tmp_path / 'missing'
    configure(monkeypatch, missing)
    with pytest.raises(RuntimeError, match='unavailable'):
        _record_worker_state('running')
    assert not missing.exists()


def test_pin_survives_removed_directory_without_using_global_temp(monkeypatch, tmp_path):
    root = tmp_path / 'owned'
    root.mkdir()
    configure(monkeypatch, root)
    _record_worker_state('running')
    assert tempfile.gettempdir() == str(root)
    (root / 'worker.json').unlink()
    root.rmdir()
    with pytest.raises(FileNotFoundError):
        tempfile.mkstemp()


def test_worker_records_native_tree_proof_before_becoming_ready(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    proof = {"windowsJob": "synthetic-job", "processStarted": "123", "parentStarted": "122"}
    monkeypatch.setattr(main, "worker_identity", lambda session, generation: proof)
    _record_worker_state("running")
    marker = json.loads((tmp_path / "worker.json").read_text())
    assert all(marker[key] == value for key, value in proof.items())


def test_tree_guard_failure_cannot_publish_a_running_worker(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    def fail(session, generation):
        raise RuntimeError("tree guard unavailable")
    monkeypatch.setattr(main, "worker_identity", fail)
    with pytest.raises(RuntimeError, match="tree guard"):
        _record_worker_state("running")
    assert not (tmp_path / "worker.json").exists()
