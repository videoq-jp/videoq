import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify_runtime', Path(__file__).parents[1] / 'verify_runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InventoryTest(unittest.TestCase):
    def test_runtime_inventory(self):
        module.validate_inventory(['app/build/bin/whisper-server', 'usr/lib/libstdc++.so.6'], ['glibc', 'libstdc++', 'libgomp'])
        for path in ['usr/include/stdio.h', 'usr/bin/gcc', 'app/models/ggml.bin', '../escape', 'usr/lib/libfoo.a', 'bin/sh']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                module.validate_inventory([path], ['glibc'])
        for package in ['linux-libc-dev', 'libsdl2-dev', 'cmake', 'git', 'apk-tools', 'busybox']:
            with self.subTest(package=package), self.assertRaises(ValueError):
                module.validate_inventory([], [package])
        with self.assertRaises(ValueError):
            module.validate_inventory([], [])

    def test_generated_native_probe_is_valid_python(self):
        compile(module.HEALTH_PROBE, '<native-health-inference-probe>', 'exec')

    def test_package_database(self):
        self.assertEqual(module.package_names('P:glibc\nV:1\n\nP:libgomp\nV:2\n'), ['glibc', 'libgomp'])

if __name__ == '__main__':
    unittest.main()
