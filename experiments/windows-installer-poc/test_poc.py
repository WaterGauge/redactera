"""Portable source and observation-contract tests; no Windows behavior is simulated as a pass."""
from copy import deepcopy
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

from verify_observations import EMPTY, observation_check, version

ROOT = Path(__file__).parent
NS = {"w": "http://wixtoolset.org/schemas/v4/wxs",
      "u": "http://wixtoolset.org/schemas/v4/wxs/util",
      "b": "http://wixtoolset.org/schemas/v4/wxs/bal"}
ARTIFACT = {"schema": 1, "kind": "synthetic-poc-not-release", "bundleSha256": "a" * 64,
            "payloadSha256": "b" * 64, "minimumVcVersion": "14.44.35211.0"}
FULL = dict(EMPTY, markerVersion="1.0.0", payloadSha256="b" * 64, visibleBundle=1, registeredMsi=1)


def fixtures(scope):
    result = []
    for phase in ("baseline", "installed", "repaired", "removed"):
        for account in ("c" * 64, "d" * 64):
            installed = phase in ("installed", "repaired")
            result.append({
                "schema": 1, "runId": "a81cb8a7-30c2-4e04-a049-aeb8831ce10e", "phase": phase,
                "accountToken": account, "elevated": False, "architecture": "x64",
                "build": "19045", "ubr": 1, "edition": "Synthetic",
                "bundleSha256": "a" * 64,
                "user": deepcopy(FULL if installed and scope == "user" and account.startswith("c") else EMPTY),
                "machine": deepcopy(FULL if installed and scope == "machine" else EMPTY),
                "vcInstalled": None if phase == "baseline" else 1,
                "vcVersion": None if phase == "baseline" else "v14.44.35211.0",
            })
    return result


class TestObservationContract(unittest.TestCase):
    def test_two_scopes_are_consistent_but_not_acceptance(self):
        for scope in ("user", "machine"):
            with self.subTest(scope=scope):
                result = observation_check(ARTIFACT, fixtures(scope), scope)
                self.assertEqual(result["status"], "observations-consistent")
                self.assertIs(result["nativeAcceptance"], False)

    def test_negative_observations(self):
        for index, field, value in (
            (1, "accountToken", "c" * 64), (2, "elevated", True), (2, "bundleSha256", "e" * 64),
            (2, "build", "22631"), (3, "user", FULL), (2, "machine", FULL), (4, "user", EMPTY),
            (6, "user", FULL), (6, "vcInstalled", 0), (4, "vcVersion", "14.0.0.0"),
            (4, "phase", "installed"), (0, "user", FULL), (3, "runId", "different"),
        ):
            with self.subTest(index=index, field=field):
                sample = fixtures("user")
                sample[index][field] = value
                with self.assertRaises(ValueError):
                    observation_check(ARTIFACT, sample, "user")

    def test_rejects_duplicate_arp_and_wrong_payload(self):
        for field, value in (("visibleBundle", 2), ("visibleMsi", 1), ("registeredMsi", 0),
                             ("payloadSha256", "f" * 64)):
            with self.subTest(field=field):
                sample = fixtures("machine")
                sample[3]["machine"][field] = value
                with self.assertRaises(ValueError):
                    observation_check(ARTIFACT, sample, "machine")

    def test_machine_runtime_must_match_across_accounts(self):
        sample = fixtures("user")
        sample[1].update(vcInstalled=1, vcVersion="14.44.35211.0")
        with self.assertRaisesRegex(ValueError, "differ between accounts"):
            observation_check(ARTIFACT, sample, "user")
        sample = fixtures("machine")
        sample[2]["vcInstalled"] = True
        with self.assertRaisesRegex(ValueError, "Invalid VC Installed"):
            observation_check(ARTIFACT, sample, "machine")

    def test_existing_newer_runtime_must_not_downgrade(self):
        sample = fixtures("user")
        for row in sample[:2]:
            row.update(vcInstalled=1, vcVersion="14.51.100.0")
        with self.assertRaisesRegex(ValueError, "downgraded"):
            observation_check(ARTIFACT, sample, "user")
        for row in sample:
            row.update(vcInstalled=1, vcVersion="14.51.100.0")
        observation_check(ARTIFACT, sample, "user")

    def test_requires_all_observations(self):
        with self.assertRaises(ValueError):
            observation_check(ARTIFACT, fixtures("user")[:-1], "user")

    def test_numeric_versions(self):
        self.assertGreater(version("14.100.0.0"), version("v14.9.0.0"))
        for invalid in (None, "14.44", "14.44.0.0junk", "14.-1.0.0"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                version(invalid)


class TestCandidateSources(unittest.TestCase):
    def test_msi_is_dual_scope_and_synthetic_only(self):
        root = ET.parse(ROOT / "Package.wxs").getroot()
        package = root.find("w:Package", NS)
        self.assertEqual(package.get("Scope"), "perUserOrMachine")
        self.assertEqual(package.get("UpgradeStrategy"), "none")
        self.assertEqual(root.find(".//w:StandardDirectory", NS).get("Id"), "ProgramFiles64Folder")
        self.assertEqual(root.find(".//w:RegistryValue", NS).get("Root"), "HKMU")
        self.assertEqual([x.get("Source") for x in root.findall(".//w:File", NS)], ["marker.txt"])
        for element in ("CustomAction", "ServiceInstall", "RemoveFile", "RemoveRegistryKey"):
            self.assertIsNone(root.find(".//w:" + element, NS))
        self.assertIn("SYNTHETIC MARKER ONLY", (ROOT / "marker.txt").read_text())

    def test_bundle_embeds_permanent_prerequisite_then_msi(self):
        root = ET.parse(ROOT / "Bundle.wxs").getroot()
        bundle = root.find("w:Bundle", NS)
        self.assertEqual(bundle.get("Compressed"), "yes")
        chain = root.find(".//w:Chain", NS)
        self.assertEqual([x.tag.split("}")[-1] for x in chain], ["ExePackage", "MsiPackage"])
        exe, msi = chain
        for key in ("Permanent", "PerMachine", "Vital", "Compressed"):
            self.assertEqual(exe.get(key), "yes")
        self.assertEqual(msi.get("Visible"), "no")
        self.assertIsNone(msi.get("ForcePerMachine"))
        self.assertIsNone(exe.get("DownloadUrl"))
        self.assertIn("VcInstalled = 1", exe.get("DetectCondition"))
        self.assertIn("$(MinimumVcVersion)", exe.get("DetectCondition"))
        self.assertEqual({x.get("Value"): x.get("Behavior") for x in exe},
                         {"0": "success", "3010": "scheduleReboot", "1641": "forceReboot", None: "error"})
        for search in root.findall(".//u:RegistrySearch", NS):
            self.assertEqual(search.get("Bitness"), "always64")
            self.assertTrue(search.get("Key").endswith(r"\x64"))
        self.assertIsNotNone(root.find(".//b:WixStandardBootstrapperApplication", NS))


if __name__ == "__main__":
    unittest.main()
