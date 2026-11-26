import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('lab',Path(__file__).with_name('onprem-lab.py'))
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)

class Identity(unittest.TestCase):
    def test_synthetic_source_and_exact_served_weights_are_distinct_explicit_identities(self):
        expected='sha256:'+hashlib.sha256((lab.ROOT/'.github/onprem-lab/inference.mjs').read_bytes()).hexdigest()
        self.assertEqual(lab.lab_values()['ai']['embeddingRevision'],expected)
        defaults={'servers':{'embedding':{'modelRevision':'a'*40,'modelSha256':'b'*64,'servedModel':'actual-alias'}}}
        identity=lab.locked_embedding_identity(defaults)
        self.assertEqual(identity,{'embeddingModel':'actual-alias','embeddingRevision':'a'*40+':sha256:'+'b'*64,'embeddingPreprocessing':'raw-text-v1'})
        for field in ['modelRevision','modelSha256']:
            changed=copy.deepcopy(defaults);changed['servers']['embedding'][field]='c'*len(changed['servers']['embedding'][field])
            self.assertNotEqual(identity,lab.locked_embedding_identity(changed))
            changed['servers']['embedding'][field]='mutable-alias'
            with self.assertRaises(ValueError):lab.locked_embedding_identity(changed)

    def test_changed_served_alias_is_forwarded_and_missing_alias_rejected(self):
        defaults={'servers':{'embedding':{'modelRevision':'a'*40,'modelSha256':'b'*64,'servedModel':'custom-served-alias'}}}
        self.assertEqual(lab.real_model_values(defaults)['ai']['embeddingModel'],'custom-served-alias')
        del defaults['servers']['embedding']['servedModel']
        with self.assertRaises(ValueError):lab.locked_embedding_identity(defaults)
