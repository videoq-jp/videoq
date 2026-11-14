import type {D1Database,Vectorize} from '@cloudflare/workers-types';
import {join} from 'node:path';
import type {buildMigrationManifest} from './manifest';
import {prepareCommonImport} from './prepare-import';
import {importCommonTables} from './import-common';
import {verifyMigratedSceneVectors} from './verify-scene-delivery';
import {synchronizeD1SceneIndex} from '../../../src/persistence/d1/scene-index-sync';
export type StagingBindings={DB:D1Database;SCENE_VECTORIZE_768:Vectorize;SCENE_VECTORIZE_1536:Vectorize};
export class StagingMigrationError extends Error {readonly name='StagingMigrationError';}
export function parseStagingMigrationArguments(args:string[]){
 const values=new Map<string,string>();let pendingVisuals=false;
 for(let index=0;index<args.length;index++){
  const key=args[index];if(key==='--allow-pending-visuals'){if(pendingVisuals)throw new StagingMigrationError('Duplicate staging migration option.');pendingVisuals=true;continue;}
  if(!['--input','--mode','--max-tasks'].includes(key)||values.has(key)||!args[index+1]||args[index+1].startsWith('--'))throw new StagingMigrationError('Use --mode import|deliver|verify --input <private archive> [--max-tasks 1..10000] [--allow-pending-visuals].');
  values.set(key,args[++index]);
 }
 const mode=values.get('--mode'),input=values.get('--input'),rawLimit=values.get('--max-tasks')??'100';
 if(!input||!['import','deliver','verify'].includes(mode??'')||!/^\d+$/.test(rawLimit))throw new StagingMigrationError('Invalid staging migration arguments.');
 const maxTasks=Number(rawLimit);if(!Number.isSafeInteger(maxTasks)||maxTasks<1||maxTasks>10000||mode!=='deliver'&&values.has('--max-tasks')||mode!=='import'&&pendingVisuals)throw new StagingMigrationError('Invalid staging migration option for this phase.');
 return {mode:mode as 'import'|'deliver'|'verify',input,maxTasks,allowPendingVisuals:pendingVisuals};
}
/** prepare/verify the frozen input before connecting to the remote target. */
export async function runStagingMigration(options:ReturnType<typeof parseStagingMigrationArguments>,manifest:ReturnType<typeof buildMigrationManifest>,connect:()=>Promise<{env:StagingBindings;dispose:()=>Promise<void>}>){
 const prepared=await prepareCommonImport(options.input,manifest);
 try{
  if(options.mode==='import'&&prepared.visuals.runs!=='0'&&!options.allowPendingVisuals)throw new StagingMigrationError('Archive has visual objects; configure visual migration separately or explicitly allow pending visuals.');
  const proxy=await connect();
  try{
   const {DB:db,SCENE_VECTORIZE_768:small,SCENE_VECTORIZE_1536:large}=proxy.env,indexes={768:small,1536:large},archive=prepared.verified.archive_sha256;
   if(options.mode==='import')return {phase:'import',...await importCommonTables(db,join(prepared.directory,'source.videoq-export.ndjson'),manifest,{offlineStaging:true})};
   const receipt=await db.prepare("SELECT imported_rows FROM migration_imports WHERE id='scenes' AND status='scenes_imported' AND archive_sha256=?").bind(archive).first<{imported_rows:number}>();
   if(!receipt||String(receipt.imported_rows)!==prepared.scenes.rows)throw new StagingMigrationError('The target has no completed scene import for this archive.');
   if(options.mode==='verify')return {phase:'verify',...await verifyMigratedSceneVectors(db,prepared.scenes,archive,indexes,{offlineStaging:true})};
   const result={claimed:0,completed:0,failed:0,leaseLost:0};
   while(result.claimed<options.maxTasks){const batch=await synchronizeD1SceneIndex(db,indexes,Math.min(100,options.maxTasks-result.claimed),{concurrency:4});for(const field of ['claimed','completed','failed','leaseLost'] as const)result[field]+=batch[field];if(!batch.claimed||batch.failed||batch.leaseLost)break;}
   const pending=await db.prepare('SELECT count(*) AS count FROM scene_index_tasks WHERE completed_at IS NULL').first<{count:number}>();
   return {phase:'deliver',...result,pending_tasks:pending?.count??0,vectorize_delivery_complete:false,search_quality_verified:false,execution_complete:false};
  }finally{await proxy.dispose();}
 }finally{await prepared.dispose();}
}

/** Exit 2 means a retryable verification/delivery gate is not satisfied. */
export function stagingMigrationExitCode(result:{phase?:unknown;vectorize_delivery_complete?:unknown;failed?:unknown;leaseLost?:unknown}){
 if(result.phase==='verify'&&result.vectorize_delivery_complete!==true)return 2;
 if(result.phase==='deliver'&&(typeof result.failed==='number'&&result.failed>0||typeof result.leaseLost==='number'&&result.leaseLost>0))return 2;
 return 0;
}
