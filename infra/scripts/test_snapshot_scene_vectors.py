import copy
import json
from pathlib import Path
import tempfile
import unittest
from snapshot_scene_vectors import CloudflareReadOnly, inventory, snapshot, snapshot_index


class SnapshotTests(unittest.TestCase):
    def call(self, mutate=None):
        infos = 0
        def api(method, path, payload=None):
            nonlocal infos
            dimension = 1536 if '1536' in path else 768
            if path.endswith('/info'):
                infos += 1
                return {'dimensions': dimension, 'vectorCount': 2 if dimension == 1536 else 0,
                        'processedUpToMutation': 'changed' if mutate == 'mutation' and infos > 1 else 'fixed'}
            if '/list?' in path:
                rows = [{'id': 'a'}, {'id': 'b'}] if dimension == 1536 else []
                return {'vectors': rows, 'count': len(rows), 'totalCount': len(rows), 'isTruncated': False}
            if path.endswith('/get_by_ids'):
                rows = [{'id': i, 'values': [0.5] * dimension,
                         'metadata': {'user_id': 'owner', 'custom': {'key': True}}, 'namespace': 'ns'}
                        for i in reversed(payload['ids'])]
                if mutate == 'missing':
                    rows.pop()
                elif mutate == 'duplicate':
                    rows[-1] = copy.deepcopy(rows[0])
                elif mutate == 'default-namespace':
                    rows[0]['namespace'] = None
                elif mutate == 'nan':
                    rows[0]['values'][0] = float('nan')
                return rows
            raise AssertionError(path)
        return api

    def test_preserves_values_metadata_namespace_and_orders_ids(self):
        rows, proof = snapshot_index(self.call(), 1536)
        self.assertEqual([r['id'] for r in rows], ['a', 'b'])
        self.assertEqual(rows[0]['metadata']['custom'], {'key': True})
        self.assertEqual(rows[0]['namespace'], 'ns')
        self.assertFalse(proof['writerFenceProven'])

    def test_default_namespace_null_is_omitted_for_upsert(self):
        rows, _ = snapshot_index(self.call('default-namespace'), 1536)
        self.assertNotIn('namespace', rows[1])

    def test_refuses_partial_duplicate_invalid_or_changed_source(self):
        for mutation in ['missing', 'duplicate', 'nan', 'mutation']:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                snapshot_index(self.call(mutation), 1536)

    def test_pagination_refuses_missing_or_repeated_cursor(self):
        for cursor in [None, 'same']:
            def api(*args):
                return {'vectors': [{'id': 'a'}], 'count': 1, 'totalCount': 2,
                        'isTruncated': True, 'nextCursor': cursor}
            with self.subTest(cursor=cursor), self.assertRaises(ValueError):
                inventory(api, 'base')

    def test_private_output_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            proof = snapshot(self.call(), root)
            self.assertEqual([p['count'] for p in proof['indexes']], [2, 0])
            for path in root.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            row = json.loads((root / 'vectors-1536.private.ndjson').read_text().splitlines()[0])
            self.assertEqual(row['id'], 'a')
            with self.assertRaises(ValueError):
                snapshot(self.call(), root)

    def test_transport_refuses_all_mutating_endpoints(self):
        api = CloudflareReadOnly('test-token')
        prefix = 'accounts/12daec56fdba43f677f2766ee26a5a39/vectorize/v2/indexes/videoq-scenes-migration-v3-1536/'
        for method, path in [('POST', prefix+'upsert'), ('DELETE', prefix), ('GET', 'accounts/other')]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                api(method, path)


if __name__ == '__main__':
    unittest.main()
