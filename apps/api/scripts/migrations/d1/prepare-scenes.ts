import {DatabaseSync} from 'node:sqlite';
import {chmod,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {sceneVectorId} from '../../../src/persistence/d1/scene-index-writer';
import type {SceneEmbedding} from '../../../src/persistence/contracts/scene-index';
import type {PreparedTable,PreparedSpecialTable} from './prepare-import';
import {convertMigrationValue} from './manifest';
import {readArchiveLines} from './verify-archive';
export class SceneMigrationError extends Error {readonly name='SceneMigrationError';}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown)=>{if(typeof value!=='string')throw new SceneMigrationError('Missing scene source text.');return value;};
/** Source IDs are retained; vector IDs are immutable versions shared with the live writer. */
export function convertSceneRow(columns:string[],values:unknown[],dimensions:768|1536){
 const get=(name:string)=>values[columns.indexOf(name)];
 const id=convertMigrationValue(get('langchain_id'),'uuid',false) as string;
 const videoId=convertMigrationValue(get('video_id'),'safe_integer',false) as number,userId=text(get('user_id'));
 if(!userId||videoId<1)throw new SceneMigrationError('Invalid scene ownership.');
 const embedding:unknown=JSON.parse(text(get('embedding')));
 if(!Array.isArray(embedding)||embedding.length!==dimensions||!embedding.every(value=>typeof value==='number'&&Number.isFinite(value)&&Number.isFinite(Math.fround(value)))||!embedding.some((value:unknown)=>typeof value==='number'&&Math.fround(value)!==0))throw new SceneMigrationError('Invalid scene vector.');
 const raw=get('langchain_metadata'),metadata:unknown=raw===null?{}:JSON.parse(text(raw));
 if(!record(metadata))throw new SceneMigrationError('Invalid scene metadata.');
 if(metadata.video_id!==undefined&&metadata.video_id!==videoId||metadata.user_id!==undefined&&metadata.user_id!==userId)throw new SceneMigrationError('Scene metadata ownership mismatch.');
 const time=(key:string)=>metadata[key]===undefined||metadata[key]===null?'':text(metadata[key]);
 const evidence=metadata.evidence_type??'transcript';if(evidence!=='transcript'&&evidence!=='visual')throw new SceneMigrationError('Invalid scene evidence type.');
 const scene:SceneEmbedding={id,content:text(get('content')),startTime:time('start_time'),endTime:time('end_time'),evidenceType:evidence,embedding:embedding as number[]};
 if(Buffer.byteLength(JSON.stringify(scene))>1_000_000)throw new SceneMigrationError('Scene exceeds target staging budget.');
 return {scene,videoId,userId,dimensions};
}
/** Bounded disk-backed preparation, performed before any target writes. The
 * output is private staging input, not a receipt that Vectorize has indexed it. */
export async function prepareSceneImport(common:PreparedTable[],special:PreparedSpecialTable[],archive:string,directory:string){
 const sources=special.filter(table=>table.name==='scene_embeddings'||table.name==='scene_embeddings_768');
 const database=new DatabaseSync(join(directory,'scene-source.sqlite'));await chmod(join(directory,'scene-source.sqlite'),0o600);
 const output=join(directory,'prepared-scenes');let file:Awaited<ReturnType<typeof open>>|undefined;
 try{
  database.exec('BEGIN; CREATE TABLE owners(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL); CREATE TABLE identities(id TEXT,dimensions INTEGER,PRIMARY KEY(id,dimensions));');
  const videos=common.find(table=>table.name==='videos');
  if(videos){const insert=database.prepare('INSERT INTO owners VALUES(?,?)');for await(const line of readArchiveLines(videos.path)){const {values}=JSON.parse(line.toString()) as {values:(string|number|null)[]};insert.run(values[videos.columns.indexOf('id')],values[videos.columns.indexOf('user_id')]);}}
  file=await open(output,'wx',0o600);const owner=database.prepare('SELECT user_id FROM owners WHERE id=?'),identity=database.prepare('INSERT INTO identities VALUES(?,?)');let rows=0n;
  for(const source of sources){
   const expected=['langchain_id','content','embedding','user_id','video_id','langchain_metadata'];
   if(source.columns.length!==expected.length||expected.some(name=>!source.columns.includes(name)))throw new SceneMigrationError('Unsupported scene source columns.');
   const dimensions=source.name==='scene_embeddings'?1536:768;
   for await(const line of readArchiveLines(source.path)){
    const {values}=JSON.parse(line.toString()) as {values:unknown[]},converted=convertSceneRow(source.columns,values,dimensions);
    if((owner.get(converted.videoId) as {user_id:string}|undefined)?.user_id!==converted.userId)throw new SceneMigrationError('Scene video ownership is missing or inconsistent.');
    identity.run(converted.scene.id,dimensions);
    const revision=createHash('sha256').update(JSON.stringify(['offline-scenes-v1',archive,converted.videoId,dimensions])).digest('hex');
    const vectorId=await sceneVectorId(revision,converted.scene);
    await file.writeFile(JSON.stringify({...converted,revision,vectorId})+'\n');rows++;
   }
  }
  database.exec('COMMIT');
  return {path:output,rows:rows.toString(),prepared:true,vectorize_delivery_complete:false};
 }catch(error){if(error instanceof SceneMigrationError)throw error;throw new SceneMigrationError('Scene archive reconstruction failed.');}
 finally{await file?.close();database.close();}
}
