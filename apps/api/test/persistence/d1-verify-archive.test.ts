import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
import {verifyPostgresArchive} from '../../scripts/migrations/d1/verify-archive';
import {ARCHIVE_VERSION} from '../../scripts/migrations/d1/archive-format';
const manifest=()=>buildMigrationManifest({dialect:'postgresql',tables:{probe:{name:'probe',columns:{id:{name:'id',type:'bigint',notNull:true},secret:{name:'secret',type:'text',notNull:true}}}}},{dialect:'sqlite',tables:{probe:{name:'probe',columns:{id:{name:'id',type:'integer',notNull:true},secret:{name:'secret',type:'text',notNull:true}}}}});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const frame=(record:unknown)=>JSON.stringify(record)+'\n';
function archive(value='private-canary-字幕'){
 const row={kind:'row',values:[1,value]},summary={schema:'public',table:'probe',rows:'1',sha256:digest(frame(row))};
 const records=[{kind:'archive_start',version:ARCHIVE_VERSION,source_schema:'public',created_at:'2026-11-13T00:00:00.000Z',snapshot:'repeatable-read/read-only',mapping_sha256:digest(JSON.stringify(manifest())),execution_complete:false,sequences:[],migration_history:null,auxiliary_sources:manifest().auxiliary_sources,auxiliary_inventory:[{schema:'chat_memory',tables:[]}]},{kind:'table_start',schema:'public',table:'probe',mode:'converted',columns:[{name:'id',type:'bigint',encoding:'safe_integer'},{name:'secret',type:'text',encoding:'text'}],primary_key:['id']},row,{kind:'table_end',...summary}];
 return records.map(frame).join('')+frame({kind:'archive_end',tables:[summary],sha256:digest(records.map(frame).join('')),execution_complete:false});
}
let directory:string,path:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'videoq-verify-test-'));path=join(directory,'source.videoq-export.ndjson');});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
const save=async(value:string|Buffer)=>{await writeFile(path,value,{mode:0o600});};
it('verifies exact frames and stream chunk boundaries without returning source row data',async()=>{
 await save(archive('字幕'.repeat(30000)));const result=await verifyPostgresArchive(path,manifest());expect(result).toMatchObject({verified:true,version:ARCHIVE_VERSION,tables:1,rows:'1',execution_complete:false});expect(JSON.stringify(result)).not.toContain('字幕');
});
it.each(['row-change','table-hash','archive-hash','truncated','missing-newline','trailing-data','duplicate-key','invalid-utf8','old-version','mapping','column','unsafe-integer','duplicate-table','missing-table','inventory'] as const)('rejects %s without exposing row contents',async(kind)=>{
 let source=archive();const records=source.trimEnd().split('\n').map(line=>JSON.parse(line));
 if(kind==='row-change')records[2].values[1]='changed-private-canary';
 if(kind==='table-hash')records[3].sha256='0'.repeat(64);
 if(kind==='archive-hash')records[4].sha256='0'.repeat(64);
 if(kind==='old-version')records[0].version=1;
 if(kind==='mapping')records[0].mapping_sha256='0'.repeat(64);
 if(kind==='column')records[1].columns[0].encoding='text';
 if(kind==='unsafe-integer')records[2].values[0]=9007199254740992;
 if(kind==='duplicate-table')records.splice(4,0,...records.slice(1,4));
 if(kind==='missing-table')records.splice(1,3);
 if(kind==='inventory')records[0].auxiliary_inventory[0].tables=['unknown'];
 if(['old-version','mapping','column','unsafe-integer','duplicate-table','missing-table','inventory'].includes(kind)){
  let tableRows:unknown[]=[];const summaries=[];
  for(const record of records){if(record.kind==='table_start')tableRows=[];if(record.kind==='row')tableRows.push(record);if(record.kind==='table_end'){record.rows=String(tableRows.length);record.sha256=digest(tableRows.map(frame).join(''));summaries.push({schema:record.schema,table:record.table,rows:record.rows,sha256:record.sha256});}}
  records.at(-1).tables=summaries;records.at(-1).sha256=digest(records.slice(0,-1).map(frame).join(''));
 }
 source=records.map(frame).join('');
 if(kind==='truncated')source=source.slice(0,source.indexOf('{"kind":"archive_end"'));
 if(kind==='missing-newline')source=source.slice(0,-1);
 if(kind==='trailing-data')source+='\n';
 if(kind==='duplicate-key')source=source.replace('"kind":"row"','"kind":"row","kind":"row"');
 let bytes=Buffer.from(source);if(kind==='invalid-utf8'){bytes=Buffer.from(bytes);bytes[bytes.indexOf(Buffer.from('字幕'))]=255;}
 await save(bytes);let failure:unknown;try{await verifyPostgresArchive(path,manifest());}catch(error){failure=error;}expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private-canary');
});
it('rejects public-readable files, symlinks and oversized frames',async()=>{
 await save(archive());await chmod(path,0o644);await expect(verifyPostgresArchive(path,manifest())).rejects.toThrow('private regular');await chmod(path,0o600);
 const linked=join(directory,'link');await symlink(path,linked);await expect(verifyPostgresArchive(linked,manifest())).rejects.toThrow('private regular');
 await save(archive('x'.repeat(2000)));await expect(verifyPostgresArchive(path,manifest(),{maxLineBytes:1024})).rejects.toThrow('size limit');
});
