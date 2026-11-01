import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parents[1] / "db-maintenance/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
SHA = "a" * 40


class FakeAWS:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail
        self.projects = {f"videoq-db-{p}-prod": {"name": f"videoq-db-{p}-prod", "sourceVersion": "old-object",
                         "source": {"type": "S3", "location": deploy.BUCKET + "/operator.zip"},
                         "serviceRole": f"arn:aws:iam::{deploy.ACCOUNT}:role/videoq-db-{p}-prod", "tags": []} for p in deploy.PURPOSES}
        self.aliases = {f"videoq-db-start-{p}-prod": "1" for p in deploy.STARTERS}
        self.definition = '{"old":true}'
        self.digest = base64.b64encode(hashlib.sha256(b"broker").digest()).decode()

    def __call__(self, service, command, **value):
        self.calls.append((service, command, value))
        if command == "validate-state-machine-definition": return {"result": "OK"}
        if command == "describe-state-machine": return {"definition": self.definition}
        if command == "batch-get-projects": return {"projects": [dict(self.projects[n]) for n in value["names"]]}
        if command == "get-alias": return {"FunctionVersion": self.aliases[value["FunctionName"]], "RevisionId": "old-revision"}
        if command == "put-object": return {"VersionId": "new-object"}
        if command == "update-function-code": return {"Version": "2", "CodeSha256": self.digest}
        if command == "get-function-configuration": return {"State": "Active"}
        if command == "invoke":
            if self.fail == "canary": return {"status": "RUNNING"}
            payload = json.loads(base64.b64decode(value["Payload"]))
            return {"status": "REJECTED", "reason": "UNEXPECTED_INPUT" if "buildspecOverride" in payload else "OPERATION_NOT_ALLOWED"}
        if command == "update-project":
            self.projects[value["name"]]["sourceVersion"] = value["sourceVersion"]
        elif command == "update-state-machine": self.definition = value["definition"]
        elif command == "update-alias":
            self.aliases[value["FunctionName"]] = value["FunctionVersion"]
            if self.fail == "external_alias_change":
                self.fail = None
                self.aliases[value["FunctionName"]] = "99"
                raise RuntimeError("operator changed the alias concurrently")
            if self.fail == "lost_alias_response":
                self.fail = None
                raise RuntimeError("response lost after mutation")
        else: raise AssertionError(command)
        return {}


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        for name in ["operator", "broker"]: (self.path / (name + ".zip")).write_bytes(name.encode())
        manifest = {"source_commit": SHA, "dirty": False, "state_machine_sha256": hashlib.sha256(b'{"new":true}').hexdigest(),
                    **{name + "_sha256": hashlib.sha256(name.encode()).hexdigest() for name in ["operator", "broker"]}}
        (self.path / "manifest.json").write_text(json.dumps(manifest))
        (self.path / "state-machine.json").write_text('{"new":true}')

    def test_streaming_invoke_sends_exact_bytes_without_cli_input_json(self):
        event = {"action": "start", "kind": "invalid"}
        def execute(args, **options):
            self.assertNotIn("--cli-input-json", args)
            self.assertEqual(args[args.index("--function-name") + 1], "fixed-function")
            path = args[args.index("--payload") + 1]
            self.assertTrue(path.startswith("fileb://"))
            self.assertEqual(json.loads(Path(path[8:]).read_bytes()), event)
            Path(args[-1]).write_text('{"status":"REJECTED","reason":"OPERATION_NOT_ALLOWED"}')
            return subprocess.CompletedProcess(args, 0, '{"StatusCode":200}', '')
        with patch.object(deploy.subprocess, "run", side_effect=execute):
            result = deploy.aws("lambda", "invoke", FunctionName="fixed-function", Qualifier="2",
                                Payload=base64.b64encode(json.dumps(event).encode()).decode())
        self.assertEqual(result["reason"], "OPERATION_NOT_ALLOWED")

    def test_unreviewed_or_tampered_bundles_never_reach_aws(self):
        api = FakeAWS()
        with self.assertRaisesRegex(RuntimeError, "UNREVIEWED"):
            deploy.promote(self.path, "b" * 40, api)
        (self.path / "broker.zip").write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "HASH_MISMATCH"):
            deploy.promote(self.path, SHA, api)
        self.assertEqual(api.calls, [])

    def test_canary_failure_never_changes_live_references(self):
        api = FakeAWS("canary")
        with self.assertRaisesRegex(RuntimeError, "CANARY_FAILED"):
            deploy.promote(self.path, SHA, api)
        self.assertTrue(all(v == "1" for v in api.aliases.values()))
        self.assertTrue(all(v["sourceVersion"] == "old-object" for v in api.projects.values()))
        self.assertNotIn("update-state-machine", [c[1] for c in api.calls])

    def test_lost_response_after_a_live_mutation_restores_previous_references(self):
        api = FakeAWS("lost_alias_response")
        with self.assertRaisesRegex(RuntimeError, "DEPLOYMENT_REVERTED"):
            deploy.promote(self.path, SHA, api)
        self.assertTrue(all(v == "1" for v in api.aliases.values()))
        self.assertTrue(all(v["sourceVersion"] == "old-object" for v in api.projects.values()))
        self.assertEqual(json.loads(api.definition), {"old": True})

    def test_all_candidates_are_tested_before_live_promotion_and_sources_are_versioned(self):
        api = FakeAWS()
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            deploy.promote(self.path, SHA, api)
        self.assertTrue(all(v == "2" for v in api.aliases.values()))
        self.assertTrue(all(v["sourceVersion"] == "new-object" for v in api.projects.values()))
        commands = [c[1] for c in api.calls]
        self.assertLess(max(i for i, c in enumerate(commands) if c == "invoke"), commands.index("update-project"))
        self.assertEqual(json.loads(output.getvalue())["source_commit"], SHA)
        self.assertFalse(any(service in ["ssm", "iam"] for service, _, _ in api.calls))

    def test_rollback_does_not_overwrite_an_external_alias_change(self):
        api = FakeAWS("external_alias_change")
        with self.assertRaisesRegex(RuntimeError, "DEPLOYMENT_ROLLBACK_INCOMPLETE"):
            deploy.promote(self.path, SHA, api)
        self.assertEqual(list(api.aliases.values()).count("99"), 1)
        self.assertTrue(all(v["sourceVersion"] == "old-object" for v in api.projects.values()))


if __name__ == "__main__": unittest.main()
