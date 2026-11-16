import importlib.util,json,os,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('recovery',Path(__file__).with_name('rebuild_scene_vectors.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RecoveryTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name);self.base.chmod(0o700);self.source=self.base/'source.sql'
  self.source.write_text("CREATE TABLE videos(id INTEGER PRIMARY KEY,user_id TEXT);CREATE TABLE scenes(id TEXT,video_id INTEGER,content TEXT,dimensions INTEGER,revision TEXT,vector_id TEXT);INSERT INTO videos VALUES(1,'owner');INSERT INTO scenes VALUES('scene',1,'private scene',1536,'revision','immutable-id');");self.source.chmod(0o600)
 def test_private_preparation_retains_content_identity_without_model_calls(self):
  proof=m.prepare(self.source,self.base);self.assertFalse(proof['modelCallsMade']);self.assertEqual(proof['scenes'],1)
  row=json.loads((self.base/'scene-inventory.private.json').read_text())[0];self.assertEqual(row['vectorId'],'immutable-id')
  manifest=json.loads((self.base/'manifest-000000.json').read_text());self.assertEqual(manifest['cases'][0]['question'],'private scene');self.assertEqual((self.base/'manifest-000000.json').stat().st_mode&0o777,0o600)
 def test_rejects_unsupported_profile_and_missing_owner(self):
  self.source.write_text(self.source.read_text().replace('1536','768'))
  with self.assertRaisesRegex(ValueError,'OTHER_PROFILE'):m.read_scenes(self.source)
  self.source.write_text(self.source.read_text().replace('768','1536').replace("VALUES('scene',1,","VALUES('scene',2,"))
  with self.assertRaisesRegex(ValueError,'ORPHANED'):m.read_scenes(self.source)
 def test_blocks_external_database_attachment(self):
  self.source.write_text("ATTACH DATABASE ':memory:' AS other;")
  with self.assertRaises(sqlite3.DatabaseError):m.read_scenes(self.source)
 def test_refuses_public_input_and_changed_source_on_resume(self):
  self.source.chmod(0o644)
  with self.assertRaisesRegex(ValueError,'PRIVATE_FILE'):m.read_scenes(self.source)
  self.source.chmod(0o600);m.prepare(self.source,self.base);self.source.write_text(self.source.read_text().replace('private scene','changed scene'))
  with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):m.prepare(self.source,self.base)
 def test_generation_preserves_metadata_and_rejects_tampered_provenance(self):
  target={'version':1,'functionArn':'arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-search-evaluation-prod','functionVersion':'6','imageUri':'257240362763.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:'+'a'*64,'roleArn':'arn:aws:iam::257240362763:role/videoq-worker-prod','federationPolicyId':'policy'}
  path=self.base/'target.json';path.write_text(json.dumps(target));path.chmod(0o600)
  def remote(manifest_path,destination,*args,**kwargs):
   manifest=json.loads(manifest_path.read_text())
   value={'cases':[{'userId':'owner','videoIds':[1],'queryEmbedding':[1.0]+[0.0]*1535}], 'generation':{'manifest_sha256':m.digest(manifest),'runtime':{k:target[k] for k in ['functionArn','functionVersion','imageUri','roleArn']},'embedding':m.EMBEDDING,'input_type':'query','case_ids':['s0']}}
   destination.write_text(json.dumps(value));destination.chmod(0o600)
  with patch.object(m,'prepare_remote',side_effect=remote):
   proof=m.prepare(self.source,self.base,path,True,object())
  self.assertEqual(proof['scenes'],1)
  vector=json.loads((self.base/'recovered-vectors.ndjson').read_text())
  self.assertEqual(vector['id'],'immutable-id');self.assertEqual(vector['metadata'],{'user_id':'owner','video_id':1,'scene_id':'scene','revision':'revision','vector_id':'immutable-id'})
  cache=self.base/'manifest-000000-vectors.json';value=json.loads(cache.read_text());value['generation']['runtime']['imageUri']='tampered';cache.write_text(json.dumps(value))
  with self.assertRaisesRegex(ValueError,'PROVENANCE'):m.prepare(self.source,self.base,path,True,object())
if __name__=='__main__':unittest.main()
