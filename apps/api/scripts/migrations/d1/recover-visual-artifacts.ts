import {TextDecoder} from "node:util";

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {isSafeMediaPath} from '../../../src/shared/media-path';
import {validateLegacyVisualChunk,type VisualMigrationSource} from './visual-artifacts';
import type {VisualMigrationDestination} from './copy-visual-artifacts';
import type {VisualMigrationPlan} from './prepare-visuals';
type Rows=Record<string,Record<string,unknown>[]>;
const receipts=new WeakMap<object,string>();
export type VisualRecoveryReceipt={objects:number;bytes:number;sha256:string};
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const identity=(rows:Rows)=>hash(JSON.stringify([rows.video_visual_runs,rows.video_visual_chunks,rows.visual_object_attempts??[],rows.videos.map(v=>[v.id,v.user_id,v.file,v.source_type]) ]));
export function assertRecoveredVisuals(rows:Rows,receipt?:VisualRecoveryReceipt){if(!receipt||receipts.get(receipt)!==identity(rows))throw Error('A verified visual recovery copy bound to this snapshot is required.');}
const uuid=z.uuid(),int=z.number().int().safe();
/** Convert only to a separate, offline destination. Validate the complete
 * publication before its root pointer is created. Original versioned keys are
 * never modified. Lost successful PUT responses recover through byte equality. */
export async function recoverVisualArtifacts(rows:Rows,source:VisualMigrationSource,destination:VisualMigrationDestination,offline:boolean):Promise<VisualRecoveryReceipt>{
 if(offline!==true||source===destination)throw Error('Separate offline visual recovery storage required.');
 const inventory:{key:string;sha256:string;bytes:number}[]=[];
 const read=async(key:string,max:number)=>{const b=await source.read(key,max);if(!b||b.byteLength>max)throw Error('Recovery visual source is missing or oversized.');return b;};
 const create=async(key:string,bytes:Uint8Array)=>{const existing=await destination.read(key,bytes.byteLength);if(existing){if(hash(existing)!==hash(bytes)||existing.byteLength!==bytes.byteLength)throw Error('Recovery destination conflicts.');}else{await destination.create(key,bytes);const saved=await destination.read(key,bytes.byteLength);if(!saved||hash(saved)!==hash(bytes)||saved.byteLength!==bytes.byteLength)throw Error('Visual recovery copy verification failed.');}inventory.push({key,sha256:hash(bytes),bytes:bytes.byteLength});};
 const json=(bytes:Uint8Array)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
 const chunks=rows.video_visual_chunks;
 for(const a of rows.visual_object_attempts??[]){if(a.lease_token!==null||!['published','cleaned'].includes(String(a.status)))throw Error('Visual cleanup work is not quiescent.');if(a.status==='published'&&!rows.video_visual_runs.some(r=>r.run_id===a.run_id&&r.file_key===a.file_key&&r.video_id===a.video_id&&(a.kind==='manifest'?r.publication_version===a.object_version:chunks.some(c=>c.run_id===r.run_id&&c.chunk_index===a.chunk_index&&c.object_version===a.object_version))))throw Error('Published visual receipt is not referenced.');}
 if(chunks.some(c=>!rows.video_visual_runs.some(r=>r.run_id===c.run_id)))throw Error('Orphan visual recovery chunk.');
 for(const r of rows.video_visual_runs){
  const video=rows.videos.find(v=>v.id===r.video_id),file=z.string().parse(r.file_key),run=uuid.parse(r.run_id),duration=int.min(1).max(36000000).parse(r.duration_ms),count=int.min(1).max(600).parse(r.chunk_count);
  if(!video||video.file!==file||video.source_type!=='uploaded'||!isSafeMediaPath(file)||count!==Math.ceil(duration/60000))throw Error('Visual recovery owner or source mismatch.');
  const grid=chunks.filter(c=>c.run_id===run).sort((a,b)=>Number(a.chunk_index)-Number(b.chunk_index));if(grid.length!==count||grid.some((c,i)=>c.chunk_index!==i))throw Error('Incomplete recovery chunk grid.');
  if(r.status!=='ready'&&r.status!=='error'&&r.status!=='processing')throw Error('Visual processing must be drained before recovery.');
  const prefix=file+'.visual-v2/'+run+'/',overview:number[][]=[],frames:{timestamp_seconds:number;jpeg_base64:string}[]=[],versions:(string|null)[]=[];
  const plan:VisualMigrationPlan={videoId:int.min(1).parse(r.video_id),runId:run,fileKey:file,durationMs:duration,chunkCount:count,status:r.status,chunks:[]};
  // Stage validated bytes in memory bounded per source object. No manifest is
  // published until every referenced chunk and the source publication agree.
  const staged:{key:string;bytes:Uint8Array}[]=[];let stagedBytes=0;const stage=(key:string,bytes:Uint8Array)=>{stagedBytes+=bytes.byteLength;if(stagedBytes>256*1024*1024)throw Error('Visual recovery staging budget exceeded.');staged.push({key,bytes});};
  for(const c of grid){
   if(c.frame_count===null){if(r.status==='ready'||c.object_version!==null)throw Error('Unfinished recovery chunk.');versions.push(null);continue;}
   const index=int.min(0).max(599).parse(c.chunk_index),version=c.object_version===null?null:uuid.parse(c.object_version),base=prefix+index+(version?'/'+version:'');versions.push(version);
   const pack=await read(base+'.bin',60*256*1024+65536),sparse=await read(base+'.json',16*1024*1024),samples=validateLegacyVisualChunk(plan,index,int.min(0).max(60).parse(c.frame_count),pack,sparse);
   for(const s of samples){overview.push([Math.round(s.timestamp_seconds*1000),index,s.offset,s.length]);frames.push({timestamp_seconds:s.timestamp_seconds,jpeg_base64:s.jpeg_base64});}
   stage(prefix+index+'.bin',pack);stage(prefix+index+'.json',sparse);
  }
  if(r.status==='ready'){
   if(!frames.length||overview.length>240)throw Error('Invalid visual recovery overview.');
   const publication=r.publication_version===null?null:uuid.parse(r.publication_version),key=publication?prefix+'publications/'+publication+'/manifest.json':file+'.focus-v2.json';
   const manifest=json(await read(key,65536));
   const expected={version:2,video_id:r.video_id,run_id:run,duration_seconds:duration/1000,chunk_seconds:60,chunk_count:count,...(publication?{chunk_versions:versions}:{}),overview};
   const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
   if(JSON.stringify(canonical(manifest))!==JSON.stringify(canonical(expected)))throw Error('Published manifest disagrees with D1 chunks or byte ranges.');
   if(publication){
    const summary=z.object({version:z.literal(1),video_id:z.literal(plan.videoId),duration_seconds:z.literal(duration/1000),sampling_interval_seconds:z.number().min(5),frames:z.array(z.object({timestamp_seconds:z.number(),jpeg_base64:z.string()}).strict()).min(1).max(240)}).strict().parse(json(await read(prefix+'publications/'+publication+'/overview.json',16*1024*1024)));
    let prior=-1;for(const f of summary.frames){if(f.timestamp_seconds<=prior||!frames.some(x=>x.timestamp_seconds===f.timestamp_seconds&&x.jpeg_base64===f.jpeg_base64))throw Error('Published overview does not match images.');prior=f.timestamp_seconds;}
   }
   const legacy={...expected};delete (legacy as {chunk_versions?:unknown}).chunk_versions;
   stage(file+'.frames-v1.json',Buffer.from(JSON.stringify({version:1,video_id:r.video_id,duration_seconds:duration/1000,sampling_interval_seconds:Math.max(5,duration/1000/frames.length),frames})));
   // Publication pointer is the final write for each verified run.
   stage(file+'.focus-v2.json',Buffer.from(JSON.stringify(legacy)));
  }else if(r.publication_version!==null)throw Error('Nonready run has a publication pointer.');
  for(const object of staged)await create(object.key,object.bytes);
 }
 const result={objects:inventory.length,bytes:inventory.reduce((n,x)=>n+x.bytes,0),sha256:hash(JSON.stringify(inventory))};receipts.set(result,identity(rows));return result;
}
