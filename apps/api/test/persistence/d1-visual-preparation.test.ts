import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {prepareVisualImport} from '../../scripts/migrations/d1/prepare-visuals';
import type {PreparedTable} from '../../scripts/migrations/d1/prepare-import';
const run='00000000-0000-4000-8000-000000000003';
describe('private visual migration relationship plans',()=>{
 let directory:string,tables:PreparedTable[];
 const write=async(name:string,columns:string[],rows:unknown[][])=>{const path=join(directory,name);await writeFile(path,rows.map(values=>JSON.stringify({kind:'row',values})+'\n').join(''),{mode:0o600});const table={name,columns,path,rows:String(rows.length)},index=tables.findIndex(table=>table.name===name);if(index<0)tables.push(table);else tables[index]=table;};
 const video=()=>write('videos',['id','file','source_type'],[[1,'private/video.mp4','uploaded']]);
 const visual=async(status='ready',frames:(number|null)[]=[1,0])=>{
  await write('video_visual_runs',['video_id','run_id','file_key','duration_ms','chunk_count','status'],[[1,run,'private/video.mp4',61000,2,status]]);
  await write('video_visual_chunks',['run_id','chunk_index','frame_count'],frames.map((count,index)=>[run,index,count]));
 };
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'visual-preparation-'));tables=[];await video();await visual();});
 afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
 const prepare=()=>prepareVisualImport(tables,directory);
 it('retains completed empty chunks and produces a bounded per-run private plan',async()=>{
  const result=await prepare();expect(result).toMatchObject({runs:'1',ready_runs:'1',completed_chunks:'2',visual_objects_migrated:false});
  expect(JSON.parse(await readFile(result.path,'utf8'))).toEqual({videoId:1,runId:run,fileKey:'private/video.mp4',durationMs:61000,chunkCount:2,status:'ready',chunks:[{index:0,frameCount:1},{index:1,frameCount:0}]});expect((await stat(result.path)).mode&0o777).toBe(0o600);
 });
 it.each(['processing','error'])('retains unfinished %s checkpoints without pretending objects are migrated',async status=>{await visual(status,[1,null]);const result=await prepare();expect(result).toMatchObject({ready_runs:'0',completed_chunks:'1',visual_objects_migrated:false});expect(JSON.parse(await readFile(result.path,'utf8')).chunks[1].frameCount).toBeNull();});
 it.each(['stale-file','wrong-source','missing-video','wrong-count','missing-chunk','orphan-chunk','out-of-range','unready','empty-ready','unsafe-path','bad-frames'] as const)('rejects %s source before generating a usable plan',async kind=>{
  if(kind==='stale-file')await write('videos',['id','file','source_type'],[[1,'other.mp4','uploaded']]);
  if(kind==='wrong-source')await write('videos',['id','file','source_type'],[[1,'private/video.mp4','youtube']]);
  if(kind==='missing-video')await write('videos',['id','file','source_type'],[]);
  if(kind==='wrong-count'||kind==='unsafe-path')await write('video_visual_runs',['video_id','run_id','file_key','duration_ms','chunk_count','status'],[[1,run,kind==='unsafe-path'?'../private-canary.mp4':'private/video.mp4',61000,kind==='wrong-count'?1:2,'ready']]);
  if(kind==='missing-chunk')await visual('processing',[1]);
  if(kind==='orphan-chunk')await write('video_visual_chunks',['run_id','chunk_index','frame_count'],[['00000000-0000-4000-8000-000000000004',0,1],[run,1,0]]);
  if(kind==='out-of-range')await write('video_visual_chunks',['run_id','chunk_index','frame_count'],[[run,0,1],[run,2,0]]);
  if(kind==='unready')await visual('ready',[1,null]);
  if(kind==='empty-ready')await visual('ready',[0,0]);
  if(kind==='bad-frames')await visual('processing',[61,null]);
  const error=await prepare().then(()=>null,error=>error);expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('private-canary');
 });
 it('supports an archive with no visual runs',async()=>{await write('video_visual_runs',['video_id','run_id','file_key','duration_ms','chunk_count','status'],[]);await write('video_visual_chunks',['run_id','chunk_index','frame_count'],[]);const result=await prepare();expect(result).toMatchObject({runs:'0',completed_chunks:'0',visual_objects_migrated:false});expect(await readFile(result.path,'utf8')).toBe('');});
});
