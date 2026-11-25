import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('measured', Path(__file__).with_name('build-onprem-measured.py'))
measured = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measured)


class ResourceProtocolTest(unittest.TestCase):
    def test_effective_limits_required_before_comparison(self):
        valid = {'State': {'Running': True}, 'HostConfig': {
            'CpuPeriod': 100000, 'CpuQuota': 400000,
            'Memory': 8 * 1024**3, 'MemorySwap': 8 * 1024**3, 'CpusetCpus': ''}}
        with patch.object(measured.subprocess, 'check_output', return_value=json.dumps([valid])):
            self.assertTrue(measured.inspect_builder_limits('owned-builder', 4, 8 * 1024**3)['verifiedBeforeBuild'])
        for field, value in [('CpuPeriod', 0), ('CpuQuota', 200000), ('Memory', 16 * 1024**3), ('MemorySwap', -1)]:
            with self.subTest(field=field):
                info = copy.deepcopy(valid); info['HostConfig'][field] = value
                with patch.object(measured.subprocess, 'check_output', return_value=json.dumps([info])):
                    with self.assertRaises(ValueError):
                        measured.inspect_builder_limits('owned-builder', 4, 8 * 1024**3)
        info = copy.deepcopy(valid); info['State']['Running'] = False
        with patch.object(measured.subprocess, 'check_output', return_value=json.dumps([info])):
            with self.assertRaises(ValueError):
                measured.inspect_builder_limits('owned-builder', 4, 8 * 1024**3)
