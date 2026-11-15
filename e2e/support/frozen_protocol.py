"""Owned native backend process, bounded protocol requests and memory observations."""
import json
import hashlib
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time


class FrozenWorker:
    def __init__(self, binary: Path, directory: Path):
        self.binary = binary.resolve()
        self.manifest = json.loads((self.binary.parent / "backend-manifest.json").read_text())
        if os.name != "posix" or self.manifest["platform"] != sys.platform:
            raise RuntimeError("This owned-process observer requires a native POSIX backend; use the Windows WDIO route for Windows")
        if hashlib.sha256(self.binary.read_bytes()).hexdigest() != self.manifest["executableSha256"]:
            raise RuntimeError("Frozen backend binary differs from its build manifest")
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=False)
        self.generation = "synthetic-check"
        self.messages = queue.Queue()
        self.peak_rss = 0
        self.stderr_bytes = 0
        self.closed = False
        self.sampling = threading.Event()
        environment = dict(os.environ, PDF_DESENSITIZATION_TEMP_ROOT=str(self.directory),
                           PDF_DESENSITIZATION_SESSION="synthetic", PDF_DESENSITIZATION_GENERATION=self.generation,
                           TMPDIR=str(self.directory), TEMP=str(self.directory), TMP=str(self.directory), LOG_ENABLED="0")
        environment.pop("TESSDATA_PREFIX", None)
        environment["PATH"] = environment.get("SystemRoot", r"C:\Windows") + r"\System32" if os.name == "nt" else "/usr/bin:/bin"
        started = time.monotonic()
        self.process = subprocess.Popen([str(self.binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, env=environment, start_new_session=os.name != "nt")
        def read():
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    self.messages.put({"type": "invalid"})
        def errors():
            for line in self.process.stderr:
                self.stderr_bytes += len(line.encode("utf-8"))
        def sample():
            while not self.sampling.wait(.1):
                if os.name != "nt":
                    snapshot = subprocess.run(["/bin/ps", "-o", "rss=", "-g", str(self.process.pid)], capture_output=True, text=True)
                    self.peak_rss = max(self.peak_rss, sum(int(value) for value in snapshot.stdout.split() if value.isdigit()) * 1024)
        for target in (read, errors, sample):
            threading.Thread(target=target, daemon=True).start()
        try:
            ready = self.messages.get(timeout=60)
            if ready != {"type": "ready", **self.manifest["contract"]}:
                raise RuntimeError("Frozen backend identity mismatch")
            self.ready_ms = round((time.monotonic() - started) * 1000)
        except BaseException:
            self.close()
            raise
        self.sequence = 0

    def request(self, action, payload, timeout=180):
        self.sequence += 1
        identifier = "synthetic-" + str(self.sequence)
        started = time.monotonic()
        self.process.stdin.write(json.dumps({"action": action, "payload": payload, "requestId": identifier,
                                            "generation": self.generation, "deadlineMs": int(time.time() * 1000) + timeout * 1000}) + "\n")
        self.process.stdin.flush()
        limit = time.monotonic() + timeout + 10
        while True:
            message = self.messages.get(timeout=max(.01, limit - time.monotonic()))
            if message.get("requestId") == identifier and message.get("type") == "result":
                if message.get("success") is not True:
                    # A cloud error can include a response body or signed URL.
                    raise RuntimeError("Frozen backend request did not succeed")
                return message["data"], round((time.monotonic() - started) * 1000)
            if time.monotonic() >= limit:
                raise TimeoutError("Frozen backend request timed out")

    def close(self):
        if self.closed:
            return
        started = time.monotonic()
        try:
            if self.process.stdin and not self.process.stdin.closed:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    self.process.terminate()
                else:
                    os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=10)
        finally:
            self.sampling.set()
        self.exit_ms = round((time.monotonic() - started) * 1000)
        if os.name != "nt":
            try:
                os.killpg(self.process.pid, 0)
                raise RuntimeError("Owned backend process group is still alive")
            except ProcessLookupError:
                pass
        state = json.loads((self.directory / "worker.json").read_text())
        if self.process.returncode != 0 or state.get("state") != "stopped" or sorted(file.name for file in self.directory.iterdir()) != ["worker.json"]:
            raise RuntimeError("Frozen backend did not cleanly stop and reclaim its session")
        self.closed = True

    def summary(self):
        return {"readyMs": self.ready_ms, "exitMs": self.exit_ms, "peakOwnedTreeRssMiB": round(self.peak_rss / 1024 ** 2, 1),
                "rssMethod": "sum of owned POSIX group RSS sampled every 100ms; shared pages may be counted twice" if os.name != "nt" else "unavailable",
                "treeStopped": self.closed, "stderrBytes": self.stderr_bytes}
