"""Run the pure update-selection contract without network or signing keys."""
from pathlib import Path
import shutil
import subprocess

import pytest


def test_trusted_update_policy():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is not available')
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [node, '--test', str(root / 'scripts/trusted-update-policy.node-test.cjs')],
        cwd=root, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
