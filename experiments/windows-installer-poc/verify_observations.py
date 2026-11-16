"""Check a narrow set of native PoC observations, never certify native acceptance."""
import argparse
import json
from pathlib import Path
import re
from uuid import UUID

HEX = re.compile(r"[0-9a-f]{64}")
VC = re.compile(r"v?([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)")
EMPTY = dict(markerVersion=None, payloadSha256=None, visibleBundle=0, registeredMsi=0, visibleMsi=0)


def version(value):
    match = VC.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("Invalid VC version")
    return tuple(map(int, match.groups()))


def digest(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError("Invalid SHA256")
    return value


def observation_check(artifact, observations, scope):
    """Raise on absent/inconsistent evidence. Scope is user or machine."""
    if artifact.get("schema") != 1 or artifact.get("kind") != "synthetic-poc-not-release":
        raise ValueError("Not a synthetic PoC artifact")
    setup_hash = digest(artifact["bundleSha256"])
    payload_hash = digest(artifact["payloadSha256"])
    minimum = version(artifact["minimumVcVersion"])
    if minimum[0] != 14 or scope not in ("user", "machine"):
        raise ValueError("Invalid PoC inputs")
    full = dict(EMPTY, markerVersion="1.0.0", payloadSha256=payload_hash, visibleBundle=1, registeredMsi=1)
    if len(observations) != 8:
        raise ValueError("Need before/install/repair/remove observations from both A and B")
    a, b = observations[0]["accountToken"], observations[1]["accountToken"]
    if digest(a) == digest(b):
        raise ValueError("Require two different login accounts")
    first = observations[0]
    run = str(UUID(first["runId"]))
    host = (first["build"], first["ubr"], first["edition"])
    if not isinstance(host[0], str) or not host[0].isdigit() or int(host[0]) < 19045:
        raise ValueError("Unqualified Windows build")
    last_vc = None
    for index, item in enumerate(observations):
        phase = ("baseline", "installed", "repaired", "removed")[index // 2]
        account = a if index % 2 == 0 else b
        if (item["schema"] != 1 or item["runId"] != run or item["phase"] != phase
                or item["accountToken"] != account or item["elevated"] is not False
                or item["architecture"] != "x64" or item["bundleSha256"] != setup_hash
                or (item["build"], item["ubr"], item["edition"]) != host):
            raise ValueError("Observation identity or order mismatch")
        installed = phase in ("installed", "repaired")
        want_user = full if installed and scope == "user" and account == a else EMPTY
        want_machine = full if installed and scope == "machine" else EMPTY
        if item["user"] != want_user or item["machine"] != want_machine:
            raise ValueError("Unexpected marker, payload or uninstall registration")
        flag = item["vcInstalled"]
        if flag is not None and (type(flag) is not int or flag not in (0, 1)):
            raise ValueError("Invalid VC Installed value")
        if index % 2 and (flag, item["vcVersion"]) != (observations[index - 1]["vcInstalled"], observations[index - 1]["vcVersion"]):
            raise ValueError("Machine VC observations differ between accounts")
        if flag == 1:
            current = version(item["vcVersion"])
            if last_vc is not None and current < last_vc:
                raise ValueError("VC runtime was downgraded")
            if phase != "baseline" and current < minimum:
                raise ValueError("VC runtime below minimum")
            last_vc = current
        elif phase != "baseline" or last_vc is not None:
            raise ValueError("VC runtime missing or removed")
    return {"status": "observations-consistent", "scope": scope,
            "nativeAcceptance": False, "observations": len(observations)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--scope", required=True, choices=("user", "machine"))
    parser.add_argument("receipts", nargs=8, type=Path, help="A/B baseline, A/B installed, A/B repaired, A/B removed")
    args = parser.parse_args()
    try:
        artifact = json.loads(args.artifact.read_text(encoding="utf-8-sig"))
        receipts = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.receipts]
        print(json.dumps(observation_check(artifact, receipts, args.scope)))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"Inconsistent or incomplete evidence: {exc}\n")


if __name__ == "__main__":
    main()
