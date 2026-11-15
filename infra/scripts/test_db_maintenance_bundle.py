"""Check the produced operator archive against file reads in its real entrypoints."""
import ast
import fnmatch
import importlib.util
import posixpath
import re
import tempfile
import unittest
import zipfile
import subprocess
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).resolve().parents[1] / "db-maintenance/build_bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTest(unittest.TestCase):
    def test_entrypoint_assets_exist_in_the_actual_zip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "operator.zip"
            bundle.archive(path, bundle.operator_files())
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
                self.assertIn('infra/db-maintenance/runtime/setup-job.cjs', names)
                self.assertIn('infra/db-maintenance/runtime/backup.cjs', names)
                self.assertIn('.github/scripts/backup-archive.mjs', names)
                self.assertIn('.github/scripts/backup-download.mjs', names)
                self.assertIn('.github/scripts/backup-d1-export.mts', names)
                self.assertIn('apps/api/scripts/migrations/d1/export.ts', names)
                self.assertIn('apps/api/scripts/migrations/d1/verify-archive.ts', names)
                self.assertIn('apps/api/src/persistence/postgres/read-snapshot.ts', names)
                self.assertEqual(json.loads(archive.read('package.json'))['type'], 'module')
                self.assertNotIn('apps/api/src/index.ts', names)
                self.assertNotIn('apps/api/package.json', names)
                for dialect in ['drizzle', 'drizzle-d1']:
                    journal = json.loads(archive.read(f'apps/api/{dialect}/meta/_journal.json'))
                    self.assertIn(f'apps/api/{dialect}/meta/{journal["entries"][-1]["idx"]:04d}_snapshot.json', names)
                self.assertFalse(any(".env" in Path(name).parts or name.startswith(".git/") for name in names))
                for script in ["backup-restore.mjs", "production-smoke.mjs", "provision-public-demo.mjs"]:
                    source = archive.read(".github/scripts/" + script).decode()
                    for relative in re.findall(r"new URL\('([^']+)', import\.meta\.url\)", source):
                        if relative.startswith("../operations-tools/"):
                            self.assertIn(posixpath.normpath(".github/scripts/" + relative), names,
                                          "Runtime asset referenced by " + script + " is absent")
                image = archive.read(".github/operations-tools/Dockerfile").decode().strip()
                self.assertRegex(image, r"^FROM pgvector/pgvector:pg17@sha256:[a-f0-9]{64}$")

    def test_every_operator_input_triggers_its_runtime_fixture_ci(self):
        workflow = (bundle.ROOT / '.github/workflows/ci.yml').read_text()
        match = re.search(r"(?m)^            operations:\n((?:              .*\n)*)", workflow)
        self.assertIsNotNone(match)
        patterns = [ast.literal_eval(line.strip()[2:]) for line in match.group(1).splitlines()
                    if line.strip().startswith('- ')]
        missing = [source.relative_to(bundle.ROOT).as_posix() for source, _ in bundle.operator_files()
                   if source.suffix != '.md' and not any(fnmatch.fnmatchcase(source.relative_to(bundle.ROOT).as_posix(), pattern)
                                                        for pattern in patterns)]
        self.assertEqual(missing, [], 'An operator input can change without running its isolated runtime fixture')

    def test_every_runtime_operator_input_triggers_canonical_maintenance_deployment(self):
        inputs = [source.relative_to(bundle.ROOT).as_posix() for source, _ in bundle.operator_files()
                  if source.suffix != '.md']
        result = subprocess.check_output(['node', '-e',
            "const {relevant}=require('./.github/scripts/db-maintenance-cd.cjs'); console.log(JSON.stringify(JSON.parse(process.argv[1]).filter(path=>!relevant(path))))",
            json.dumps(inputs)], cwd=bundle.ROOT, text=True)
        self.assertEqual(json.loads(result), [], 'An artifact source can change without triggering its reviewed deployment')


if __name__ == "__main__":
    unittest.main()
