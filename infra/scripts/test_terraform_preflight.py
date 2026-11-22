import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import terraform_preflight


class PreflightTests(unittest.TestCase):
    def inspect(self, result):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            summary = Path(directory) / "summary"
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}), \
                    patch.object(terraform_preflight.subprocess, "run", **result) as run, \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = terraform_preflight.main()
            return (code, output.read_text() if output.exists() else "",
                    summary.read_text() if summary.exists() else "",
                    stdout.getvalue() + stderr.getvalue(), run.call_args)

    def completed(self, code):
        # These stand in for resource values or diagnostics; neither may leak.
        result = subprocess.CompletedProcess([], code, stdout=b"PRIVATE_PLAN_VALUE", stderr=b"PRIVATE_PROVIDER_ERROR")
        if code == 2:
            return self.inspect({"side_effect": [result, subprocess.CompletedProcess([], 0, stdout=json.dumps({
                "resource_changes": [{"mode": "managed", "type": "aws_ssm_parameter", "name": "app",
                    "index": "PRIVATE_INDEX", "address": "PRIVATE_ADDRESS", "change": {
                        "actions": ["update"], "before": {"value": "PRIVATE_BEFORE"},
                        "after": {"value": "PRIVATE_AFTER"}}}]
            }).encode(), stderr=b"PRIVATE_SHOW_ERROR")]})
        return self.inspect({"return_value": result})

    def test_no_changes_skips_approval_and_succeeds(self):
        code, output, summary, logs, call = self.completed(0)
        self.assertEqual(code, 0)
        self.assertEqual(output, "has_changes=false\n")
        self.assertIn("Approval and apply are skipped", summary)
        self.assertNotIn("PRIVATE", logs + summary)
        self.assertIn("-detailed-exitcode", call.args[0])
        self.assertIn("-lock-timeout=60s", call.args[0])
        self.assertNotIn("-lock=false", call.args[0])
        self.assertEqual(call.args[0][:2], ["terraform", "plan"])
        self.assertTrue(call.kwargs["capture_output"])

    def test_failed_inspection_blocks_approval_without_exposing_plan_or_diagnostics(self):
        for inspected in [subprocess.CompletedProcess([], 1, b"PRIVATE_OUTPUT", b"PRIVATE_ERROR"),
                          subprocess.CompletedProcess([], 0, b"PRIVATE_INVALID_JSON", b"")]:
            code, output, summary, logs, _ = self.inspect({"side_effect": [subprocess.CompletedProcess([], 2), inspected]})
            self.assertEqual(code, 1)
            self.assertEqual(output + summary, "")
            self.assertNotIn("PRIVATE", logs)

    def test_metadata_groups_instances_and_omits_addresses_output_names_and_nested_keys(self):
        row = {"mode": "managed", "type": "aws_lambda_function", "name": "group",
               "index": "PRIVATE_INDEX", "address": "PRIVATE_ADDRESS", "change": {
                   "actions": ["delete", "create"], "before": {"environment": {"PRIVATE_KEY": "PRIVATE_VALUE"}},
                   "after": {}, "after_unknown": {"id": True, "environment": {"PRIVATE_NESTED": True}}}}
        plan = {"resource_changes": [row, row], "output_changes": {"PRIVATE_OUTPUT": {"actions": ["update"], "after": "PRIVATE_VALUE"}}}
        summary = terraform_preflight.review_metadata(plan)
        self.assertIn("aws_lambda_function.group | 2 | delete, create | environment, id", summary)
        self.assertIn("Changed outputs: 1", summary)
        self.assertNotIn("PRIVATE", summary)

    def test_private_plan_is_removed_after_success_and_inspection_failure(self):
        success = self.completed(2)
        failure = self.inspect({"side_effect": [subprocess.CompletedProcess([], 2), subprocess.CompletedProcess([], 1)]})
        for result in (success, failure):
            call = result[-1]
            self.assertEqual(call.args[0][:2], ["terraform", "show"])
            self.assertFalse(Path(call.args[0][-1]).parent.exists())

    def test_changes_use_the_existing_policy(self):
        code, output, summary, logs, _ = self.completed(2)
        self.assertEqual(code, 0)
        self.assertEqual(output, "has_changes=true\n")
        self.assertIn("existing approval", summary)
        self.assertNotIn("PRIVATE", logs + summary)
        self.assertIn("aws_ssm_parameter.app | 1 | update | value", summary)

    def test_failures_never_grant_approval_or_claim_no_changes(self):
        for exit_code in (1, 3, -15):
            with self.subTest(exit_code=exit_code):
                code, output, summary, logs, _ = self.completed(exit_code)
                self.assertEqual(code, 1)
                self.assertEqual(output + summary, "")
                self.assertIn("blocked", logs)
                self.assertNotIn("PRIVATE", logs)

    def test_process_failure_is_not_an_empty_plan(self):
        code, output, summary, logs, _ = self.inspect({"side_effect": OSError("PRIVATE_PATH")})
        self.assertEqual(code, 1)
        self.assertEqual(output + summary, "")
        self.assertNotIn("PRIVATE", logs)


class ApprovalWorkflowTests(unittest.TestCase):
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/terraform-apply.yml").read_text()

    def job(self, name):
        return re.search(r"^  " + re.escape(name) + r":\n(.*?)(?=^  [\w-]+:|\Z)",
                         self.workflow, re.M | re.S).group(1)

    def eligible(self, name, changes="true", result="success", automatic="false", current="true"):
        expression = re.search(r"^    if: >-\n((?:      .+\n)+)", self.job(name), re.M).group(1)
        values = {"needs.scope.outputs.current": current,
                  "needs.scope.outputs.automatic": automatic,
                  "needs.preflight.result": result,
                  "needs.preflight.outputs.has_changes": changes}
        for key, value in values.items():
            expression = expression.replace(key, repr(value))
        return eval(" ".join(expression.split()).replace("&&", " and "), {"__builtins__": {}}, {})

    def test_no_change_never_creates_either_deployment(self):
        for automatic in ("true", "false"):
            for changes in ("false", "", "unknown"):
                for job in ("terraform-apply", "terraform-dependency-apply"):
                    self.assertFalse(self.eligible(job, changes=changes, automatic=automatic))

    def test_failed_or_cancelled_plan_blocks_both_paths_even_with_stale_true_output(self):
        for result in ("failure", "cancelled", "skipped"):
            for automatic in ("true", "false"):
                for job in ("terraform-apply", "terraform-dependency-apply"):
                    self.assertFalse(self.eligible(job, result=result, automatic=automatic))

    def test_real_changes_keep_the_approval_policy(self):
        self.assertTrue(self.eligible("terraform-apply"))
        self.assertFalse(self.eligible("terraform-dependency-apply"))
        self.assertFalse(self.eligible("terraform-apply", automatic="true"))
        self.assertTrue(self.eligible("terraform-dependency-apply", automatic="true"))
        self.assertIn("environment: production-infra", self.job("terraform-apply"))
        self.assertNotIn("environment:", self.job("terraform-dependency-apply"))

    def test_superseded_revision_never_applies(self):
        for job in ("terraform-apply", "terraform-dependency-apply"):
            for automatic in ("true", "false"):
                self.assertFalse(self.eligible(job, current="false", automatic=automatic))

    def test_preflight_is_read_only_and_runs_before_both_apply_jobs(self):
        preflight = self.job("preflight")
        self.assertNotIn("environment:", preflight)
        self.assertNotIn("AWS_GITHUB_ACTIONS_DEPLOY_ROLE_ARN", preflight)
        self.assertNotIn("terraform apply", preflight)
        self.assertIn("AWS_GITHUB_ACTIONS_PLAN_ROLE_ARN", preflight)
        self.assertIn("-lockfile=readonly", preflight)
        self.assertIn("ref: ${{ github.sha }}", preflight)
        for job in ("terraform-apply", "terraform-dependency-apply"):
            self.assertIn("needs: [scope, preflight]", self.job(job))
