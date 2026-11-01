"""Check the produced operator archive against file reads in its real entrypoints."""
import importlib.util
import posixpath
import re
import tempfile
import unittest
import zipfile
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
                self.assertFalse(any(".env" in Path(name).parts or name.startswith(".git/") for name in names))
                for script in ["backup-restore.mjs", "production-smoke.mjs", "provision-public-demo.mjs"]:
                    source = archive.read(".github/scripts/" + script).decode()
                    for relative in re.findall(r"new URL\('([^']+)', import\.meta\.url\)", source):
                        if relative.startswith("../operations-tools/"):
                            self.assertIn(posixpath.normpath(".github/scripts/" + relative), names,
                                          "Runtime asset referenced by " + script + " is absent")
                image = archive.read(".github/operations-tools/Dockerfile").decode().strip()
                self.assertRegex(image, r"^FROM pgvector/pgvector:pg17@sha256:[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
