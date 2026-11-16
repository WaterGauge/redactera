"""Portable developer tests; synthetic receipts never prove native Windows behavior."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from verify_observations import (EMPTY, SOURCES, TOOLS, PRODUCT_FAMILY, BUNDLE_FAMILY,
                                 artifact_check, observation_check, verify_artifact_files, load_json, version, verify_source_inputs)

ROOT = Path(__file__).parent
NS = {"w": "http://wixtoolset.org/schemas/v4/wxs", "u": "http://wixtoolset.org/schemas/v4/wxs/util",
      "b": "http://wixtoolset.org/schemas/v4/wxs/bal"}
PRODUCT = "{6B7D33A1-A112-4773-B348-3B6143F6A3C1}"
BUNDLE = "{0F83C8E7-149C-4CBC-B271-C6910DCD57AA}"
WRONG = "{E92D114C-D451-4503-9CA6-BD1D8B23F787}"
ARTIFACT_HASH = "e" * 64
ARTIFACT = {
    "schema": 2, "kind": "synthetic-poc-not-release", "wixVersion": "7.0.1", "minimumVcVersion": "14.44.35211.0",
    "sourceCommit": "1" * 40, "sourceTree": "2" * 40, "sourceHashes": {name: "b" * 64 for name in SOURCES},
    "toolHashes": {name: "c" * 64 for name in TOOLS}, "msiSha256": "d" * 64, "bundleSha256": "a" * 64,
    "payloadSha256": "b" * 64, "manifestSha256": "f" * 64, "productCode": PRODUCT, "bundleCode": BUNDLE,
    "productUpgradeCode": PRODUCT_FAMILY, "bundleUpgradeCode": BUNDLE_FAMILY,
    "ice": {"fullExit": 0, "ice105Exit": 0, "fullLogSha256": "1" * 64, "ice105LogSha256": "2" * 64},
}


def full(machine=False, artifact=ARTIFACT):
    return dict(marker64="1.0.0", marker32=None if machine else "1.0.0", payloadSha256=artifact["payloadSha256"],
                bundleEntries=[dict(code=artifact["bundleCode"], hidden=False, nameMatches=True, familyMatches=True,
                                    installed=1, views=[64] if machine else [32, 64])],
                msiEntries=[dict(code=artifact["productCode"], hidden=True, nameMatches=True, views=[64])],
                contexts=[dict(code=artifact["productCode"], context=4 if machine else 2)])


def fixtures(scope, artifact=ARTIFACT, artifact_hash=ARTIFACT_HASH):
    result = []
    for phase in ("baseline", "installed", "repaired", "removed"):
        for account in ("c" * 64, "d" * 64):
            active = phase in ("installed", "repaired")
            result.append(dict(schema=2, runId="a81cb8a7-30c2-4e04-a049-aeb8831ce10e", phase=phase,
                accountToken=account, elevated=False, architecture="x64", build="19045", ubr=1, edition="Synthetic",
                bundleSha256=artifact["bundleSha256"], artifactSha256=artifact_hash,
                productCode=artifact["productCode"], bundleCode=artifact["bundleCode"],
                user=full(False, artifact) if active and scope == "user" and account.startswith("c") else deepcopy(EMPTY),
                machine=full(True, artifact) if active and scope == "machine" else deepcopy(EMPTY),
                vcInstalled=None if phase == "baseline" else 1,
                vcVersion=None if phase == "baseline" else "v14.44.35211.0"))
    return result


class TestObservationContract(unittest.TestCase):
    def check(self, sample, scope="user", artifact=ARTIFACT):
        return observation_check(artifact, sample, scope, ARTIFACT_HASH)

    def test_two_scopes_are_consistent_but_not_acceptance(self):
        for scope in ("user", "machine"):
            result = self.check(fixtures(scope), scope)
            self.assertEqual(result["status"], "observations-consistent")
            self.assertIs(result["nativeAcceptance"], False)

    def test_negative_observations(self):
        for index, field, value in (
            (1, "accountToken", "c" * 64), (2, "elevated", True), (2, "bundleSha256", "f" * 64),
            (2, "build", "22631"), (3, "user", full()), (2, "machine", full(True)), (4, "user", EMPTY),
            (6, "user", full()), (6, "vcInstalled", 0), (4, "vcVersion", "14.0.0.0"), (4, "phase", "installed"),
            (0, "user", full()), (3, "runId", "different"), (2, "artifactSha256", "f" * 64),
            (2, "productCode", WRONG), (2, "bundleCode", WRONG), (2, "schema", True), (2, "schema", 2.0),
            (0, "ubr", None), (0, "edition", {}), (0, "vcVersion", {}), (2, "vcInstalled", True),
            (2, "vcVersion", "99.0.0.0"), (2, "vcVersion", "14.65536.0.0"),
        ):
            with self.subTest(index=index, field=field, value=value):
                sample = fixtures("user"); sample[index][field] = value
                with self.assertRaises(ValueError): self.check(sample)
        for key, value in (("ubr", None), ("edition", {}), ("schema", True)):
            sample = fixtures("user")
            for row in sample: row[key] = value
            with self.assertRaises(ValueError): self.check(sample)

    def test_actual_registration_identity_and_hidden_residuals(self):
        mutations = (
            lambda row: row["bundleEntries"][0].update(hidden=True),
            lambda row: row["bundleEntries"][0].update(code=WRONG),
            lambda row: row["bundleEntries"][0].update(installed=True),
            lambda row: row["bundleEntries"][0].update(installed=1.0),
            lambda row: row["bundleEntries"][0].update(familyMatches=False),
            lambda row: row["bundleEntries"].append(dict(row["bundleEntries"][0], code=WRONG, hidden=True)),
            lambda row: row["msiEntries"][0].update(code=WRONG),
            lambda row: row["msiEntries"][0].update(hidden=False),
            lambda row: row["msiEntries"][0].update(views=[32,64]),
            lambda row: row["msiEntries"][0].update(views=[64.0]),
            lambda row: row["contexts"][0].update(context=2),
            lambda row: row["contexts"].append(dict(code=WRONG, context=4)),
            lambda row: row.update(marker64=None, marker32="1.0.0"),
            lambda row: row.update(payloadSha256="f" * 64),
        )
        for mutate in mutations:
            sample = fixtures("machine"); mutate(sample[3]["machine"])
            with self.assertRaises(ValueError): self.check(sample, "machine")
        sample = fixtures("user")
        sample[6]["user"]["bundleEntries"] = [dict(full()["bundleEntries"][0], hidden=True)]
        with self.assertRaises(ValueError): self.check(sample)

    def test_machine_runtime_and_no_downgrade(self):
        sample = fixtures("user"); sample[1].update(vcInstalled=1, vcVersion="14.44.35211.0")
        with self.assertRaisesRegex(ValueError, "differ between accounts"): self.check(sample)
        sample = fixtures("user")
        for row in sample[:2]: row.update(vcInstalled=1, vcVersion="14.51.100.0")
        with self.assertRaisesRegex(ValueError, "downgraded"): self.check(sample)
        for row in sample: row.update(vcInstalled=1, vcVersion="14.51.100.0")
        self.check(sample)

    def test_requires_complete_objects(self):
        with self.assertRaises(ValueError): self.check(fixtures("user")[:-1])
        sample = fixtures("user"); sample[0]["extra"] = 0
        with self.assertRaises(ValueError): self.check(sample)
        for field in ("msiSha256", "wixVersion", "toolHashes", "sourceHashes", "sourceCommit", "ice"):
            artifact = deepcopy(ARTIFACT); del artifact[field]
            with self.assertRaises(ValueError): artifact_check(artifact)
        for field, value in (("schema", True), ("msiSha256", "bad"), ("wixVersion", "7.0.0"), ("productCode", "bad")):
            artifact = dict(ARTIFACT, **{field:value})
            with self.assertRaises(ValueError): artifact_check(artifact)

    def test_numeric_versions_and_strict_json(self):
        self.assertGreater(version("14.100.0.0"), version("v14.9.0.0"))
        for invalid in (None, "14.44", "14.44.0.0junk", "14.-1.0.0", "99.0.0.0", "14.1.99999.0"):
            with self.assertRaises(ValueError): version(invalid)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.json"
            for invalid in ('{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"a":NaN}'):
                path.write_text(invalid)
                with self.assertRaises(ValueError): load_json(path)

    def test_preflight_uses_independent_source_and_tool_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            approved = {"sourceCommit": "1" * 40, "sourceTree": "2" * 40,
                        "sourceHashes": {}, "wixVersion": "7.0.1", "minimumVcVersion": "14.51.0.0"}
            for name in SOURCES:
                path = directory / name
                path.write_bytes(name.encode())
                approved["sourceHashes"][name] = hashlib.sha256(path.read_bytes()).hexdigest()
            for name in TOOLS:
                path = directory / name
                path.write_bytes(name.encode())
                approved[name] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            self.assertFalse(verify_source_inputs(directory, approved)["toolsChecked"])
            self.assertTrue(verify_source_inputs(directory, approved, True)["toolsChecked"])
            helper = directory / "PocNative.ps1"
            original = helper.read_bytes()
            # The harmless marker is only data here. The native no-execution
            # control must run separately in an authorized Windows snapshot.
            helper.write_bytes(b"Write-Output 'SYNTHETIC-HASH-NEGATIVE'")
            with self.assertRaisesRegex(ValueError, "Preflight source mismatch"):
                verify_source_inputs(directory, approved)
            helper.write_bytes(original)
            (directory / "wix").write_bytes(b"changed tool")
            with self.assertRaisesRegex(ValueError, "Preflight tool mismatch"):
                verify_source_inputs(directory, approved, True)

    def test_artifact_external_hash_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve(); artifact = deepcopy(ARTIFACT)
            def put(name, data):
                file = directory / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(data)
                return hashlib.sha256(data).hexdigest()
            artifact["sourceHashes"] = {name:put(name, name.encode()) for name in SOURCES}
            artifact["payloadSha256"] = artifact["sourceHashes"]["marker.txt"]
            artifact["msiSha256"] = put("RedacteraInstallerPoC.msi", b"synthetic MSI")
            artifact["bundleSha256"] = put("RedacteraInstallerPoC-Setup.exe", b"synthetic EXE")
            artifact["toolHashes"]["vcRedist"] = put("vc_redist.x64.exe", b"synthetic VC")
            artifact["ice"]["fullLogSha256"] = put("ice-full.log", b"synthetic full validation")
            artifact["ice"]["ice105LogSha256"] = put("ice105.log", b"synthetic ICE105")
            manifest = ('<BurnManifest xmlns="urn:synthetic"><Registration Code="'+BUNDLE+'" PrimaryUpgradeCode="'+BUNDLE_FAMILY+
                        '"/><Chain><MsiPackage Id="MarkerMsi" ProductCode="'+PRODUCT+'"/></Chain></BurnManifest>').encode()
            artifact["manifestSha256"] = put("ba/manifest.xml", manifest)
            put("attached/test/RedacteraInstallerPoC.msi", b"synthetic MSI")
            put("attached/test/vc_redist.x64.exe", b"synthetic VC")
            approved = {key:deepcopy(artifact[key]) for key in ("sourceCommit","sourceTree","sourceHashes","wixVersion","minimumVcVersion")}
            approved.update({name:{"sha256":artifact["toolHashes"][name]} for name in TOOLS})
            verify_artifact_files(artifact, directory, approved)
            bad = deepcopy(approved); bad["sourceCommit"] = "9" * 40
            with self.assertRaises(ValueError): verify_artifact_files(artifact, directory, bad)
            for name in ("ice105.log", "Build-Poc.ps1", "RedacteraInstallerPoC-Setup.exe", "attached/test/RedacteraInstallerPoC.msi"):
                path=directory/name; original=path.read_bytes(); path.write_bytes(b"changed")
                with self.assertRaises(ValueError): verify_artifact_files(artifact, directory, approved)
                path.write_bytes(original)
            bad = deepcopy(artifact); bad["manifestSha256"] = put("ba/manifest.xml", manifest.replace(PRODUCT.encode(), WRONG.encode()))
            with self.assertRaises(ValueError): verify_artifact_files(bad, directory, approved)


class TestCandidateSources(unittest.TestCase):
    def test_msi_is_dual_scope_and_synthetic_only(self):
        root = ET.parse(ROOT / "Package.wxs").getroot(); package = root.find("w:Package", NS)
        self.assertEqual(package.get("Scope"), "perUserOrMachine")
        self.assertEqual(package.get("UpgradeStrategy"), "none")
        self.assertEqual(root.find(".//w:StandardDirectory", NS).get("Id"), "ProgramFiles64Folder")
        self.assertEqual(root.find(".//w:RegistryValue", NS).get("Root"), "HKMU")
        self.assertEqual([x.get("Source") for x in root.findall(".//w:File", NS)], ["marker.txt"])
        for element in ("CustomAction", "ServiceInstall", "RemoveFile", "RemoveRegistryKey"):
            self.assertIsNone(root.find(".//w:" + element, NS))
        self.assertIn("SYNTHETIC MARKER ONLY", (ROOT / "marker.txt").read_text())

    def test_bundle_embeds_permanent_prerequisite_then_msi(self):
        root = ET.parse(ROOT / "Bundle.wxs").getroot(); bundle = root.find("w:Bundle", NS)
        self.assertEqual(bundle.get("Compressed"), "yes")
        chain = root.find(".//w:Chain", NS); self.assertEqual([x.tag.split("}")[-1] for x in chain], ["ExePackage", "MsiPackage"])
        exe, msi = chain
        for key in ("Permanent", "PerMachine", "Vital", "Compressed"): self.assertEqual(exe.get(key), "yes")
        self.assertEqual(msi.get("Visible"), "no"); self.assertIsNone(msi.get("ForcePerMachine")); self.assertIsNone(exe.get("DownloadUrl"))
        self.assertIn("VcInstalled = 1", exe.get("DetectCondition")); self.assertIn("$(MinimumVcVersion)", exe.get("DetectCondition"))
        self.assertEqual({x.get("Value"):x.get("Behavior") for x in exe}, {"0":"success","3010":"scheduleReboot","1641":"forceReboot",None:"error"})
        for search in root.findall(".//u:RegistrySearch", NS): self.assertEqual(search.get("Bitness"), "always64")
        self.assertIsNotNone(root.find(".//b:WixStandardBootstrapperApplication", NS))

    def test_native_source_gates_are_explicit_not_executed(self):
        build=(ROOT/"Build-Poc.ps1").read_text(); native=(ROOT/"PocNative.ps1").read_text(); observe=(ROOT/"Get-PocState.ps1").read_text()
        self.assertIn("@('msi','validate',$msi)", build); self.assertIn("@('msi','validate','-ice','ICE105',$msi)", build)
        self.assertLess(build.index("'ice105.log'"), build.index("'bundle-build.log'"))
        self.assertLess(build.index("'bundle-extract.log'"), build.index("'artifact.json'"))
        self.assertIn("ReparsePoint", native); self.assertIn("DriveType]::Fixed", native); self.assertNotIn("IsPathRooted", build+native)
        self.assertIn("MsiEnumProductsExW", native); self.assertIn("MsiEnumRelatedProductsW", native)
        self.assertIn("BundleUpgradeCode", observe); self.assertIn("Registry32", observe); self.assertIn("Registry64", observe)
        for entry in (build, observe):
            self.assertLess(entry.index("Helper identity mismatch before execution"), entry.index(". $helper"))
            self.assertIn("-cne $ExpectedHelperSha256", entry)



if __name__ == "__main__":
    unittest.main()
