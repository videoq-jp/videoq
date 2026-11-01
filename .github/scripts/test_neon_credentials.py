import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import io

spec = importlib.util.spec_from_file_location("neon", Path(__file__).with_name("with-neon-credentials.py"))
neon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(neon)


class CredentialsTest(unittest.TestCase):
    def test_database_jobs_use_oidc_before_fetch_without_static_url(self):
        root = Path(__file__).resolve().parents[2]
        for filename, jobs in [("cd.yml", ["db-migrate"]), ("operations.yml", ["smoke", "backup"]),
                               ("public-demo-setup.yml", ["setup"])]:
            text = (root / ".github/workflows" / filename).read_text()
            self.assertNotIn("secrets.DATABASE_URL", text)
            for name in jobs:
                job = re.search(rf"^  {name}:\n([\s\S]*?)(?=^  [\w-]+:|\Z)", text, re.M).group(1)
                if name == "setup":
                    self.assertIn("production-db-demo", job)
                    self.assertIn("production-db-audit", job)
                else:
                    self.assertIn("    environment: production-db-" + ("migration" if name == "db-migrate" else name) + "\n", job)
                self.assertRegex(job, r"    permissions:\n(?:      .+\n)*      id-token: write\n")
                if name == "setup":
                    auth = job.index("uses: ./.github/actions/neon-credentials")
                    command = job.index("with-neon-credentials.py")
                else:
                    auth = job.index("uses: ./.github/actions/aws-db-invocation")
                    command = job.index("run-aws-db.py")
                    self.assertIn("AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN", job)
                    self.assertNotIn("with-neon-credentials.py", job)
                    self.assertNotIn("setup-operations-tools", job)
                self.assertLess(auth, command)

    def response(self, value=None, kind="SecureString", code=0):
        return subprocess.CompletedProcess([], code, json.dumps({"Parameter": {
            "Type": kind, "Value": json.dumps({"DATABASE_URL": value})
        }}), "private error")

    def test_scoped_fetch_and_child_environment(self):
        url = "postgresql://videoq_migration_test:secret%21@db.example/db?sslmode=verify-full&options=-c%20role%3Dvideoq_migrate_20260918"
        with patch.object(neon.sys, "argv", ["wrapper", "migration", "command", "argument"]), patch.dict(
            os.environ, {"AWS_ACCESS_KEY_ID": "private", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "private", "GITHUB_ACTIONS": "true"}
        ), patch.object(neon.subprocess, "run", side_effect=[self.response(url),
                subprocess.CompletedProcess([], 7)]) as run, patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(neon.main(), 7)
            fetch, child = run.call_args_list
            self.assertIn("--with-decryption", fetch.args[0])
            self.assertIn("/videoq/security/prod/db-migration", fetch.args[0])
            self.assertEqual(child.args[0], ["command", "argument"])
            self.assertEqual(child.kwargs["env"]["DATABASE_URL"], url)
            self.assertNotIn("AWS_ACCESS_KEY_ID", child.kwargs["env"])
            self.assertNotIn("ACTIONS_ID_TOKEN_REQUEST_TOKEN", child.kwargs["env"])
            self.assertIn("::add-mask::secret!", out.getvalue())
            self.assertIn("::add-mask::secret%2521", out.getvalue())

    def test_invalid_or_failed_fetch_never_runs_command(self):
        for response in [self.response(code=1), self.response("postgres://u:p@host/db", "String"),
                         self.response(None), self.response("postgres://u:p@host/db\nINJECT=x"),
                         self.response("postgres://neondb_owner:p@host/db?sslmode=verify-full"),
                         self.response("postgres://videoq_migration_test:p@host/db?sslmode=verify-full")]:
            with self.subTest(response=response), patch.object(neon.sys, "argv", ["wrapper", "migration", "command"]), patch.object(
                neon.subprocess, "run", return_value=response
            ) as run, self.assertRaises(SystemExit):
                try:
                    neon.main()
                finally:
                    self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
