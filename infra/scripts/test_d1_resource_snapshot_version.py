import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from d1_resource_files import PrivateSqlFiles
from d1_resource_snapshot_version import inspect_versioned
from d1_resource_fence_control import SOURCE


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        os.chmod(self.directory.name,0o700);self.files=PrivateSqlFiles(self.directory.name)
        self.context={'run':'a'*32,'source':'b'*40,'planSha256':'c'*64}
        self.version='bookmark-1';self.guards=0
        class Query:
            def bookmark(inner,_database):return self.version
        self.query=Query()
        self.path=Path(self.directory.name)/('verified-version-'+SOURCE+'.json')
    def fence(self):self.guards+=1
    def inspect(self):return inspect_versioned(self.query,SOURCE,self.fence,self.files,self.context)

    def test_same_provider_state_reuses_exact_snapshot_with_fresh_guards(self):
        snapshot={'schemaSha256':'d'*64,'tables':[{'table':'t','rows':42,'valuesSha256':'e'*64}]}
        with patch('d1_resource_snapshot_version.inspect_database',return_value=snapshot) as full:
            self.assertEqual(self.inspect(),snapshot);before=self.guards
            self.assertEqual(self.inspect(),snapshot)
            self.assertEqual(full.call_count,1);self.assertGreater(self.guards,before)

    def test_changed_version_runs_full_comparison_again(self):
        with patch('d1_resource_snapshot_version.inspect_database',side_effect=[{'rows':1},{'rows':2}]) as full:
            self.assertEqual(self.inspect(),{'rows':1});self.version='bookmark-2'
            self.assertEqual(self.inspect(),{'rows':2});self.assertEqual(full.call_count,2)

    def test_version_changed_during_scan_cannot_create_cache(self):
        def changed(*args):self.version='bookmark-2';return {'rows':1}
        with patch('d1_resource_snapshot_version.inspect_database',side_effect=changed):self.inspect()
        self.assertFalse(self.path.exists())

    def test_corrupt_public_symlink_and_other_context_are_rejected(self):
        for mode in ['corrupt','public','symlink','context']:
            with self.subTest(mode=mode):
                if self.path.exists() or self.path.is_symlink():self.path.unlink()
                with patch('d1_resource_snapshot_version.inspect_database',return_value={'rows':1}):self.inspect()
                if mode=='corrupt':
                    value=json.loads(self.path.read_text());value['snapshot']['rows']=2;self.path.write_text(json.dumps(value))
                elif mode=='public':self.path.chmod(0o644)
                elif mode=='symlink':
                    target=self.path.with_suffix('.target');self.path.rename(target);self.path.symlink_to(target)
                else:
                    value=json.loads(self.path.read_text());value['context']['run']='f'*32;self.path.write_text(json.dumps(value))
                with self.assertRaises((ValueError,OSError)):self.inspect()

if __name__=='__main__':unittest.main()
