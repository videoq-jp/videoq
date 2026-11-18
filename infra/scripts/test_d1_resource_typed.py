import copy
import unittest
from d1_resource_typed import compare_typed,row_hash,normalize
from d1_resource_write_fence import fingerprint
from d1_resource_fence_control import SCHEMA_SQL


class TypedTests(unittest.TestCase):
    def fixture(self,left,right):
        columns=[{'name':'value'}];names=['value'];source=[{'c0':left}];local=[{'c0':right}]
        a={'schemaSha256':fingerprint([]),'tables':[{'table':'t','columnsSha256':fingerprint(columns),'rows':1,'valuesSha256':row_hash(source,names)}],'sqliteSequenceIncluded':False,'foreignKeysValid':True}
        b=copy.deepcopy(a);b['tables'][0]['valuesSha256']=row_hash(local,names)
        def query(sql):
            if sql==SCHEMA_SQL:return []
            if sql=='PRAGMA table_xinfo("t")':return columns
            return source
        return a,b,lambda sql:local,query

    def test_roundtrip_real_spellings_preserve_identical_bits(self):
        args=self.fixture('real:0.10000000000000000555','real:0.10000000000000001')
        proof=compare_typed(*args,lambda:None)
        self.assertTrue(proof['verified']);self.assertTrue(proof['rawFormatterHashesDiffer'])
        self.assertNotEqual(args[0]['tables'][0]['valuesSha256'],args[1]['tables'][0]['valuesSha256'])

    def test_real_bit_integer_byte_blob_text_and_type_changes_fail(self):
        pairs=[('real:0.1','real:0.10000000000000002'),('integer:39323233333732303336383534373735383037','integer:39323233333732303336383534373735383036'),('blob:00FF','blob:00FE'),('text:00FF','blob:00FF'),('null:','text:')]
        for a,b in pairs:
            with self.subTest(a=a,b=b),self.assertRaisesRegex(ValueError,'VALUES_DIFFER'):
                compare_typed(*self.fixture(a,b),lambda:None)

    def test_changed_source_or_count_cannot_use_old_proof(self):
        a,b,local,query=self.fixture('real:0.1','real:0.10000000000000001')
        a['tables'][0]['valuesSha256']='a'*64
        with self.assertRaisesRegex(ValueError,'SOURCE_OR_RESTORE_CHANGED'):compare_typed(a,b,local,query,lambda:None)
        a,b,local,query=self.fixture('real:0.1','real:0.10000000000000001');b['tables'][0]['rows']=2
        with self.assertRaisesRegex(ValueError,'VALUES_DIFFER'):compare_typed(a,b,local,query,lambda:None)

    def test_missing_source_guard_and_nan_fail(self):
        with self.assertRaisesRegex(ValueError,'SOURCE_PROOF'):compare_typed(*self.fixture('real:0.1','real:0.10000000000000001'),None)
        with self.assertRaisesRegex(ValueError,'REAL_INVALID'):normalize('real:nan')

if __name__=='__main__':unittest.main()
