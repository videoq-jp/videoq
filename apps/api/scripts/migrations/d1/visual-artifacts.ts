import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {open,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {isSafeMediaPath} from '../../../src/shared/media-path';
import type {VisualMigrationPlan} from './prepare-visuals';
import {readArchiveLines} from './verify-archive';
const MAX_IMAGE=256*1024,MAX_PACK=60*MAX_IMAGE+64*1024,MAX_JSON=16*1024*1024;
export class VisualArtifactError extends Error {readonly name='VisualArtifactError';}
const frame=z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative(),z.number().int().positive().max(MAX_IMAGE)]);
const packSchema=z.object({version:z.literal(1),video_id:z.number().int().positive().safe(),duration_seconds:z.number().finite().positive().max(36000),sampling_interval_seconds:z.literal(1),frames:z.array(frame).max(60)}).strict();
const samplesSchema=z.array(z.object({timestamp_seconds:z.number().finite().nonnegative(),jpeg_base64:z.string().max(349528),offset:z.number().int().nonnegative(),length:z.number().int().positive().max(MAX_IMAGE)}).strict()).max(60);
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const decode=(bytes:Uint8Array)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
/** Compare every image and every sparse reference, rather than trusting object
 * names or JPEG markers alone. Empty completed chunks are valid stream gaps. */
export function validateLegacyVisualChunk(plan:VisualMigrationPlan,index:number,expectedFrames:number,pack:Uint8Array,samples:Uint8Array){
 try{
  if(pack.byteLength<12||pack.byteLength>MAX_PACK||samples.byteLength>MAX_JSON||Buffer.from(pack.subarray(0,8)).toString()!=='VQFOC001')throw new VisualArtifactError('Invalid legacy visual chunk header.');
  const length=new DataView(pack.buffer,pack.byteOffset,pack.byteLength).getUint32(8,true),start=12+length;
  if(!length||length>64*1024||start>pack.byteLength)throw new VisualArtifactError('Invalid legacy visual chunk index length.');
  const metadata=packSchema.parse(decode(pack.subarray(12,start))),coarse=samplesSchema.parse(decode(samples));
  if(!Number.isSafeInteger(index)||index<0||index>=plan.chunkCount||metadata.video_id!==plan.videoId||metadata.duration_seconds!==plan.durationMs/1000||metadata.frames.length!==expectedFrames)throw new VisualArtifactError('Legacy visual chunk identity mismatch.');
  const lookup=new Map<number,{offset:number;length:number}>();let offset=0,previous=-1000;
  for(const [time,relative,size] of metadata.frames){
   if(time<index*60000||time>=Math.min((index+1)*60000,plan.durationMs)||Math.floor(time/1000)<=Math.floor(previous/1000)||relative!==offset||start+relative+size>pack.byteLength)throw new VisualArtifactError('Invalid legacy visual frame ranges.');
   const bytes=pack.subarray(start+relative,start+relative+size);if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new VisualArtifactError('Invalid legacy visual JPEG.');
   lookup.set(time,{offset:start+relative,length:size});previous=time;offset+=size;
  }
  if(start+offset!==pack.byteLength)throw new VisualArtifactError('Legacy visual chunk has uncovered bytes.');
  let prior=-1;
  for(const sample of coarse){const time=Math.round(sample.timestamp_seconds*1000),dense=lookup.get(time);
   if(time<=prior||sample.timestamp_seconds!==time/1000||!dense||dense.offset!==sample.offset||dense.length!==sample.length||Buffer.from(pack.subarray(sample.offset,sample.offset+sample.length)).toString('base64')!==sample.jpeg_base64)throw new VisualArtifactError('Legacy sparse sample does not match its dense image.');
   prior=time;
  }
  return coarse;
 }catch(error){if(error instanceof VisualArtifactError)throw error;throw new VisualArtifactError('Legacy visual chunk validation failed.');}
}
export interface VisualMigrationSource {/** Must bound the read before materializing the body. */read(key:string,maximumBytes:number):Promise<Uint8Array|null>;}
export type VisualArtifact={kind:'chunk'|'manifest'|'overview';videoId:number;runId:string;fileKey:string;index:number|null;version:string;key:string;path:string;sha256:string;bytes:number};
function version(identity:unknown){const hex=sha(JSON.stringify(identity));return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
/** Source media must be drained along with PG writers. Freeze validated objects
 * on private disk; the plan digest detects source changes on a later retry. */
export async function prepareVisualArtifacts(plans:{path:string},archive:string,directory:string,source:VisualMigrationSource){
 const path=join(directory,'visual-artifacts.ndjson'),file=await open(path,'wx',0o600),planHash=createHash('sha256');let artifacts=0n,runs=0n;
 try{
  const save=async(artifact:Omit<VisualArtifact,'path'|'sha256'|'bytes'>,bytes:Uint8Array)=>{
   const hash=sha(bytes),local=join(directory,'visual-artifact-'+artifacts),record:VisualArtifact={...artifact,path:local,sha256:hash,bytes:bytes.byteLength};
   await writeFile(local,bytes,{flag:'wx',mode:0o600});await file.writeFile(JSON.stringify(record)+'\n');
   planHash.update(JSON.stringify({...artifact,sha256:hash,bytes:bytes.byteLength})+'\n');artifacts++;
  };
  for await(const line of readArchiveLines(plans.path)){
   const plan=JSON.parse(line.toString()) as VisualMigrationPlan;if(!isSafeMediaPath(plan.fileKey))throw new VisualArtifactError('Invalid visual migration object path.');
   const prefix=`${plan.fileKey}.visual-v2/${plan.runId}/`,versions:string[]=[],overview:number[][]=[],frames:{timestamp_seconds:number;jpeg_base64:string}[]=[];
   for(const chunk of plan.chunks){
    if(chunk.frameCount===null){versions.push('');continue;}
    const key=prefix+chunk.index,pack=await source.read(key+'.bin',MAX_PACK),json=await source.read(key+'.json',MAX_JSON);
    if(!pack||!json)throw new VisualArtifactError('Legacy visual object is missing.');
    const samples=validateLegacyVisualChunk(plan,chunk.index,chunk.frameCount,pack,json),objectVersion=version([archive,plan.runId,chunk.index,sha(pack),sha(json)]);versions.push(objectVersion);
    for(const sample of samples){overview.push([Math.round(sample.timestamp_seconds*1000),chunk.index,sample.offset,sample.length]);frames.push({timestamp_seconds:sample.timestamp_seconds,jpeg_base64:sample.jpeg_base64});}
    const identity={kind:'chunk' as const,videoId:plan.videoId,runId:plan.runId,fileKey:plan.fileKey,index:chunk.index,version:objectVersion};
    await save({...identity,key:key+'/'+objectVersion+'.bin'},pack);await save({...identity,key:key+'/'+objectVersion+'.json'},json);
   }
   if(plan.status==='ready'){
    if(versions.some(value=>!value)||!overview.length||overview.length>240)throw new VisualArtifactError('Ready visual publication has incomplete samples.');
    const manifest=Buffer.from(JSON.stringify({version:2,video_id:plan.videoId,run_id:plan.runId,duration_seconds:plan.durationMs/1000,chunk_seconds:60,chunk_count:plan.chunkCount,chunk_versions:versions,overview}));
    if(manifest.byteLength>64*1024)throw new VisualArtifactError('Visual publication exceeds manifest budget.');
    const publication=version([archive,plan.runId,sha(manifest)]),identity={videoId:plan.videoId,runId:plan.runId,fileKey:plan.fileKey,index:null,version:publication};
    const makeOverview=()=>Buffer.from(JSON.stringify({version:1,video_id:plan.videoId,duration_seconds:plan.durationMs/1000,sampling_interval_seconds:Math.max(5,plan.durationMs/1000/frames.length),frames}));
    let summary=makeOverview();while(summary.byteLength>MAX_JSON){frames.splice(0,frames.length,...frames.filter((_,index)=>index%2===0));summary=makeOverview();}
    await save({...identity,kind:'overview',key:prefix+'publications/'+publication+'/overview.json'},summary);
    await save({...identity,kind:'manifest',key:prefix+'publications/'+publication+'/manifest.json'},manifest);
   }
   runs++;
  }
  return {path,artifacts:artifacts.toString(),runs:runs.toString(),sha256:planHash.digest('hex'),visual_objects_migrated:false};
 }catch(error){if(error instanceof VisualArtifactError)throw error;throw new VisualArtifactError('Visual source preparation failed.');}
 finally{await file.close();}
}
