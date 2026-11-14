import {copyPrivateInput} from './private-input';
import {chmod,mkdtemp,open,rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareVisualImport} from './prepare-visuals';
import {prepareSceneImport} from './prepare-scenes';
import {prepareCheckpointImport} from './prepare-checkpoints';
import {planSequenceRestore} from './restore-sequences';
import {verifyPostgresArchive,readArchiveLines} from './verify-archive';
import type {buildMigrationManifest} from './manifest';
type Manifest=ReturnType<typeof buildMigrationManifest>;
export type PreparedTable={name:string;columns:string[];path:string;rows:string};
export type PreparedSpecialTable=PreparedTable&{schema:string;types:string[]};
/** Freeze a private copy before verification. Subsequent source-file edits cannot
 * change the imported rows. The working directory must never be published. */
export async function prepareCommonImport(input:string,manifest:Manifest){
 const directory=await mkdtemp(join(tmpdir(),'.videoq-import-'));let file:FileHandle|undefined;
 try{
  const copy=join(directory,'source.videoq-export.ndjson');await copyPrivateInput(input,copy);
  const verified=await verifyPostgresArchive(copy,manifest),sequences=planSequenceRestore(verified.sequence_states,manifest);await chmod(copy,0o400);
  const tables:PreparedTable[]=[],specialTables:PreparedSpecialTable[]=[];let current:PreparedTable|undefined,special=false,pendingSpecialRows=0n;
  for await(const line of readArchiveLines(copy)){
   const frame=JSON.parse(line.toString('utf8')) as {kind:string;mode?:string;table?:string;schema?:string;columns?:{name:string;type:string}[];rows?:string};
   if(frame.kind==='table_start'){
    special=frame.mode!=='converted';current={name:frame.table!,columns:frame.columns!.map(column=>column.name),path:join(directory,(special?'special-':'table-')+(special?specialTables.length:tables.length)),rows:'0'};
    if(special)specialTables.push(Object.assign(current,{schema:frame.schema!,types:frame.columns!.map(column=>column.type)}));else tables.push(current);
    file=await open(current.path,'wx',0o600);
   }else if(frame.kind==='row'&&file)await file.writeFile(line);
   else if(frame.kind==='table_end'&&file&&current){current.rows=frame.rows!;if(special)pendingSpecialRows+=BigInt(frame.rows!);await file.close();file=undefined;current=undefined;}

  }
  const checkpoints=await prepareCheckpointImport(tables,specialTables,manifest,directory);
  const scenes=await prepareSceneImport(tables,specialTables,verified.archive_sha256,directory);
  const visuals=await prepareVisualImport(tables,directory);
  return {directory,verified,tables,special_tables:specialTables,sequences,checkpoints,scenes,visuals,pending_special_rows:(pendingSpecialRows-BigInt(checkpoints.handled_source_rows)).toString(),dispose:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await file?.close();await rm(directory,{recursive:true,force:true});throw error;}
}
