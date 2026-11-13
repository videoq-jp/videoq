import {mkdtemp,writeFile,readFile,rm,open,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {copyVisualArtifacts} from '../../scripts/migrations/d1/copy-visual-artifacts';
import {validateLegacyVisualChunk,prepareVisualArtifacts,type VisualArtifact} from '../../scripts/migrations/d1/visual-artifacts';
import type {VisualMigrationPlan} from '../../scripts/migrations/d1/prepare-visuals';
const plan:VisualMigrationPlan={videoId:1,runId:'00000000-0000-4000-8000-000000000003',fileKey:'private/video.mp4',durationMs:61000,chunkCount:2,status:'ready',chunks:[{index:0,frameCount:1},{index:1,frameCount:0}]};
const image=Buffer.from([255,216,255,224,0,255,217]);
function chunk(index=0,empty=false,patch:Record<string,unknown>={}){
 const metadata={version:1,video_id:1,duration_seconds:61,sampling_interval_seconds:1,frames:empty?[]:[[index*60000,0,image.length]],...patch},json=Buffer.from(JSON.stringify(metadata)),header=Buffer.alloc(12);header.write('VQFOC001');header.writeUInt32LE(json.length,8);
 return {pack:Buffer.concat([header,json,...empty?[]:[image]]),samples:Buffer.from(JSON.stringify(empty?[]:[{timestamp_seconds:index*60,jpeg_base64:image.toString('base64'),offset:12+json.length,length:image.length}]))};
}
describe('legacy visual artifact validation and private preparation',()=>{
 let directory:string,path:string,objects:Map<string,Uint8Array>;
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'visual-artifacts-'));path=join(directory,'plans');await writeFile(path,JSON.stringify(plan)+'\n',{mode:0o600});objects=new Map();for(const [index,empty] of [[0,false],[1,true]] as const){const data=chunk(index,empty),key=`${plan.fileKey}.visual-v2/${plan.runId}/${index}`;objects.set(key+'.bin',data.pack);objects.set(key+'.json',data.samples);}});
 afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
 const source={read:async(key:string,limit:number)=>{const value=objects.get(key);if(value&&value.byteLength>limit)throw new Error('source read exceeds budget');return value??null;}};
 const prepare=()=>prepareVisualArtifacts({path},'archive',directory,source);
 it('verifies exact image ranges and retains completed empty chunks',()=>{const valid=chunk();expect(validateLegacyVisualChunk(plan,0,1,valid.pack,valid.samples)).toHaveLength(1);const empty=chunk(1,true);expect(validateLegacyVisualChunk(plan,1,0,empty.pack,empty.samples)).toEqual([]);});
 it.each([
  ['identity',{video_id:2}],['duration',{duration_seconds:62}],['time',{frames:[[60000,0,image.length]]}],['offset',{frames:[[0,1,image.length]]}],['count',{frames:[]}],['extra-field',{private_canary:'value'}],
 ] as const)('rejects corrupt %s pack metadata',(_kind,patch)=>{const data=chunk(0,false,patch);expect(()=>validateLegacyVisualChunk(plan,0,1,data.pack,data.samples)).toThrow();});
 it.each(['magic','length','trailing','jpeg','sparse-offset','sparse-base64','sparse-time','invalid-json','invalid-utf8'] as const)('rejects %s object corruption without leaking payload',kind=>{
  const data=chunk();if(kind==='magic')data.pack[0]=0;if(kind==='length')data.pack.writeUInt32LE(65537,8);if(kind==='trailing')data.pack=Buffer.concat([data.pack,Buffer.from([0])]);if(kind==='jpeg')data.pack[data.pack.length-1]=0;
  if(kind.startsWith('sparse')){const samples=JSON.parse(data.samples.toString()) as {offset:number;jpeg_base64:string;timestamp_seconds:number}[];if(kind==='sparse-offset')samples[0].offset++;if(kind==='sparse-base64')samples[0].jpeg_base64='private-canary';if(kind==='sparse-time')samples[0].timestamp_seconds=1;data.samples=Buffer.from(JSON.stringify(samples));}
  if(kind==='invalid-json')data.samples=Buffer.from('private-canary-bad-json');if(kind==='invalid-utf8')data.samples=Buffer.from([255]);
  let error:unknown;try{validateLegacyVisualChunk(plan,0,1,data.pack,data.samples);}catch(value){error=value;}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-canary');
 });
 it('freezes versioned chunks and reconstructs a publication with stable IDs and content hashes',async()=>{
  const result=await prepare();expect(result).toMatchObject({artifacts:'6',runs:'1',visual_objects_migrated:false});
  const records=(await readFile(result.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as VisualArtifact);expect(records).toHaveLength(6);
  for(const record of records){expect(await privateMode(record.path)&0o777).toBe(0o600);expect(record.version).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);expect((await readFile(record.path)).length).toBe(record.bytes);}
  const manifest=JSON.parse(await readFile(records.find(record=>record.kind==='manifest')!.path,'utf8')) as {chunk_versions:string[];overview:number[][]};expect(manifest.chunk_versions).toEqual([records[0].version,records[2].version]);expect(manifest.overview).toHaveLength(1);
  const other=join(directory,'repeat');await mkdir(other,{mode:0o700});const repeated=await prepareVisualArtifacts({path},'archive',other,source);expect(repeated.sha256).toBe(result.sha256);
 });
 it('does not publish unfinished runs and does not read uncompleted chunks',async()=>{await writeFile(path,JSON.stringify({...plan,status:'processing',chunks:[{index:0,frameCount:1},{index:1,frameCount:null}]})+'\n');const result=await prepare();expect(result.artifacts).toBe('2');});
 it('rejects missing legacy objects',async()=>{objects.clear();await expect(prepare()).rejects.toThrow('missing');});
 it('pins the content in private staging even if the source changes afterwards',async()=>{const result=await prepare(),records=(await readFile(result.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as VisualArtifact);objects.clear();expect(await readFile(records[0].path)).toEqual(chunk().pack);});
 it('copies immutable artifacts once and reconciles a repeated copy by content',async()=>{
  const result=await prepare(),target=new Map<string,Uint8Array>();let writes=0;const destination={read:async(key:string)=>target.get(key)??null,create:async(key:string,bytes:Uint8Array)=>{if(target.has(key))throw new Error('must not overwrite');target.set(key,bytes);writes++;}};
  expect(await copyVisualArtifacts(result,destination,{offlineStaging:true})).toMatchObject({visual_object_copy_complete:true,visual_objects_migrated:false,copied:'6'});expect(await copyVisualArtifacts(result,destination,{offlineStaging:true})).toMatchObject({copied:'0',retained:'6'});expect(writes).toBe(6);
 });
 it('recovers a successful PUT whose response was lost',async()=>{
  const result=await prepare(),target=new Map<string,Uint8Array>();let lose=true;const destination={read:async(key:string)=>target.get(key)??null,create:async(key:string,bytes:Uint8Array)=>{if(target.has(key))throw new Error('overwrite');target.set(key,bytes);if(lose){lose=false;throw new Error('private-canary-provider-response');}}};
  const error=await copyVisualArtifacts(result,destination,{offlineStaging:true}).catch(error=>error);expect(String(error)).not.toContain('private-canary');expect(await copyVisualArtifacts(result,destination,{offlineStaging:true})).toMatchObject({copied:'5',retained:'1'});
 });
 it('refuses conflicting target content without replacing it',async()=>{
  const result=await prepare();let writes=0;await expect(copyVisualArtifacts(result,{read:async()=>Buffer.from('other'),create:async()=>{writes++;}},{offlineStaging:true})).rejects.toThrow('conflicts');expect(writes).toBe(0);
 });
 it('refuses a changed local object before any PUT',async()=>{
  const result=await prepare(),record=JSON.parse((await readFile(result.path,'utf8')).split('\n')[0]) as VisualArtifact;await writeFile(record.path,Buffer.alloc(record.bytes));let writes=0;await expect(copyVisualArtifacts(result,{read:async()=>null,create:async()=>{writes++;}},{offlineStaging:true})).rejects.toThrow('changed');expect(writes).toBe(0);
 });

 it('verifies the complete artifact inventory before the first PUT',async()=>{
  const result=await prepare();await writeFile(result.path,(await readFile(result.path,'utf8')).replace('private/video.mp4','other/video.mp4'));let writes=0;await expect(copyVisualArtifacts(result,{read:async()=>null,create:async()=>{writes++;}},{offlineStaging:true})).rejects.toThrow('plan changed');expect(writes).toBe(0);
 });
 it('uses a frozen plan if the original plan changes during destination writes',async()=>{
  const result=await prepare(),target=new Map<string,Uint8Array>();let changed=false;const destination={read:async(key:string)=>target.get(key)??null,create:async(key:string,bytes:Uint8Array)=>{target.set(key,bytes);if(!changed){changed=true;await writeFile(result.path,'damaged-original');}}};expect(await copyVisualArtifacts(result,destination,{offlineStaging:true})).toMatchObject({copied:'6'});
 });

});

async function privateMode(path:string){const file=await open(path,'r');try{return (await file.stat()).mode;}finally{await file.close();}}
