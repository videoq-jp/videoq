import pathlib
import sqlite3
import tempfile
import unittest
from d1_resource_normalize import normalize_sql, statements, MAX_STATEMENT, AUX


def restore(path, foreign=True):
    db=sqlite3.connect(':memory:',isolation_level=None)
    db.execute('PRAGMA foreign_keys='+('ON' if foreign else 'OFF'))
    for statement in statements(path):db.execute(statement)
    return db


class NormalizeTests(unittest.TestCase):
    def test_parent_data_and_unique_index_precede_child(self):
        sql='''PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE child (id INTEGER PRIMARY KEY, p TEXT REFERENCES parent(code));
INSERT INTO child VALUES (1,'p');
CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT);
INSERT INTO parent VALUES (2,'p');
CREATE UNIQUE INDEX parent_code ON parent(code);
CREATE TRIGGER keep_audit AFTER INSERT ON parent BEGIN SELECT 1; END;
'''
        with tempfile.TemporaryDirectory() as root:
            a,b=pathlib.Path(root)/'a.sql',pathlib.Path(root)/'b.sql'
            a.write_text(sql);normalize_sql(a,b);db=restore(b)
            self.assertEqual(db.execute('SELECT * FROM child').fetchall(),[(1,'p')])
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='keep_audit'").fetchone());db.close()

    def test_large_text_blob_nul_integer_and_float_preserve_exact_bytes(self):
        text=("猫'🍎"*12000)+'\0end';blob=bytes(range(256))*400
        sql=("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE payload(id INTEGER PRIMARY KEY,t TEXT,b BLOB,i INTEGER,r REAL,n);\n"+f"INSERT INTO payload VALUES(1,CAST(X'{text.encode().hex()}' AS TEXT),X'{blob.hex()}',9223372036854775807,0.10000000000000001,NULL);\n")
        with tempfile.TemporaryDirectory() as root:
            a,b=pathlib.Path(root)/'a.sql',pathlib.Path(root)/'b.sql';a.write_text(sql);result=normalize_sql(a,b)
            self.assertEqual(result['chunkedRows'],1);self.assertTrue(all(len(s.encode())<=MAX_STATEMENT for s in statements(b)))
            original,normalized=restore(a),restore(b)
            query='SELECT typeof(t),hex(t),typeof(b),hex(b),CAST(i AS TEXT),printf(\'%!.26g\',r),typeof(n) FROM payload'
            self.assertEqual(original.execute(query).fetchall(),normalized.execute(query).fetchall())
            self.assertIsNone(normalized.execute('SELECT name FROM sqlite_master WHERE name=?',(AUX,)).fetchone());original.close();normalized.close()

    def test_cycle_and_unknown_statements_fail_closed(self):
        for sql in ['CREATE TABLE a(id REFERENCES b);\nCREATE TABLE b(id REFERENCES a);\n',"ATTACH 'private.db' AS x;\n"]:
            with self.subTest(sql=sql),tempfile.TemporaryDirectory() as root:
                a,b=pathlib.Path(root)/'a.sql',pathlib.Path(root)/'b.sql';a.write_text(sql)
                with self.assertRaises(Exception):normalize_sql(a,b)
                self.assertFalse(b.exists())

    def test_cannot_overwrite_source_or_existing_output(self):
        with tempfile.TemporaryDirectory() as root:
            a=pathlib.Path(root)/'a.sql';a.write_text('CREATE TABLE a(id);\n')
            with self.assertRaises(ValueError):normalize_sql(a,a)
            self.assertEqual(a.read_text(),'CREATE TABLE a(id);\n')

if __name__=='__main__':unittest.main()
