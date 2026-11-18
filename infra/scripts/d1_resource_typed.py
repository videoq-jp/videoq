"""Exact local-dump comparison across SQLite real-number formatting versions.

Only real spellings may differ: compare their complete IEEE-754 bit patterns.
Every other typed cell byte, schema, column, row count and sequence stays exact.
Fresh fenced source rows must reproduce the original remote raw-hash proof.
Cloudflare-to-Cloudflare final comparison continues using the original hashes.
"""
import hashlib
import json
import math
import struct
from d1_resource_fence_control import SCHEMA_SQL
from d1_resource_verify import page_sql, assert_identical as _original
from d1_resource_write_fence import fingerprint

def normalize(cell):
    if not isinstance(cell,str) or ':' not in cell:raise ValueError('RESOURCE_TYPED_CELL_INVALID')
    kind,value=cell.split(':',1)
    if kind=='real':
        number=float(value)
        if math.isnan(number):raise ValueError('RESOURCE_TYPED_REAL_INVALID')
        return 'realbits:'+struct.pack('>d',number).hex()
    if kind not in ('integer','text','blob','null'):raise ValueError('RESOURCE_TYPED_CELL_INVALID')
    return cell

def row_hash(rows,names):
    digest=hashlib.sha256()
    for row in rows:
        if set(row)!={'c'+str(i) for i in range(len(names))}:raise ValueError('RESOURCE_TYPED_COLUMNS_INVALID')
        digest.update(json.dumps([row['c'+str(i)] for i in range(len(names))],ensure_ascii=True,separators=(',',':')).encode()+b'\n')
    return digest.hexdigest()

def normalized(rows,names):
    return sorted(tuple(normalize(row['c'+str(i)]) for i in range(len(names))) for row in rows)

def compare_typed(a,b,local,source_query,assert_source_fenced):
    if a==b:return _original(a,b)
    if not callable(source_query) or not callable(assert_source_fenced):raise ValueError('RESOURCE_TYPED_SOURCE_PROOF_REQUIRED')
    if set(a)!=set(b) or any(a[k]!=b[k] for k in a if k!='tables') or len(a['tables'])!=len(b['tables']):raise ValueError('RESOURCE_DATABASE_VALUES_DIFFER')
    pairs=[]
    for left,right in zip(a['tables'],b['tables']):
        if set(left)!=set(right) or any(left[k]!=right[k] for k in left if k!='valuesSha256'):raise ValueError('RESOURCE_DATABASE_VALUES_DIFFER')
        if left['valuesSha256']!=right['valuesSha256']:pairs.append((left,right))
    def fenced():
        assert_source_fenced()
        raw=source_query(SCHEMA_SQL)
        filtered=[row for row in raw if not row['name'].startswith(('sqlite_','_cf_'))]
        if fingerprint(filtered)!=a['schemaSha256']:raise ValueError('RESOURCE_TYPED_SOURCE_SCHEMA_CHANGED')
    fenced()
    checked=[]
    for left,right in pairs:
        table=left['table'];quoted='"'+table.replace('"','""')+'"'
        columns=source_query('PRAGMA table_xinfo('+quoted+')')
        if fingerprint(columns)!=left['columnsSha256']:raise ValueError('RESOURCE_TYPED_SOURCE_COLUMNS_CHANGED')
        names=[column['name'] for column in columns]
        source=[];restored=[]
        for offset in range(0,left['rows']+100,100):
            fenced();rows=source_query(page_sql(table,names,100,offset));source+=rows
            if len(rows)<100:break
        for offset in range(0,right['rows']+100,100):
            rows=local(page_sql(table,names,100,offset));restored+=rows
            if len(rows)<100:break
        if (len(source)!=left['rows'] or len(restored)!=right['rows'] or row_hash(source,names)!=left['valuesSha256'] or row_hash(restored,names)!=right['valuesSha256']):raise ValueError('RESOURCE_TYPED_SOURCE_OR_RESTORE_CHANGED')
        if normalized(source,names)!=normalized(restored,names):raise ValueError('RESOURCE_DATABASE_VALUES_DIFFER')
        checked.append(table)
    fenced()
    return {'verified':True,'snapshotSha256':fingerprint(a),'tables':len(a['tables']),'rows':sum(row['rows'] for row in a['tables']),'sqliteSequenceIncluded':a['sqliteSequenceIncluded'],'comparisonCodec':'sqlite-exact-types-bytes-ieee754-v1','rawFormatterHashesDiffer':True,'ieee754ExactTables':checked,'cloudflareToCloudflareRawComparisonStillRequired':True}
