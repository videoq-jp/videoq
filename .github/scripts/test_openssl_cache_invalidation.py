"""Failure cleanup regression: a failed actual build must never retain source edits."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('invalidation',Path(__file__).with_name('openssl-cache-invalidation.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class Restoration(unittest.TestCase):
    def test_failed_first_actual_probe_restores_source_and_retains_failure_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'apps/api/src/runtime/node.ts';source.parent.mkdir(parents=True);source.write_text('original source\n')
            previous=Path.cwd()
            try:
                os.chdir(root)
                def execute(command,**kwargs):
                    if command[:3]==['docker','buildx','build']:
                        self.assertIn('isolated compiler cache control',source.read_text())
                        return type('Result',(),{'returncode':1})()
                    return type('Result',(),{'returncode':0})()
                with patch.object(sys,'argv',['probe','--builder','owned','--output','receipt']),patch.object(module.subprocess,'check_output',return_value='original-id\n'),patch.object(module.subprocess,'run',side_effect=execute):
                    with self.assertRaisesRegex(ValueError,'Actual probe failed'):module.main()
                self.assertEqual(source.read_text(),'original source\n')
                self.assertEqual((root/'receipt/result.json').read_text(),'[]\n')
            finally:
                os.chdir(previous)
