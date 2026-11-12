import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
import native_backup as module
from native_backup import inspect_archive
from lifecycle import BACKENDS, DATA_PVCS, WRITERS


class NativeBackupTests(unittest.TestCase):
    def archive(self, directory, extra=None, omitted=None):
        path = Path(directory) / 'snapshot.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for root in DATA_PVCS:
                if root == omitted:
                    continue
                entry = tarfile.TarInfo('./' + root)
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
                entry = tarfile.TarInfo('./' + root + '/data')
                entry.size = 4
                archive.addfile(entry, io.BytesIO(b'data'))
            if extra is not None:
                archive.addfile(extra)
        return path

    def test_cluster_mismatch_or_live_writers_stop_before_creating_a_restore_pod(self):
        with tempfile.TemporaryDirectory() as folder:
            self.archive(folder).rename(Path(folder) / 'volumes.tar.gz')
            instance = Mock()
            instance.check_cluster_identity.side_effect = ValueError('wrong cluster')
            with patch.object(module, 'verify_backup', return_value={}):
                with self.assertRaisesRegex(ValueError, 'wrong cluster'):
                    module.restore_cold_data(instance, folder)
            instance.kube.assert_not_called()
            instance.apply.assert_not_called()
            instance.check_cluster_identity.side_effect = None
            deployments = [{'metadata': {'name': name}, 'spec': {'replicas': 1,
                            'selector': {'matchLabels': {'app': name}}}} for name in WRITERS + BACKENDS]
            instance.kube.return_value = json.dumps({'items': deployments})
            with patch.object(module, 'verify_backup', return_value={}):
                with self.assertRaisesRegex(ValueError, 'must be stopped'):
                    module.restore_cold_data(instance, folder)
            instance.apply.assert_not_called()

    def test_terminating_writer_pods_also_prevent_any_data_deletion(self):
        with tempfile.TemporaryDirectory() as folder:
            self.archive(folder).rename(Path(folder) / 'volumes.tar.gz')
            instance = Mock()
            deployments = [{'metadata': {'name': name}, 'spec': {'replicas': 0,
                            'selector': {'matchLabels': {'app': name}}}} for name in WRITERS + BACKENDS]
            instance.kube.side_effect = [json.dumps({'items': deployments}),
                                        json.dumps({'items': [{'metadata': {'deletionTimestamp': 'now'}}]})]
            with patch.object(module, 'verify_backup', return_value={}):
                with self.assertRaisesRegex(ValueError, 'still present'):
                    module.restore_cold_data(instance, folder)
            instance.apply.assert_not_called()

    def test_recreated_claims_with_the_same_names_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            self.archive(folder).rename(Path(folder) / 'volumes.tar.gz')
            instance = Mock()
            deployments = [{'metadata': {'name': name}, 'spec': {'replicas': 0,
                            'selector': {'matchLabels': {'app': name}}}} for name in WRITERS + BACKENDS]
            claims = [{'metadata': {'name': name, 'uid': 'new-'+name}, 'status': {'phase': 'Bound'}} for name in DATA_PVCS]
            instance.kube.side_effect = ([json.dumps({'items': deployments})]
                + [json.dumps({'items': []})] * len(deployments) + [json.dumps({'items': claims})])
            manifest = {'pvcUids': {name: 'original-'+name for name in DATA_PVCS}}
            with patch.object(module, 'verify_backup', return_value=manifest):
                with self.assertRaisesRegex(ValueError, 'PVC identities differ'):
                    module.restore_cold_data(instance, folder)
            instance.apply.assert_not_called()

    def test_real_archive_is_scanned_without_extracting_its_contents(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.archive(folder)
            self.assertEqual(inspect_archive(path), 16)
            self.assertEqual(list(Path(folder).iterdir()), [path])

    def test_links_special_files_and_escape_paths_are_rejected(self):
        for name, kind in (('../escape', tarfile.DIRTYPE), ('/etc', tarfile.DIRTYPE),
                           ('other-data', tarfile.DIRTYPE), ('postgres-data/link', tarfile.SYMTYPE),
                           ('garage-data/link', tarfile.LNKTYPE), ('queue-data/device', tarfile.CHRTYPE)):
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as folder:
                extra = tarfile.TarInfo(name)
                extra.type = kind
                extra.linkname = '/outside'
                with self.assertRaises(ValueError):
                    inspect_archive(self.archive(folder, extra=extra))

    def test_partial_volume_sets_are_never_restored(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'four data volumes'):
                inspect_archive(self.archive(folder, omitted=DATA_PVCS[0]))


if __name__ == '__main__':
    unittest.main()
