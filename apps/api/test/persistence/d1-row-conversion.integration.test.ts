import {expect,it} from 'vitest';
import {convertMigrationValue,migrationSelectExpression,type Conversion} from '../../scripts/migrations/d1/manifest';
import {isolatedPostgres} from './isolated-postgres';
import {createD1Fixture} from './d1-fixture';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
it.skipIf(!url)('preserves PostgreSQL text output through typed conversion into real D1 bindings',async()=>{
 const pg=await isolatedPostgres(url!),d1=await createD1Fixture();
 try{
  await pg.pool.query(`CREATE TABLE conversion_probe(id uuid PRIMARY KEY,active boolean,bytes bigint,ratio double precision,created_at timestamptz,day date,secret text,document jsonb,tags text[],optional text); SET TIME ZONE 'Asia/Tokyo';
   INSERT INTO conversion_probe VALUES('00000000-0000-4000-8000-000000000001',true,9007199254740991,1.25,'2026-11-13T09:01:02.123456+09','2024-02-29','opaque-encrypted-value','{"number":9007199254740993,"literal":"null"}',ARRAY['字幕','a,b','"quoted"',NULL],NULL);`);
  const columns:[string,string,Conversion][]=[['id','uuid','uuid'],['active','boolean','boolean_integer'],['bytes','bigint','safe_integer'],['ratio','double precision','finite_real'],['created_at','timestamp with time zone','utc_timestamp'],['day','date','date'],['secret','text','text'],['document','jsonb','json_text'],['tags','text[]','text_array_json'],['optional','text','text']];
  const source=(await pg.pool.query('SELECT '+columns.map(([name,type])=>migrationSelectExpression({name,type})).join(',')+' FROM conversion_probe')).rows[0] as Record<string,string|null>;
  const values=columns.map(([name,,conversion])=>convertMigrationValue(source[name],conversion,name==='optional'));
  await d1.database.prepare('CREATE TABLE conversion_probe(id TEXT PRIMARY KEY,active INTEGER,bytes INTEGER,ratio REAL,created_at TEXT,day TEXT,secret TEXT,document TEXT,tags TEXT,optional TEXT)').run();
  await d1.database.prepare('INSERT INTO conversion_probe VALUES('+columns.map(()=>'?').join(',')+')').bind(...values).run();
  const result=await d1.database.prepare('SELECT * FROM conversion_probe').first<Record<string,unknown>>();
  expect(result).toEqual({id:source.id,active:1,bytes:9007199254740991,ratio:1.25,created_at:'2026-11-13T00:01:02.123Z',day:'2024-02-29',secret:'opaque-encrypted-value',document:source.document,tags:source.tags,optional:null});
  expect(String(result!.document)).toContain('9007199254740993');expect(JSON.parse(String(result!.tags))).toEqual(['字幕','a,b','"quoted"',null]);
  // Unsafe values fail before an import statement is constructed or sent.
  await pg.pool.query("UPDATE conversion_probe SET bytes=9007199254740992");
  const unsafe=(await pg.pool.query('SELECT bytes::text AS bytes FROM conversion_probe')).rows[0].bytes as string;
  expect(()=>convertMigrationValue(unsafe,'safe_integer',false)).toThrow('safe range');expect((await d1.database.prepare('SELECT bytes FROM conversion_probe').first<{bytes:number}>())!.bytes).toBe(9007199254740991);
 }finally{await d1.dispose();await pg.dispose();}
});
