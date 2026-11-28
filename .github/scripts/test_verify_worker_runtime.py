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

    def test_probe_checks_source_identity_even_with_python_optimization(self):
        import hashlib
        import json
        import os
        import subprocess
        import sys
        # Simulated native files/imports keep this protocol test independent of
        # private production images. The separate actual-image probe covers FIPS.
        prefix = '''
import sys,json,hashlib,pathlib,subprocess,platform,_hashlib,types
platform.machine=lambda:'aarch64'
sys.version_info=(3,14,11)
original=pathlib.Path.read_bytes
pathlib.Path.read_bytes=lambda p:b'reviewed source' if str(p).startswith('/var/task/') else original(p)
package=types.ModuleType('worker_python')
for name in ['runtime_security','lambda_handler']:
 module=types.ModuleType(name);module.__file__='/var/task/worker_python/'+name+'.py'
 setattr(package,name,module)
package.runtime_security.verify_hashlib_runtime=lambda:None
sys.modules['worker_python']=package
'''
        digest = hashlib.sha256(b'reviewed source').hexdigest()
        for optimize in ['0', '1']:
            for valid in [True, False]:
                expected = {name: digest if valid else '0' * 64 for name in module.FILES}
                with self.subTest(optimize=optimize, valid=valid):
                    result = subprocess.run([sys.executable, '-c', prefix + module.PROBE, json.dumps(expected)],
                        env={**os.environ, 'PYTHONOPTIMIZE': optimize}, capture_output=True, text=True, timeout=30)
                    if valid:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(json.loads(result.stdout)['sources'], expected)
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('Runtime source differs', result.stderr)
