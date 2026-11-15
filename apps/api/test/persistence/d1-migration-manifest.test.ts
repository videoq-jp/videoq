import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {buildMigrationManifest,convertMigrationValue,type Conversion} from '../../scripts/migrations/d1/manifest';
const snapshot=(folder:string)=>{const base=new URL('../../'+folder+'/',import.meta.url),journal=JSON.parse(readFileSync(new URL('meta/_journal.json',base),'utf8')) as {entries:{idx:number}[]};return JSON.parse(readFileSync(new URL('meta/'+String(journal.entries.at(-1)!.idx).padStart(4,'0')+'_snapshot.json',base),'utf8')) as {tables:Record<string,{name:string;columns:Record<string,{name:string;type:string;notNull:boolean}>}>};};
it('accounts for every current schema table and column without declaring data migration complete',()=>{
 const result=buildMigrationManifest(snapshot('drizzle'),snapshot('drizzle-d1'));
 expect(result.issues).toEqual([]);expect(result.mapping_complete).toBe(true);expect(result.execution_complete).toBe(false);
 expect(result.tables.filter(table=>table.policy==='convert_rows')).toHaveLength(56);expect(result.tables.filter(table=>table.target===null)).toHaveLength(2);expect(result.target_only).toHaveLength(11);
 expect(result.auxiliary_sources[0]).toMatchObject({schema:'chat_memory',tables:expect.arrayContaining(['checkpoints','checkpoint_blobs','checkpoint_writes'])});
 expect(result.target_insert_order.indexOf('users')).toBeLessThan(result.target_insert_order.indexOf('videos'));
 expect(result.target_insert_order.indexOf('videos')).toBeLessThan(result.target_insert_order.indexOf('scenes'));
});
it.each(['source-table','source-column','target-table','target-column','unsupported-type'] as const)('fails closed on %s schema drift',kind=>{
 const from=snapshot('drizzle'),to=snapshot('drizzle-d1');
 if(kind==='source-table')from.tables['public.unmapped']={name:'unmapped',columns:{}};
 if(kind==='target-table')to.tables.unmapped={name:'unmapped',columns:{}};
 if(kind==='source-column')from.tables['public.users'].columns.unmapped={name:'unmapped',type:'text',notNull:false};
 if(kind==='target-column')to.tables.users.columns.unmapped={name:'unmapped',type:'text',notNull:false};
 if(kind==='unsupported-type')from.tables['public.users'].columns.username.type='bytea';
 const result=buildMigrationManifest(from,to);expect(result.mapping_complete).toBe(false);expect(result.issues.length).toBeGreaterThan(0);
});
it.each([
 ['text','private-string','private-string'],['uuid','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'],
 ['safe_integer','9007199254740991',9007199254740991],['safe_integer','-9007199254740991',-9007199254740991],['boolean_integer','true',1],['boolean_integer','f',0],['finite_real','1.25e2',125],
 ['utc_timestamp','2026-11-13 09:01:02.123456+09','2026-11-13T00:01:02.123Z'],['date','2024-02-29','2024-02-29'],
 ['json_text','{"id":9007199254740993}','{"id":9007199254740993}'],['json_text','"scalar"','"scalar"'],['json_text','null','null'],['text_array_json','["字幕",null,"a,b"]','["字幕",null,"a,b"]'],
] as const)('converts %s without lossy driver parsing', (rule,input,expected)=>{expect(convertMigrationValue(input,rule,false)).toEqual(expected);});
it.each([
 ['safe_integer','9007199254740992'],['safe_integer','-9007199254740992'],['safe_integer','1.5'],['boolean_integer','1'],['finite_real','NaN'],['finite_real','Infinity'],['finite_real','0xff'],['utc_timestamp','2026-11-13 09:01:02'],['utc_timestamp','infinity'],['utc_timestamp','2026-02-30T09:00:00Z'],['utc_timestamp','2026-11-13T24:00:00Z'],['date','2026-02-30'],['uuid','private-canary-invalid'],['json_text','private-canary-invalid'],['text_array_json','[1]'],
] as [Conversion,string][])('rejects invalid %s without exposing the source value', (rule,input)=>{
 let error:unknown;try{convertMigrationValue(input,rule,false);}catch(caught){error=caught;}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(input);
});
it('keeps SQL NULL separate from JSON null and rejects missing required values',()=>{
 expect(convertMigrationValue(null,'json_text',true)).toBeNull();expect(convertMigrationValue('null','json_text',true)).toBe('null');expect(()=>convertMigrationValue(null,'text',false)).toThrow('NULL');expect(()=>convertMigrationValue(9007199254740992,'safe_integer',false)).toThrow('text output');
});
