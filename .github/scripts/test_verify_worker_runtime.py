import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verify_worker_runtime', pathlib.Path(__file__).with_name('verify-worker-runtime.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeProof(unittest.TestCase):
    def test_requires_all_fips_checks_and_source_identity(self):
        expected = {'guard.py': 'a' * 64}
        valid = {'python': [3, 14, 10], 'fipsMode': 0, 'sources': expected, 'fipsRefusalChecks': ['guard', 'import', 'invocation']}
        self.assertEqual(module.validate(valid, expected), valid)
        for change in [{'sources': {}}, {'python': None}, {'fipsMode': 1}, {'fipsRefusalChecks': ['guard']}, {'fipsRefusalChecks': []}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.validate({**valid, **change}, expected)

    def test_refuses_mutable_or_option_like_image_before_docker(self):
        for image in ['registry/worker:latest', '--privileged', 'registry/worker@sha256:short']:
            with patch.object(module.subprocess, 'run') as run, self.assertRaises(ValueError):
                module.verify(image)
            run.assert_not_called()
