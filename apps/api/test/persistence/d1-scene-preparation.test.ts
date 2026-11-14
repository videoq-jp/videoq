import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {prepareSceneImport} from '../../scripts/migrations/d1/prepare-scenes';
import type {PreparedTable,PreparedSpecialTable} from '../../scripts/migrations/d1/prepare-import';
const columns=['langchain_id','content','embedding','user_id','video_id','langchain_metadata'];
const id='00000000-0000-4000-8000-000000000003';
describe('private PostgreSQL scene preparation',()=>{
 let directory:string,common:PreparedTable[],special:PreparedSpecialTable[];
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'scene-preparation-'));common=[{name:'videos',columns:['id','user_id'],path:join(directory,'videos'),rows:'1'}];await writeFile(common[0].path,JSON.stringify({kind:'row',values:[1,'owner']})+'\n',{mode:0o600});special=[];});
 afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
 const source=async(dimensions:768|1536,patch:Record<string,unknown>={})=>{
  const values:Record<string,unknown>={langchain_id:id,content:'日本語字幕',embedding:JSON.stringify(Array(dimensions).fill(.01)),user_id:'owner',video_id:'1',langchain_metadata:JSON.stringify({video_id:1,user_id:'owner',start_time:'00:00:01,000',end_time:'00:00:02,000'}),...patch};
  const table:PreparedSpecialTable={name:dimensions===1536?'scene_embeddings':'scene_embeddings_768',schema:'public',columns,types:[],path:join(directory,'source-'+special.length),rows:'1'};await writeFile(table.path,JSON.stringify({kind:'row',values:columns.map(column=>values[column])})+'\n',{mode:0o600});special.push(table);
 };
 const run=()=>prepareSceneImport(common,special,'archive-hash',directory);
 it('retains the same scene ID in separate model spaces and prepares existing vectors without regeneration',async()=>{
  await source(1536);await source(768,{langchain_metadata:JSON.stringify({evidence_type:'visual'})});const result=await run(),rows=(await readFile(result.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(result).toMatchObject({rows:'2',prepared:true,vectorize_delivery_complete:false});expect(rows[0]).toMatchObject({videoId:1,userId:'owner',dimensions:1536,scene:{id,content:'日本語字幕',startTime:'00:00:01,000',endTime:'00:00:02,000',evidenceType:'transcript'}});expect(rows[0].scene.embedding).toEqual(Array(1536).fill(.01));expect(rows[1].scene.evidenceType).toBe('visual');expect(rows[1].scene.startTime).toBe('');expect(rows[1].vectorId).not.toBe(rows[0].vectorId);expect(rows[0].vectorId).toMatch(/^[0-9a-f]{64}$/);expect((await stat(result.path)).mode&0o777).toBe(0o600);
  await rm(result.path);await rm(join(directory,'scene-source.sqlite'));const repeated=await run();expect(await readFile(repeated.path,'utf8')).toBe(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 });
 it('supports SQL NULL metadata using existing search defaults',async()=>{await source(1536,{langchain_metadata:null});const result=await run();expect(JSON.parse(await readFile(result.path,'utf8')).scene).toMatchObject({startTime:'',endTime:'',evidenceType:'transcript'});});
 it.each([
  {video_id:'2'},{user_id:'other'},{embedding:'[1,2]'},{embedding:JSON.stringify(Array(1536).fill(0))},{embedding:JSON.stringify(Array(1536).fill(1e100))},{langchain_metadata:'{"user_id":"other"}'},{langchain_metadata:'{"video_id":2}'},{langchain_metadata:'{"evidence_type":"unknown"}'},{langchain_metadata:'{"start_time":12}'},{langchain_metadata:'private-scene-canary-bad-json'},
 ])('rejects malformed or unauthorized source before target writes: %j',async patch=>{await source(1536,patch);const error=await run().then(()=>null,error=>error);expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-scene-canary');});
 it('rejects duplicate scene identity within one model space',async()=>{await source(1536);await source(1536);await expect(run()).rejects.toThrow('Scene archive reconstruction failed.');});
});
