import importlib.util
import pathlib
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OperationsReports(unittest.TestCase):
    def test_drift_never_exposes_values(self):
        report = load("terraform-drift").report_plan({"resource_changes": [
            {"address": "aws_lambda_function.worker", "mode": "managed", "change": {
                "actions": ["update"], "before": {"secret": "PRIVATE"}, "after": {"secret": "PRIVATE"}}}]})
        self.assertNotIn("PRIVATE", str(report))
        self.assertIn("aws_lambda_function.worker", str(report))

    def test_container_includes_unfixed_vulnerabilities(self):
        module = load("container-security")
        report = module.inspect({"Results": [{"Vulnerabilities": [{"Severity": "CRITICAL", "PkgName": "pkg",
            "InstalledVersion": "1.0", "VulnerabilityID": "CVE-2026-123"}]}]})
        self.assertEqual(report["status"], "findings")
        with self.assertRaises(ValueError):
            module.inspect({})

    def test_container_distinguishes_reviewed_findings_without_hiding_raw_count(self):
        report = load("container-security").inspect({"Results": [{"Vulnerabilities": [],
            "ExperimentalModifiedFindings": [{"Finding": {"Severity": "HIGH", "VulnerabilityID": "CVE-2026-119170"}}]}]})
        self.assertEqual(report["status"], "ok")
        self.assertIn('評価済み検出が1件', report["summary"])
