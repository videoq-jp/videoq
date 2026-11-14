import {DatabaseSync} from 'node:sqlite';
import {chmod,open} from 'node:fs/promises';
import {join} from 'node:path';
import {isSafeMediaPath} from '../../../src/shared/media-path';
import {convertMigrationValue} from './manifest';
import type {PreparedTable} from './prepare-import';
import {readArchiveLines} from './verify-archive';
export class VisualMigrationError extends Error {readonly name='VisualMigrationError';}
export type VisualMigrationPlan={videoId:number;runId:string;fileKey:string;durationMs:number;chunkCount:number;status:'processing'|'ready'|'error';chunks:{index:number;frameCount:number|null}[]};
const text=(value:unknown)=>{if(typeof value!=='string')throw new VisualMigrationError('Missing visual source text.');return value;};
/** Freeze the source relationships on private disk. Existing source objects must
 * be validated and copied before these legacy rows can be published by D1. */
export async function prepareVisualImport(common:PreparedTable[],directory:string){
 const runsTable=common.find(table=>table.name==='video_visual_runs'),chunksTable=common.find(table=>table.name==='video_visual_chunks');
 if(!runsTable||!chunksTable||!common.some(table=>table.name==='videos'))throw new VisualMigrationError('Visual source tables are missing.');
 if(runsTable.rows==='0'){
  if(chunksTable.rows!=='0')throw new VisualMigrationError('Visual chunk ownership is missing or inconsistent.');
  const path=join(directory,'prepared-visual-plans'),empty=await open(path,'wx',0o600);await empty.close();
  return {path,runs:'0',ready_runs:'0',completed_chunks:'0',visual_objects_migrated:false};
 }
 const local=join(directory,'visual-source.sqlite'),database=new DatabaseSync(local);await chmod(local,0o600);
 let file:Awaited<ReturnType<typeof open>>|undefined;
 try{
  database.exec(`BEGIN; CREATE TABLE videos(id INTEGER PRIMARY KEY,file TEXT,source TEXT);
   CREATE TABLE runs(video INTEGER PRIMARY KEY,id TEXT UNIQUE,file TEXT,duration INTEGER,count INTEGER,status TEXT);
   CREATE TABLE chunks(run TEXT,idx INTEGER,frames INTEGER,PRIMARY KEY(run,idx));`);
  for(const name of ['videos','video_visual_runs','video_visual_chunks']){
   const table=common.find(table=>table.name===name);if(!table)throw new VisualMigrationError('Visual source tables are missing.');
   const insert=database.prepare(name==='videos'?'INSERT INTO videos VALUES(?,?,?)':name==='video_visual_runs'?'INSERT INTO runs VALUES(?,?,?,?,?,?)':'INSERT INTO chunks VALUES(?,?,?)');
   for await(const line of readArchiveLines(table.path)){
    const {values}=JSON.parse(line.toString()) as {values:unknown[]};const get=(key:string)=>values[table.columns.indexOf(key)];
    if(name==='videos')insert.run(get('id') as number,text(get('file')),text(get('source_type')));
    else if(name==='video_visual_runs'){
     const run=convertMigrationValue(get('run_id'),'uuid',false) as string,video=get('video_id'),duration=get('duration_ms'),count=get('chunk_count'),status=get('status'),key=text(get('file_key'));
     if(!Number.isSafeInteger(video)||Number(video)<1||!Number.isSafeInteger(duration)||Number(duration)<=0||Number(duration)>36_000_000||count!==Math.ceil(Number(duration)/60_000)||!['processing','ready','error'].includes(String(status))||!isSafeMediaPath(key))throw new VisualMigrationError('Invalid visual run identity or plan.');
     insert.run(video as number,run,key,duration as number,count,text(status));
    }else{
     const run=convertMigrationValue(get('run_id'),'uuid',false) as string,index=get('chunk_index'),frames=get('frame_count');
     if(!Number.isSafeInteger(index)||Number(index)<0||Number(index)>599||frames!==null&&(!Number.isSafeInteger(frames)||Number(frames)<0||Number(frames)>60))throw new VisualMigrationError('Invalid visual chunk checkpoint.');
     insert.run(run,index as number,frames as number|null);
    }
   }
  }
  if(database.prepare("SELECT 1 FROM runs r LEFT JOIN videos v ON v.id=r.video WHERE v.id IS NULL OR v.file<>r.file OR v.source<>'uploaded' LIMIT 1").get())throw new VisualMigrationError('Visual run no longer matches its video.');
  if(database.prepare('SELECT 1 FROM chunks c LEFT JOIN runs r ON r.id=c.run WHERE r.id IS NULL OR c.idx>=r.count LIMIT 1').get())throw new VisualMigrationError('Visual chunk ownership is missing or inconsistent.');
  if(database.prepare('SELECT 1 FROM runs r WHERE r.count<>(SELECT count(*) FROM chunks c WHERE c.run=r.id) LIMIT 1').get())throw new VisualMigrationError('Visual chunk grid is incomplete.');
  if(database.prepare("SELECT 1 FROM runs r WHERE r.status='ready' AND (EXISTS(SELECT 1 FROM chunks c WHERE c.run=r.id AND c.frames IS NULL) OR (SELECT coalesce(sum(frames),0) FROM chunks c WHERE c.run=r.id)=0) LIMIT 1").get())throw new VisualMigrationError('Ready visual run has incomplete or empty frames.');
  const path=join(directory,'prepared-visual-plans');file=await open(path,'wx',0o600);let runs=0n,completedChunks=0n,readyRuns=0n;
  const chunks=database.prepare('SELECT idx AS "index",frames AS frameCount FROM chunks WHERE run=? ORDER BY idx');
  for(const raw of database.prepare('SELECT video AS videoId,id AS runId,file AS fileKey,duration AS durationMs,count AS chunkCount,status FROM runs ORDER BY video').iterate()){
   const run=raw as unknown as Omit<VisualMigrationPlan,'chunks'>,grid=chunks.all(run.runId) as unknown as VisualMigrationPlan['chunks'];
   const plan:VisualMigrationPlan={...run,chunks:grid};await file.writeFile(JSON.stringify(plan)+'\n');runs++;if(run.status==='ready')readyRuns++;completedChunks+=BigInt(grid.filter(chunk=>chunk.frameCount!==null).length);
  }
  database.exec('COMMIT');return {path,runs:runs.toString(),ready_runs:readyRuns.toString(),completed_chunks:completedChunks.toString(),visual_objects_migrated:false};
 }catch(error){if(error instanceof VisualMigrationError)throw error;throw new VisualMigrationError('Visual archive relationship validation failed.');}
 finally{await file?.close();database.close();}
}
