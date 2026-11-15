"""Importing the backend must not take ownership of its host's standard streams."""
import json
import os
from pathlib import Path
import subprocess
import sys


def test_import_preserves_host_standard_streams():
    program = """
import json
import sys
streams = (sys.stdin, sys.stdout, sys.stderr)
import main
unchanged = all(before is after for before, after in zip(streams, (sys.stdin, sys.stdout, sys.stderr)))
main.processor.cleanup()
print(json.dumps({"unchanged": unchanged, "text": "中文"}, ensure_ascii=False))
"""
    result = subprocess.run(
        [sys.executable, "-c", program], cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        capture_output=True, encoding="utf-8", check=True,
    )
    assert json.loads(result.stdout) == {"unchanged": True, "text": "中文"}
