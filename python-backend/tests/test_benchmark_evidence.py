"""Synthetic controls for the resource-observation contract."""
import importlib.util
from pathlib import Path
import subprocess
from unittest.mock import Mock

import pytest

spec = importlib.util.spec_from_file_location('protocol_observer', Path(__file__).resolve().parents[2] / 'e2e/support/frozen_protocol.py')
assert spec and spec.loader
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)


@pytest.mark.parametrize('status, output', [(1, '12'), (0, ''), (0, '12 invalid'), (0, '0')])
def test_live_bad_rss_sample_is_not_success(status, output):
    with pytest.raises(ValueError):
        protocol.sampled_rss(subprocess.CompletedProcess([], status, output), False)


def test_normal_exit_and_valid_rss():
    assert protocol.sampled_rss(subprocess.CompletedProcess([], 1, ''), True) is None
    assert protocol.sampled_rss(subprocess.CompletedProcess([], 0, '12\n 20\n'), False) == 32768


def test_source_ocr_identity_uses_worker_path_and_environment(tmp_path, monkeypatch):
    monkeypatch.setenv('PATH', '/synthetic/parent')
    monkeypatch.setenv('TESSDATA_PREFIX', '/synthetic/parent-models')
    environment = protocol.worker_environment(tmp_path, 'synthetic')
    executable = tmp_path / 'tesseract'
    executable.write_bytes(b'synthetic tool')
    which = Mock(return_value=str(executable))
    run = Mock(side_effect=[subprocess.CompletedProcess([], 0, 'tesseract synthetic\n'),
                            subprocess.CompletedProcess([], 0, 'List of available languages:\neng\n')])
    monkeypatch.setattr(protocol.shutil, 'which', which)
    monkeypatch.setattr(protocol.subprocess, 'run', run)
    assert protocol.source_ocr_identity(environment)['version'] == 'tesseract synthetic'
    which.assert_called_once_with('tesseract', path='/usr/bin:/bin')
    for call in run.call_args_list:
        assert call.args[0][0] == str(executable)
        assert call.kwargs['env'] is environment
        assert 'TESSDATA_PREFIX' not in call.kwargs['env']


def test_summary_distinguishes_no_data_partial_and_valid_samples():
    worker = protocol.FrozenWorker.__new__(protocol.FrozenWorker)
    worker.ready_ms = worker.exit_ms = worker.peak_rss = worker.peak_temp_bytes = worker.peak_png_count = worker.stderr_bytes = 0
    worker.closed = True
    worker.mode = 'source'
    worker.source_ocr = None
    worker.sample_thread = Mock()
    worker.sample_thread.is_alive.return_value = False
    worker.successful_samples = worker.sample_errors = 0
    result = worker.summary()
    assert result['peakOwnedTreeRssMiB'] is None and not result['resourceObservationValid']
    worker.successful_samples = 1
    worker.peak_rss = 2 * 1024**2
    assert worker.summary()['resourceObservationValid']
    worker.sample_errors = 1
    assert worker.summary()['peakOwnedTreeRssMiB'] == 2 and not worker.summary()['resourceObservationValid']
    worker.sample_errors = 0
    worker.sample_thread.is_alive.return_value = True
    assert not worker.summary()['resourceObservationValid']
