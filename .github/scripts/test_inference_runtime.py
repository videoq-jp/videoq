import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('runtime', ROOT / 'apps/inference/whisper/security/verify_inference_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class InferenceRuntimeTests(unittest.TestCase):
    def test_imports_the_backend_that_failed_on_the_real_gpu(self):
        loaded = []
        runtime.verify(runtime.EXPECTED.__getitem__, loaded.append)
        self.assertIn('vllm.model_executor.models.embedding_gemma2', loaded)
        self.assertIn('flashinfer', loaded)
        self.assertIn('vllm.v1.attention.backends.flashinfer', loaded)

    def test_old_base_kernels_are_rejected_before_serving(self):
        for package in ('flashinfer-cubin', 'flashinfer-jit-cache', 'flashinfer-jit-cache-sm89'):
            installed = dict(runtime.EXPECTED, **{package: '0.7.2.post1'})
            with self.subTest(package=package), self.assertRaisesRegex(RuntimeError, package):
                runtime.verify(installed.__getitem__, lambda _: None)

    def test_import_failure_is_not_hidden(self):
        def broken(name):
            if name == 'flashinfer':
                raise ImportError('incompatible kernel wheel')
        with self.assertRaisesRegex(ImportError, 'incompatible'):
            runtime.verify(runtime.EXPECTED.__getitem__, broken)


if __name__ == '__main__':
    unittest.main()
