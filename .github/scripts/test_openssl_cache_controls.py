import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('cache',Path(__file__).with_name('check-openssl-cache.py'))
cache=importlib.util.module_from_spec(spec);spec.loader.exec_module(cache)


class CacheControls(unittest.TestCase):
    def test_real_compiler_vertex_required_and_failed_or_ambiguous_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'build.log'
            prefix='#7 [openssl-security 4/4] RUN abuild-keygen -a -n && MAKEFLAGS=-j4 abuild -F -d -r\n'
            for suffix,expected in [('#7 CACHED\n',False),('#7 DONE 785.9s\n',True)]:
                path.write_text(prefix+suffix);self.assertEqual(cache.compiled(path),expected)
            for text in ['#1 CACHED\n',prefix+'#7 ERROR checksum failed\n',prefix+prefix.replace('#7','#8')+'#7 DONE 1s\n']:
                path.write_text(text)
                with self.assertRaises(ValueError):cache.compiled(path)
