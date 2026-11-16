"""Release-only correspondence gate; ordinary source-export builds do not use Git."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile


def verify(root: Path, ref: str, inputs: dict[str, str]) -> str:
    root = root.resolve()

    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=root)

    if Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve() != root:
        raise RuntimeError("Release source must be the Git checkout root")
    commit = git("rev-parse", "--verify", ref + "^{commit}").decode().strip()
    if commit != git("rev-parse", "HEAD").decode().strip() or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise RuntimeError("Release source requires the fixed SHA-1 checkout commit")
    tracked: dict[str, tuple[str, str]] = {}
    for record in git("ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        fields, name = record.split(b"\t", 1)
        mode, kind, oid = fields.decode("ascii").split()
        path = name.decode("utf-8")
        portable = PurePosixPath(path)
        if kind != "blob" or mode not in ("100644", "100755") or portable.is_absolute() or ".." in portable.parts or "\\" in path:
            raise RuntimeError("Unsupported release source tree entry: " + path)
        tracked[path] = (mode, oid)
    for name in inputs:
        if name not in tracked:
            raise RuntimeError("Untracked release input: " + name)
    # Read the actual Git archive as well as its tree. This rejects export-ignore,
    # export-subst and other transformations that would omit/change tracked bytes.
    with tempfile.TemporaryFile() as stream:
        subprocess.run(["git", "--no-optional-locks", "archive", "--format=tar", commit], cwd=root, stdout=stream, check=True)
        stream.seek(0)
        seen: set[str] = set()
        with tarfile.open(fileobj=stream, mode="r:") as archive:
            for member in archive:
                if member.isdir():
                    continue
                name = member.name
                if not member.isfile() or name in seen or name not in tracked:
                    raise RuntimeError("Unexpected release archive entry: " + name)
                seen.add(name)
                mode, oid = tracked[name]
                reader = archive.extractfile(member)
                if reader is None:
                    raise RuntimeError("Missing release archive bytes: " + name)
                data = reader.read()
                actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                if actual != oid or bool(member.mode & 0o111) != (mode == "100755"):
                    raise RuntimeError("Release archive differs from Git tree: " + name)
                file = root / name
                if file.resolve() != file or not file.is_file() or file.read_bytes() != data:
                    raise RuntimeError("Release checkout differs from Git tree: " + name)
                if name in inputs and hashlib.sha256(data).hexdigest() != inputs[name]:
                    raise RuntimeError("Release input changed during identity calculation: " + name)
        if seen != tracked.keys():
            raise RuntimeError("Release archive omits tracked files")
    return commit


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify-release-source.py ROOT COMMIT (JSON input hashes on stdin)")
    value = json.load(sys.stdin)
    if not isinstance(value, dict) or not value or any(not isinstance(k, str) or not isinstance(v, str) or not re.fullmatch(r"[a-f0-9]{64}", v) for k, v in value.items()):
        raise SystemExit("Invalid release input hashes")
    print(verify(Path(sys.argv[1]), sys.argv[2], value))
