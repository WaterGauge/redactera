"""Native process-tree lifetime tests; only isolated child jobs are modified."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import pytest

from windows_lifecycle import job_name, job_state, process_identity


def test_job_names_are_scoped_and_do_not_embed_session_values():
    one = job_name("synthetic-session", "generation-a")
    assert one.startswith("Global" + chr(92) + "PDFDesensitization-")
    assert one != job_name("synthetic-session", "generation-b")
    assert "synthetic-session" not in one


@pytest.mark.skipif(sys.platform != "win32", reason="Requires native Windows kernel Job Objects")
@pytest.mark.parametrize("retain_query_handle", [False, True])
def test_worker_exit_and_last_handle_close_control_its_actual_descendant(tmp_path, retain_query_handle):
    from windows_lifecycle import _kernel

    report = tmp_path / "launched.json"
    session, generation = str(uuid.uuid4()), str(uuid.uuid4())
    program = """
import json,subprocess,sys,time
from pathlib import Path
from windows_lifecycle import worker_identity
proof=worker_identity(sys.argv[2],sys.argv[3])
child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],
                       stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(sys.argv[1]).write_text(json.dumps({"child":child.pid,"proof":proof}))
sys.stdin.read()
"""
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    handle = None
    kernel = _kernel()
    with (tmp_path / "worker-error.log").open("wb") as err:
        # The venv redirector has its own kill-on-close wrapper. Use the base
        # interpreter so this test isolates our Job instead of that parent job.
        executable = getattr(sys, "_base_executable", sys.executable)
        worker = subprocess.Popen([executable, "-c", program, str(report), session, generation],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err, env=env)
        try:
            deadline = time.monotonic() + 10
            while not report.exists():
                assert worker.poll() is None, "Isolated worker could not establish Job containment"
                assert time.monotonic() < deadline, "Isolated worker launch timed out"
                time.sleep(.02)
            data = json.loads(report.read_text())
            name = data["proof"]["windowsJob"]
            assert name == job_name(session, generation)
            child = data["child"]
            assert process_identity(child)["state"] == "present", "Missing live child control"
            assert job_state(name) == "active"
            if retain_query_handle:
                handle = kernel.OpenJobObjectW(4, False, name)
                assert handle
            worker.kill()  # This exact Popen child, never a historical PID/tree guess.
            worker.wait(timeout=10)
            if retain_query_handle:
                assert process_identity(child)["state"] == "present", "Missing orphan survival control"
                assert job_state(name) == "active"
                kernel.CloseHandle(handle)
                handle = None
            deadline = time.monotonic() + 10
            while process_identity(child)["state"] != "absent" or job_state(name) != "empty":
                assert time.monotonic() < deadline, "Managed child/job survived its final handle"
                time.sleep(.02)
        finally:
            if handle:
                kernel.CloseHandle(handle)
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=10)
            if worker.stdin:
                worker.stdin.close()
