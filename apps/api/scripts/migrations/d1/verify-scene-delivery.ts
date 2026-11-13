import type {buildMigrationManifest} from './manifest';
import {prepareCommonImport} from './prepare-import';
import {lstat,mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {D1Database,Vectorize,VectorizeVector} from '@cloudflare/workers-types';
import type {SceneEmbedding} from '../../../src/persistence/contracts/scene-index';
import {readArchiveLines} from './verify-archive';
export class SceneDeliveryVerificationError extends Error {readonly name='SceneDeliveryVerificationError';}
type SceneRow={scene:SceneEmbedding;videoId:number;userId:string;dimensions:768|1536;revision:string;vectorId:string};
type Indexes={768?:Vectorize;1536?:Vectorize};
/** Read-only full comparison against the original archive's private prepared
 * vectors. Does not infer ANN quality or query visibility from mutation ACKs. */
export async function verifyMigratedSceneVectors(database:D1Database,prepared:{path:string;rows:string},archive:string,indexes:Indexes,options:{offlineStaging:true}){
 if(options.offlineStaging!==true)throw new SceneDeliveryVerificationError('Vector verification requires offline staging.');
 let directory:string|undefined;
 try{
  const info=await lstat(prepared.path);if(!info.isFile()||(info.mode&0o077)!==0)throw new SceneDeliveryVerificationError('Private prepared scene input is required.');
  directory=await mkdtemp(join(tmpdir(),'.videoq-vector-verify-'));const frozen=join(directory,'scenes');await copyFile(prepared.path,frozen);await chmod(frozen,0o400);
  const receipt=await database.prepare("SELECT status,imported_rows FROM migration_imports WHERE id='scenes' AND archive_sha256=?").bind(archive).first<{status:string;imported_rows:number}>();
  if(!receipt||receipt.status!=='scenes_imported'||String(receipt.imported_rows)!==prepared.rows)throw new SceneDeliveryVerificationError('Scene import receipt is missing or incomplete.');
  let checked=0n,verified=0n,missing=0n,mismatched=0n,pending=0n;const dimensions=new Set<number>(),described=new Set<number>();
  const checkD1=async(row:SceneRow)=>{
   const match=await database.prepare(`SELECT t.completed_at,t.lease_token,t.embedding FROM scenes s JOIN videos v ON v.id=s.video_id
    JOIN scene_index_tasks t ON t.id=? AND t.operation='upsert' AND t.scene_id=s.id AND t.dimensions=s.dimensions
      AND t.video_id=s.video_id AND t.user_id=v.user_id AND t.revision=s.revision AND t.vector_id=s.vector_id
    WHERE s.id=? AND s.video_id=? AND s.dimensions=? AND v.user_id=? AND s.content=? COLLATE BINARY
      AND s.start_time=? AND s.end_time=? AND s.evidence_type=? AND s.revision=? AND s.vector_id=?`)
    .bind(`u:${row.dimensions}:${row.vectorId}`,row.scene.id,row.videoId,row.dimensions,row.userId,row.scene.content,row.scene.startTime,row.scene.endTime,row.scene.evidenceType??'transcript',row.revision,row.vectorId)
    .first<{completed_at:string|null;lease_token:string|null;embedding:string|null}>();
   if(!match)throw new SceneDeliveryVerificationError('D1 scene or ownership changed after import.');
   return match.completed_at!==null&&match.lease_token===null&&match.embedding===null;
  };
  let batch:SceneRow[]=[];
  const flush=async()=>{
   if(!batch.length)return;const dimension=batch[0].dimensions,index=indexes[dimension];
   if(!index)throw new SceneDeliveryVerificationError('Required Vectorize binding is missing.');
   if(!described.has(dimension)){if((await index.describe()).dimensions!==dimension)throw new SceneDeliveryVerificationError('Vectorize index dimensions mismatch.');described.add(dimension);}
   const returned=await index.getByIds(batch.map(row=>row.vectorId)),found=new Map<string,VectorizeVector>();
   for(const vector of returned){if(found.has(vector.id)||!batch.some(row=>row.vectorId===vector.id))throw new SceneDeliveryVerificationError('Unexpected or duplicate Vectorize result.');found.set(vector.id,vector);}
   for(const row of batch){
    const delivered=await checkD1(row);if(!delivered)pending++;
    const vector=found.get(row.vectorId);checked++;
    if(!vector){missing++;continue;}
    const metadata=vector.metadata,values=vector.values;
    const same=(!vector.namespace||vector.namespace==='')&&metadata?.user_id===row.userId&&metadata.video_id===row.videoId&&metadata.scene_id===row.scene.id&&metadata.revision===row.revision&&metadata.vector_id===row.vectorId&&
      values.length===row.dimensions&&row.scene.embedding.every((value,index)=>Number.isFinite(values[index])&&Math.fround(values[index])===Math.fround(value));
    if(same)verified++;else mismatched++;
   }
   batch=[];
  };
  for await(const line of readArchiveLines(frozen)){
   const row=JSON.parse(line.toString()) as SceneRow;
   if(![768,1536].includes(row.dimensions)||!Array.isArray(row.scene.embedding)||row.scene.embedding.length!==row.dimensions)throw new SceneDeliveryVerificationError('Invalid prepared scene vector.');
   if(batch.length&&(batch[0].dimensions!==row.dimensions||batch.length===20))await flush();batch.push(row);dimensions.add(row.dimensions);
  }
  await flush();
  // Source ownership is checked again after all provider calls, since provider
  // callbacks may be delayed. Offline staging must hold throughout the audit.
  let finalPending=0n;for await(const line of readArchiveLines(frozen)){if(!await checkD1(JSON.parse(line.toString()) as SceneRow))finalPending++;}
  if(finalPending!==pending)throw new SceneDeliveryVerificationError('Scene delivery state changed during verification.');
  const counts=await database.prepare("SELECT (SELECT count(*) FROM scenes) AS scenes,(SELECT count(*) FROM scene_index_tasks) AS tasks,EXISTS(SELECT 1 FROM migration_imports WHERE id='scenes' AND archive_sha256=? AND status='scenes_imported' AND imported_rows=?) AS receipt").bind(archive,Number(prepared.rows)).first<{scenes:number;tasks:number;receipt:number}>();
  if(!counts?.receipt||checked.toString()!==prepared.rows||String(counts?.scenes)!==prepared.rows||String(counts?.tasks)!==prepared.rows)throw new SceneDeliveryVerificationError('Scene vector inventory mismatch.');
  return {vectorize_delivery_complete:missing===0n&&mismatched===0n&&pending===0n,checked:checked.toString(),verified:verified.toString(),missing:missing.toString(),mismatched:mismatched.toString(),pending_tasks:pending.toString(),dimensions:[...dimensions].sort((a,b)=>a-b),search_quality_verified:false,execution_complete:false};
 }catch(error){if(error instanceof SceneDeliveryVerificationError)throw error;throw new SceneDeliveryVerificationError('Scene vector verification failed; keep the target offline for retry or inspection.');}
 finally{if(directory)await rm(directory,{recursive:true,force:true});}
}

/** Rebuild expectations from a verified immutable archive after the importer has
 * disposed its staging files. This does not re-import or reset delivered tasks. */
export async function verifyArchiveSceneDelivery(database:D1Database,input:string,manifest:ReturnType<typeof buildMigrationManifest>,indexes:Indexes,options:{offlineStaging:true}){
 if(options.offlineStaging!==true)throw new SceneDeliveryVerificationError('Vector verification requires offline staging.');
 const prepared=await prepareCommonImport(input,manifest);
 try{return await verifyMigratedSceneVectors(database,prepared.scenes,prepared.verified.archive_sha256,indexes,options);}
 finally{await prepared.dispose();}
}
