import json
import sqlite3
import unittest
from d1_resource_vector_plan import read_authority


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE scenes(id,vector_id,revision,video_id,dimensions);
CREATE TABLE videos(id,user_id);
CREATE TABLE scene_staging(run_id,scene_id,vector_id);
CREATE TABLE scene_index_runs(id,video_id,user_id,dimensions,source_revision,status);
CREATE TABLE video_index_versions(video_id,revision);
CREATE TABLE video_index_heads(video_id,dimensions,run_id);
CREATE TABLE scene_index_tasks(operation,completed_at,accepted_at,vector_id,scene_id,revision,video_id,user_id,dimensions,embedding);
INSERT INTO videos VALUES(1,'owner');INSERT INTO scenes VALUES('scene','vector','revision',1,768);
INSERT INTO video_index_versions VALUES(1,'source-1');
INSERT INTO scene_index_runs VALUES('run-1',1,'owner',768,'source-1','staging');
INSERT INTO video_index_heads VALUES(1,768,'run-1');
INSERT INTO scene_staging VALUES('run-1','staged','staged-vector');''')

    def query(self, sql):
        result = self.db.execute(sql)
        return [dict(zip([c[0] for c in result.description], row)) for row in result]

    def test_current_scenes_and_only_current_staging_are_authoritative(self):
        rows = read_authority(self.query, lambda: None)
        self.assertEqual({row['vector_id'] for row in rows}, {'vector', 'staged-vector'})
        self.db.execute("UPDATE video_index_versions SET revision='changed'")
        self.assertEqual([row['vector_id'] for row in read_authority(self.query, lambda: None)], ['vector'])

    def test_pending_payload_must_be_usable_unaccepted_and_exactly_scoped(self):
        self.db.execute('INSERT INTO scene_index_tasks VALUES(?,NULL,NULL,?,?,?,?,?,?,?)',
                        ('upsert','vector','scene','revision',1,'owner',768,json.dumps([0.5]*768)))
        def pending():
            return next(row['pending_payload'] for row in read_authority(self.query, lambda: None) if row['vector_id']=='vector')
        self.assertTrue(pending())
        for embedding in ['invalid', json.dumps([0]*768), json.dumps([1]*767), json.dumps(['text']*768), json.dumps([1e-50]*768), '['+','.join(['1e400']*768)+']' ]:
            self.db.execute('UPDATE scene_index_tasks SET embedding=?',(embedding,))
            self.assertFalse(pending())
        self.db.execute('UPDATE scene_index_tasks SET embedding=?,accepted_at=?',(json.dumps([0.5]*768),'accepted'))
        self.assertFalse(pending())

    def test_changed_owner_and_nonhead_runs_cannot_supply_staging_vectors(self):
        self.db.execute("UPDATE scene_index_runs SET user_id='other'")
        rows = read_authority(self.query, lambda: None)
        self.assertEqual([row['vector_id'] for row in rows], ['vector'])

    def test_fixed_source_read_allowlist_never_accepts_arbitrary_sql(self):
        import io
        from d1_resource_vector_authority_transport import VectorAuthorityQuery, COUNT_SQL
        outer, calls = self, []
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(self, request, timeout):
                sql = json.loads(request.data)['sql']
                calls.append(sql)
                return Response(json.dumps({'success':True,'result':[{'success':True,'results':outer.query(sql)}]}).encode())
        query = VectorAuthorityQuery('synthetic-token-0123456789', opener=Opener())
        self.assertEqual(query(COUNT_SQL), [{'rows':'2'}])
        self.assertEqual(len(read_authority(query, lambda: None)), 2)
        before = len(calls)
        for sql in ['SELECT * FROM scenes','DELETE FROM scenes',COUNT_SQL+'; DELETE FROM scenes']:
            with self.assertRaisesRegex(ValueError,'QUERY_REFUSED'):
                query(sql)
        self.assertEqual(len(calls),before)


if __name__ == '__main__':
    unittest.main()
