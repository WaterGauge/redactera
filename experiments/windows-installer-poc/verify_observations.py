"""Verify exact synthetic build/observation identities; never certify native acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from uuid import UUID
import xml.etree.ElementTree as ET

HEX = re.compile(r"[0-9a-f]{64}")
GIT = re.compile(r"[0-9a-f]{40}")
GUID = re.compile(r"\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}")
VC = re.compile(r"v?(14)\.([0-9]+)\.([0-9]+)\.([0-9]+)")
WIX = re.compile(r"7\.0\.1(?:\+[0-9A-Za-z.-]+)?")
PRODUCT_FAMILY = "{B76229C2-D71D-4261-90C2-FC952F91D148}"
BUNDLE_FAMILY = "{EEA7864A-A7E7-46B7-977E-DAACFC94F4E5}"
SOURCES = ("Package.wxs", "Bundle.wxs", "marker.txt", "Build-Poc.ps1", "Get-PocState.ps1",
           "PocNative.ps1", "verify_observations.py", "test_poc.py", "README.md")
TOOLS = ("wix", "bal", "util", "vcRedist")
ARTIFACT = ("schema", "kind", "wixVersion", "minimumVcVersion", "sourceCommit", "sourceTree", "sourceHashes",
            "toolHashes", "msiSha256", "bundleSha256", "payloadSha256", "manifestSha256", "productCode",
            "bundleCode", "productUpgradeCode", "bundleUpgradeCode", "ice")
RECEIPT = ("schema", "runId", "phase", "accountToken", "elevated", "architecture", "build", "ubr", "edition",
           "bundleSha256", "artifactSha256", "productCode", "bundleCode", "user", "machine", "vcInstalled", "vcVersion")
EMPTY = dict(marker64=None, marker32=None, payloadSha256=None, bundleEntries=[], msiEntries=[], contexts=[])


def fields(value, required):
    if type(value) is not dict or set(value) != set(required):
        raise ValueError("Unexpected or missing object fields")


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid integer")
    return value


def match(pattern, value):
    if type(value) is not str or not pattern.fullmatch(value):
        raise ValueError("Invalid string identity or format")
    return value


def digest(value):
    return match(HEX, value)


def guid(value):
    return match(GUID, value)


def version(value):
    m = VC.fullmatch(value) if type(value) is str else None
    if m is None or any(len(part) > 5 for part in m.groups()):
        raise ValueError("Invalid v14 VC version")
    return tuple(integer(int(part), 0, 65535) for part in m.groups())


def artifact_check(artifact):
    fields(artifact, ARTIFACT)
    integer(artifact["schema"], 2, 2)
    if artifact["kind"] != "synthetic-poc-not-release":
        raise ValueError("Not a synthetic PoC artifact")
    match(WIX, artifact["wixVersion"])
    version(artifact["minimumVcVersion"])
    if artifact["minimumVcVersion"].startswith("v"):
        raise ValueError("Minimum must be a four-field numeric version")
    for key in ("sourceCommit", "sourceTree"):
        match(GIT, artifact[key])
    for key, names in (("sourceHashes", SOURCES), ("toolHashes", TOOLS)):
        fields(artifact[key], names)
        for value in artifact[key].values():
            digest(value)
    for key in ("msiSha256", "bundleSha256", "payloadSha256", "manifestSha256"):
        digest(artifact[key])
    if artifact["payloadSha256"] != artifact["sourceHashes"]["marker.txt"]:
        raise ValueError("Marker hash mismatch")
    if artifact["productUpgradeCode"] != PRODUCT_FAMILY or artifact["bundleUpgradeCode"] != BUNDLE_FAMILY:
        raise ValueError("Wrong synthetic family")
    codes = {guid(artifact[key]) for key in ("productCode", "bundleCode", "productUpgradeCode", "bundleUpgradeCode")}
    if len(codes) != 4 or "{00000000-0000-0000-0000-000000000000}" in codes:
        raise ValueError("Invalid synthetic registration codes")
    ice = artifact["ice"]
    fields(ice, ("fullExit", "ice105Exit", "fullLogSha256", "ice105LogSha256"))
    integer(ice["fullExit"], 0, 0)
    integer(ice["ice105Exit"], 0, 0)
    digest(ice["fullLogSha256"])
    digest(ice["ice105LogSha256"])


def file_digest(path):
    if path.resolve() != path.absolute() or not path.is_file():
        raise ValueError("Missing or linked evidence file")
    with path.open("rb") as reader:
        return hashlib.file_digest(reader, "sha256").hexdigest()


def verify_artifact_files(artifact, directory, approved):
    """Bind the artifact claims to independent approved input hashes and actual bytes."""
    artifact_check(artifact)
    directory = directory.resolve()
    for key in ("sourceCommit", "sourceTree", "sourceHashes", "wixVersion", "minimumVcVersion"):
        if artifact[key] != approved[key]:
            raise ValueError("Artifact differs from approved inputs")
    for name in TOOLS:
        if artifact["toolHashes"][name] != digest(approved[name]["sha256"]):
            raise ValueError("Artifact tool identity differs from approval")
    hashes = dict(artifact["sourceHashes"], **{
        "RedacteraInstallerPoC.msi": artifact["msiSha256"],
        "RedacteraInstallerPoC-Setup.exe": artifact["bundleSha256"],
        "vc_redist.x64.exe": artifact["toolHashes"]["vcRedist"],
        "ice-full.log": artifact["ice"]["fullLogSha256"],
        "ice105.log": artifact["ice"]["ice105LogSha256"],
        "ba/manifest.xml": artifact["manifestSha256"],
    })
    for name, expected in hashes.items():
        if file_digest(directory / name) != expected:
            raise ValueError("Evidence bytes differ from artifact: " + name)
    for name in ("RedacteraInstallerPoC.msi", "vc_redist.x64.exe"):
        copies = list((directory / "attached").rglob(name))
        if len(copies) != 1 or file_digest(copies[0]) != hashes[name]:
            raise ValueError("Embedded payload evidence mismatch")
    root = ET.parse(directory / "ba/manifest.xml").getroot()
    ns = {"b": root.tag.partition("}")[0][1:]} if root.tag.startswith("{") else {"b": ""}
    if root.tag.split("}")[-1] != "BurnManifest":
        raise ValueError("Invalid Burn manifest")
    registrations = root.findall("b:Registration", ns)
    packages = root.findall("b:Chain/b:MsiPackage[@Id='MarkerMsi']", ns)
    if (len(registrations) != 1 or len(packages) != 1 or
            registrations[0].get("Code", "").upper() != artifact["bundleCode"] or
            registrations[0].get("PrimaryUpgradeCode", "").upper() != BUNDLE_FAMILY or
            packages[0].get("ProductCode", "").upper() != artifact["productCode"]):
        raise ValueError("Burn manifest identity mismatch")


def entries(value, bundle):
    if type(value) is not list or len(value) > 32:
        raise ValueError("Invalid registration list")
    codes = set()
    for item in value:
        fields(item, ("code", "hidden", "nameMatches", "views", "familyMatches", "installed") if bundle else
               ("code", "hidden", "nameMatches", "views"))
        code = guid(item["code"])
        if code in codes:
            raise ValueError("Duplicate registration code")
        codes.add(code)
        for name in ("hidden", "nameMatches") + (("familyMatches",) if bundle else ()):
            if type(item[name]) is not bool:
                raise ValueError("Invalid registration flag")
        if bundle and item["installed"] is not None:
            integer(item["installed"], 0, 1)
        views = item["views"]
        if type(views) is not list or any(type(view) is not int for view in views) or views not in ([32], [64], [32, 64]):
            raise ValueError("Invalid registry views")


def scope_check(item, artifact, active, machine):
    fields(item, EMPTY)
    for key in ("marker64", "marker32"):
        if item[key] is not None and type(item[key]) is not str:
            raise ValueError("Invalid marker version")
    if item["payloadSha256"] is not None:
        digest(item["payloadSha256"])
    entries(item["bundleEntries"], True)
    entries(item["msiEntries"], False)
    contexts = item["contexts"]
    if type(contexts) is not list or len(contexts) > 32:
        raise ValueError("Invalid MSI contexts")
    for context in contexts:
        fields(context, ("code", "context"))
        guid(context["code"])
        integer(context["context"], 1, 4)
        if context["context"] not in (1, 2, 4):
            raise ValueError("Invalid MSI context")
    if not active:
        if item != EMPTY:
            raise ValueError("Unexpected residual marker or registration")
        return
    if (item["marker64"] != "1.0.0" or item["marker32"] not in ((None,) if machine else (None, "1.0.0")) or
            item["payloadSha256"] != artifact["payloadSha256"] or len(item["bundleEntries"]) != 1 or len(item["msiEntries"]) != 1 or
            contexts != [{"code": artifact["productCode"], "context": 4 if machine else 2}]):
        raise ValueError("Unexpected installed scope, context or payload")
    bundle, msi = item["bundleEntries"][0], item["msiEntries"][0]
    if (bundle["code"] != artifact["bundleCode"] or bundle["hidden"] or not bundle["nameMatches"] or
            not bundle["familyMatches"] or bundle["installed"] != 1 or msi["code"] != artifact["productCode"] or
            not msi["hidden"] or not msi["nameMatches"] or
            (machine and (len(bundle["views"]) != 1 or len(msi["views"]) != 1))):
        raise ValueError("Unexpected actual registration identity or visibility")


def observation_check(artifact, observations, scope, artifact_hash):
    artifact_check(artifact)
    digest(artifact_hash)
    if scope not in ("user", "machine") or type(observations) is not list or len(observations) != 8:
        raise ValueError("Need four phases from two accounts")
    for item in observations:
        fields(item, RECEIPT)
    a, b = (digest(item["accountToken"]) for item in observations[:2])
    if a == b:
        raise ValueError("Require two different login accounts")
    first = observations[0]
    run = str(UUID(match(re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"), first["runId"])))
    host = (first["build"], first["ubr"], first["edition"])
    minimum = version(artifact["minimumVcVersion"])
    last_vc = None
    for index, item in enumerate(observations):
        integer(item["schema"], 2, 2)
        integer(item["ubr"], 0, 2147483647)
        build = match(re.compile(r"[0-9]{5,6}"), item["build"])
        integer(int(build), 19045, 999999)
        match(re.compile(r"[A-Za-z0-9][A-Za-z0-9_. -]{0,127}"), item["edition"])
        phase = ("baseline", "installed", "repaired", "removed")[index // 2]
        account = a if index % 2 == 0 else b
        if (item["runId"] != run or item["phase"] != phase or item["accountToken"] != account or
                item["elevated"] is not False or item["architecture"] != "x64" or
                item["bundleSha256"] != artifact["bundleSha256"] or item["artifactSha256"] != artifact_hash or
                item["productCode"] != artifact["productCode"] or item["bundleCode"] != artifact["bundleCode"] or
                (item["build"], item["ubr"], item["edition"]) != host):
            raise ValueError("Observation identity or order mismatch")
        active = phase in ("installed", "repaired")
        scope_check(item["user"], artifact, active and scope == "user" and account == a, False)
        scope_check(item["machine"], artifact, active and scope == "machine", True)
        flag = item["vcInstalled"]
        if flag is not None:
            integer(flag, 0, 1)
        if index % 2 and (flag, item["vcVersion"]) != (observations[index - 1]["vcInstalled"], observations[index - 1]["vcVersion"]):
            raise ValueError("Machine VC observations differ between accounts")
        if flag == 1:
            current = version(item["vcVersion"])
            if last_vc is not None and current < last_vc:
                raise ValueError("VC runtime downgraded")
            if phase != "baseline" and current < minimum:
                raise ValueError("VC runtime below minimum")
            last_vc = current
        elif item["vcVersion"] is not None or phase != "baseline" or last_vc is not None:
            raise ValueError("Invalid, missing or removed VC runtime")
    return {"status": "observations-consistent", "scope": scope, "nativeAcceptance": False, "observations": len(observations)}


def load_json(path):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError("Duplicate JSON key")
            obj[key] = value
        return obj
    def invalid_constant(value):
        raise ValueError("Invalid JSON constant: " + value)
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique, parse_constant=invalid_constant)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--approved-inputs", required=True, type=Path)
    parser.add_argument("--scope", required=True, choices=("user", "machine"))
    parser.add_argument("receipts", nargs=8, type=Path)
    args = parser.parse_args()
    try:
        artifact_hash = file_digest(args.artifact.absolute())
        artifact = load_json(args.artifact)
        verify_artifact_files(artifact, args.artifact.parent, load_json(args.approved_inputs))
        receipts = [load_json(path) for path in args.receipts]
        if file_digest(args.artifact.absolute()) != artifact_hash:
            raise ValueError("Artifact changed during verification")
        print(json.dumps(observation_check(artifact, receipts, args.scope, artifact_hash)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, ET.ParseError) as exc:
        parser.exit(1, f"Inconsistent or incomplete evidence: {exc}\n")


if __name__ == "__main__":
    main()
