import {readFile,lstat,mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readArchiveLines} from './verify-archive';
import type {VisualArtifact,VisualMigrationSource} from './visual-artifacts';
import {VisualArtifactError} from './visual-artifacts';
export interface VisualMigrationDestination extends VisualMigrationSource {
 /** Atomically create only when absent. Must never overwrite an existing key. */
 create(key:string,bytes:Uint8Array):Promise<void>;
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Copy immutable validated staging artifacts. A lost successful PUT response
 * is recovered by comparing destination bytes on the next invocation. */
export async function copyVisualArtifacts(prepared:{path:string;artifacts:string;sha256:string},destination:VisualMigrationDestination,options:{offlineStaging:true}){
 if(options.offlineStaging!==true)throw new VisualArtifactError('Visual object copying requires offline staging.');
 let copied=0n,retained=0n,total=0n;const directory=await mkdtemp(join(tmpdir(),'.videoq-visual-copy-'));
 try{
  const planInfo=await lstat(prepared.path);if(!planInfo.isFile()||(planInfo.mode&0o077)!==0)throw new VisualArtifactError('A private visual artifact plan is required.');
  const frozen=join(directory,'plan');await copyFile(prepared.path,frozen);await chmod(frozen,0o400);
  const hash=createHash('sha256');let inventory=0n;
  for await(const line of readArchiveLines(frozen)){
   const record=JSON.parse(line.toString()) as VisualArtifact;
   const {path:local,sha256:contentHash,bytes,...identity}=record;
   if(typeof local!=='string'||typeof contentHash!=='string'||!Number.isSafeInteger(bytes))throw new VisualArtifactError('Invalid visual artifact inventory.');
   hash.update(JSON.stringify({...identity,sha256:contentHash,bytes})+'\n');inventory++;
  }
  if(inventory.toString()!==prepared.artifacts||hash.digest('hex')!==prepared.sha256)throw new VisualArtifactError('Visual artifact plan changed after validation.');
  for await(const line of readArchiveLines(frozen)){
   const artifact=JSON.parse(line.toString()) as VisualArtifact,info=await lstat(artifact.path);
   if(!info.isFile()||(info.mode&0o077)!==0||info.size!==artifact.bytes||artifact.bytes<1||artifact.bytes>16*1024*1024)throw new VisualArtifactError('Invalid private visual staging object.');
   const bytes=await readFile(artifact.path);if(sha(bytes)!==artifact.sha256)throw new VisualArtifactError('Visual staging object changed after validation.');
   let existing=await destination.read(artifact.key,artifact.bytes);
   if(existing){if(existing.byteLength!==artifact.bytes||sha(existing)!==artifact.sha256)throw new VisualArtifactError('Destination visual object conflicts with the immutable input.');retained++;}
   else{
    await destination.create(artifact.key,bytes);existing=await destination.read(artifact.key,artifact.bytes);
    if(!existing||existing.byteLength!==artifact.bytes||sha(existing)!==artifact.sha256)throw new VisualArtifactError('Visual object copy could not be verified.');copied++;
   }
   total++;
  }
  if(total.toString()!==prepared.artifacts)throw new VisualArtifactError('Visual artifact inventory changed.');
  return {visual_object_copy_complete:true,visual_objects_migrated:false,copied:copied.toString(),retained:retained.toString(),artifacts:total.toString()};
 }catch(error){if(error instanceof VisualArtifactError)throw error;throw new VisualArtifactError('Visual object copy failed; keep the target offline for retry or inspection.');}
 finally{await rm(directory,{recursive:true,force:true});}
}
