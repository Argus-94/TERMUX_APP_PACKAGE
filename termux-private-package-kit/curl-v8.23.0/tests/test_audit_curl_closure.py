import importlib.util
import json
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "audit_curl_closure.py"
SPEC = importlib.util.spec_from_file_location("curl_closure_auditor", MODULE_PATH)
auditor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(auditor)
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
MANIFEST = REPO_ROOT / "curl-candidate-package-set.json"
PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


class CurlAllowlistTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_exact_pinned_package_specs_are_accepted(self):
        auditor.validate_package_specs(self.manifest["packages"])

    def test_changed_source_archive_hash_is_rejected(self):
        specs = json.loads(json.dumps(self.manifest["packages"]))
        next(item for item in specs if item["name"] == "curl")["sourceSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(specs)

    def test_changed_curl_subpackage_hash_is_rejected(self):
        specs = json.loads(json.dumps(self.manifest["packages"]))
        next(item for item in specs if item["name"] == "curl")["subpackageSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(specs)

    def test_curl_license_evidence_is_inherited_only_from_exact_audited_parent(self):
        results = [
            {"name": "curl", "licenseEvidencePaths": [], "licenseEvidenceSha256": {}},
            {"name": "libcurl", "licenseEvidencePaths": [PREFIX + "/share/doc/libcurl/copyright"], "licenseEvidenceSha256": {}},
        ]
        auditor.inherit_subpackage_license_evidence(self.manifest["packages"], results)
        curl = next(item for item in results if item["name"] == "curl")
        self.assertEqual(curl["licenseEvidenceParentPackage"], "libcurl")
        self.assertEqual(curl["licenseEvidenceParentPaths"], [PREFIX + "/share/doc/libcurl/copyright"])

    def test_curl_license_inheritance_rejects_missing_parent_evidence(self):
        results = [
            {"name": "curl", "licenseEvidencePaths": [], "licenseEvidenceSha256": {}},
            {"name": "libcurl", "licenseEvidencePaths": [], "licenseEvidenceSha256": {}},
        ]
        with self.assertRaises(auditor.AuditError):
            auditor.inherit_subpackage_license_evidence(self.manifest["packages"], results)

    def test_curl_license_inheritance_rejects_parent_with_different_source(self):
        specs = json.loads(json.dumps(self.manifest["packages"]))
        next(item for item in specs if item["name"] == "curl")["sourceSha256"] = "0" * 64
        results = [
            {"name": "curl", "licenseEvidencePaths": [], "licenseEvidenceSha256": {}},
            {"name": "libcurl", "licenseEvidencePaths": [PREFIX + "/share/doc/libcurl/copyright"], "licenseEvidenceSha256": {}},
        ]
        with self.assertRaises(auditor.AuditError):
            auditor.inherit_subpackage_license_evidence(specs, results)

    def test_missing_or_extra_candidate_is_rejected(self):
        specs = self.manifest["packages"][:-1]
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(specs)

    def test_root_curl_must_be_a_regular_executable_at_exact_private_path(self):
        self.assertTrue(auditor.is_curl_executable("curl", PREFIX + "/bin/curl", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_curl_executable("curl", PREFIX + "/bin/curl", False, 0o777, PREFIX))
        self.assertFalse(auditor.is_curl_executable("curl", PREFIX + "/bin/not-curl", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_curl_executable("curl", "/usr/bin/curl", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_curl_executable("curl", PREFIX + "/bin/curl", True, 0o644, PREFIX))

    def test_private_path_helpers_reject_foreign_app_and_escape(self):
        self.assertEqual(auditor.normalize_prefix(PREFIX), PREFIX)
        with self.assertRaises(auditor.AuditError):
            auditor.normalize_prefix("/data/user/0/com.other.app/files/usr")
        with self.assertRaises(auditor.AuditError):
            auditor.resolve_link(PREFIX + "/share/doc/curl/copyright", "../../../../../../etc/passwd", False, PREFIX)


if __name__ == "__main__":
    unittest.main()
