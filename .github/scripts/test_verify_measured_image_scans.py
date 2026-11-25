import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('binding',Path(__file__).with_name('verify-measured-image-scans.py'))
binding=importlib.util.module_from_spec(spec);spec.loader.exec_module(binding)


class ImageBindingTest(unittest.TestCase):
    def test_rebuilt_retagged_or_different_scan_cannot_support_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            images=[{'Id':name,'RepoTags':[f'videoq-{name}:onprem-ci']} for name in ['api','worker','web']]
            (root/'smoke-image-ids.json').write_text(json.dumps(images))
            report={'source':'frozen','dockerfileVariant':'candidate','failedBuilds':0,'runs':[{'components':[{'component':name,'imageId':name} for name in ['api','worker','web']]}]}
            for name in ['api','worker','web']:(root/f'{name}-security.json.syft.json').write_text(json.dumps({'source':{'metadata':{'imageID':name}}}))
            self.assertEqual(len(binding.verify(report,root,images)['images']),3)
            (root/'api-security.json.syft.json').write_text(json.dumps({'source':{'metadata':{'imageID':'rebuild'}}}))
            with self.assertRaisesRegex(ValueError,'identity mismatch'):binding.verify(report,root,images)
            (root/'api-security.json.syft.json').write_text(json.dumps({'source':{'metadata':{'imageID':'api'}}}))
            with self.assertRaisesRegex(ValueError,'identity mismatch'):binding.verify(report,root,[{**image,'Id':'retag'} for image in images])
