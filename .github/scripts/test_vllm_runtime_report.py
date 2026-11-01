import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('runtime', Path(__file__).parents[2] / 'apps/inference/vllm/check_runtime.py')
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeReportTests(unittest.TestCase):
    def test_upstream_stdout_diagnostics_do_not_corrupt_json(self):
        def noisy_check():
            print('Upstream import: no active GPU driver')
            return {'gateway_wav_decoding': 'passed'}
        output, diagnostics = io.StringIO(), io.StringIO()
        with patch.object(runtime, 'check', side_effect=noisy_check), patch('sys.stdout', output), patch('sys.stderr', diagnostics):
            runtime.emit_result()
        self.assertEqual(json.loads(output.getvalue()), {'gateway_wav_decoding': 'passed'})
        self.assertIn('no active GPU driver', diagnostics.getvalue())

    def test_failed_decoding_does_not_emit_a_success_report(self):
        output = io.StringIO()
        with patch.object(runtime, 'check', side_effect=RuntimeError('bad WAV')), patch('sys.stdout', output), self.assertRaises(RuntimeError):
            runtime.emit_result()
        self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
