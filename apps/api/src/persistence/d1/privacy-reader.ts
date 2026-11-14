import {z} from 'zod';
import {ApiError} from '../../shared/errors';
import {privacyCollections,privacySubject,privacyRequest,type PrivacySubject,type PrivacyInstallation} from '../../shared/privacy';
import {digest} from '../../features/lti/store';
import {privacyReadDefs as defs,privacyScoped as scoped} from './privacy-read-definitions';
type ReadRequest=Exclude<z.infer<typeof privacyRequest>,{action:'erase'}>;
import {prepareD1PrivacyScope,checkD1PrivacyScope} from './privacy-scope';
const changed=()=>new ApiError(409,'CONFLICT','Data changed. Restart the export.');
function base64(raw:unknown):string{
 const bytes=raw instanceof Uint8Array?raw:raw instanceof ArrayBuffer?new Uint8Array(raw):Array.isArray(raw)?Uint8Array.from(raw as number[]):null;
 if(!bytes)throw new Error('Invalid privacy checkpoint encoding');
 const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=32768)chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
 return btoa(chunks.join(''));
}
function binaryData(row:Record<string,unknown>,kind:'checkpoint'|'write'){
 return JSON.stringify(kind==='checkpoint'?{conversationId:row.conversationId,namespace:row.namespace,checkpointId:row.checkpoint_id,parentCheckpointId:row.parent_id,
  type:row.checkpoint_type,encoding:'base64',data:base64(row.checkpoint),metadataType:row.metadata_type,metadata:base64(row.metadata)}:
 {conversationId:row.conversationId,namespace:row.namespace,checkpointId:row.checkpoint_id,taskId:row.task_id,taskPath:row.task_path,index:row.idx,channel:row.channel,type:row.value_type,encoding:'base64',data:base64(row.value)});
}
/** Complete-record reads for the D1 privacy adapter. */
export function createD1PrivacyReader(database:D1Database){
 async function stable<T>(installation:PrivacyInstallation,subjects:PrivacySubject[],contexts:string[]|null,
  build:(query:(subject:PrivacySubject,sql:string,args?:unknown[])=>D1PreparedStatement)=>D1PreparedStatement[],finish:(rows:D1Result<Record<string,unknown>>[])=>T|Promise<T>):Promise<T>{
  for(let attempt=0;attempt<5;attempt++){
   const scope=await prepareD1PrivacyScope(database,installation,subjects,contexts);
   const result=await database.batch<Record<string,unknown>>([scope.check(),...build(scope.query)]);
   if(!checkD1PrivacyScope(result[0].results[0]))continue;
   return finish(result.slice(1));
  }
  throw changed();
 }
 function contextSql(after:string){
  const relevant=privacyCollections.filter(n=>!['evaluations','turns','checkpoints','checkpoint_blobs','checkpoint_writes'].includes(n));
  // Avoid the platform's compound-SELECT limit. Each collection contributes
  // at most 101 distinct candidates after the cursor; their ordered union still
  // contains the first 101 global results without aggregating all history rows.
  const groups=relevant.map(n=>{const d=defs[n];return `json((SELECT json_group_array(context) FROM(
   SELECT DISTINCT ${d.context} AS context FROM ${d.from} WHERE ${scoped(d)} AND ${d.context} COLLATE BINARY>cursor.after
    ORDER BY context COLLATE BINARY LIMIT 101)))`;});
  return {sql:`SELECT DISTINCT item.value AS context FROM (SELECT ? AS after) cursor
   JOIN json_each(json_array(${groups.join(',')})) groups JOIN json_each(groups.value) item ORDER BY context COLLATE BINARY LIMIT 101`,args:[after]};

 }
 return {async execute(installation:PrivacyInstallation,input:ReadRequest):Promise<unknown>{
  const parsed=privacyRequest.safeParse(input);if(!parsed.success||parsed.data.action==='erase')throw new ApiError(400,'VALIDATION_ERROR','Invalid privacy read request.');input=parsed.data;
  if(input.action==='catalog'){
   const s=await privacySubject(installation,'');
   return stable(installation,[s],null,q=>[q(s,`SELECT context FROM(SELECT m.context_id AS context FROM eligible p JOIN lms_courses m ON m.installation_id=p.installation
    UNION SELECT t.context_id FROM eligible p JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=p.installation
    UNION SELECT json_extract(h.payload,'$.contextId') FROM eligible p JOIN lti_credentials h ON h.kind='lti-history' AND json_extract(h.payload,'$.registrationId')=p.registration WHERE json_extract(h.payload,'$.contextId') IS NOT NULL
    UNION SELECT '@orphan' FROM eligible) WHERE context COLLATE BINARY>? ORDER BY context COLLATE BINARY LIMIT 101`,[input.after??''])],rows=>({version:1,collections:privacyCollections,contexts:rows[0].results.slice(0,100).map(r=>r.context),nextAfter:rows[0].results.length>100?rows[0].results[99].context:null}));
  }
  if(input.action==='users'){
   const subjects=await Promise.all(input.subjects.map(s=>privacySubject(installation,s))),c=contextSql('');
   return stable(installation,subjects,input.contexts,q=>subjects.map(s=>q(s,c.sql,c.args)),rows=>({subjects:input.subjects.filter((_,i)=>rows[i].results.length>0)}));
  }
  const s=await privacySubject(installation,input.subject);
  if(input.action==='contexts'){
   const c=contextSql(input.after??'');return stable(installation,[s],null,q=>[q(s,c.sql,c.args)],rows=>({contexts:rows[0].results.slice(0,100).map(r=>r.context),nextAfter:rows[0].results.length>100?rows[0].results[99].context:null}));
  }
  const d=defs[input.collection],point=input.cursor?.record,rawId=point?.id??input.cursor?.after;
  if(input.collection==='conversations'&&rawId&&z.uuid().safeParse(rawId).success)throw changed();
  if(rawId&&((d.cast==='bigint'&&!/^[1-9][0-9]{0,17}$/.test(rawId))||(d.cast==='uuid'&&!z.uuid().safeParse(rawId).success)))throw new ApiError(400,'VALIDATION_ERROR','Invalid export cursor.');
  const id=d.cast==='uuid'?rawId?.toLowerCase():rawId;
  const fields=d.binary==='checkpoint'?'c.conversation_id AS conversationId,k.namespace,k.checkpoint_id,k.parent_id,k.checkpoint_type,k.checkpoint,k.metadata_type,k.metadata':d.binary==='write'?'c.conversation_id AS conversationId,k.namespace,k.checkpoint_id,k.task_id,k.task_path,k.idx,k.channel,k.value_type,k.value':`${d.data} AS data`;
  return stable(installation,[s],input.contexts,q=>[q(s,`SELECT CAST(${d.key} AS TEXT) AS id,${d.context} AS context,${fields} FROM ${d.from} WHERE ${scoped(d)} ${id?`AND ${d.key}${point?'=':'>'}?`:''} ORDER BY ${d.key} LIMIT 1`,id?[id]:[])],async rows=>{
   const row=rows[0].results[0];if(!row){if(point)throw changed();return {part:null,next:null};}
   const data=d.binary?binaryData(row,d.binary):row.data;if(typeof data!=='string')throw new Error('Invalid privacy export data');
   const characters=Array.from(data),revision=await digest(data),total=characters.length;
   if(point&&(point.revision!==revision||point.offset>=total))throw changed();
   const offset=point?.offset??0,nextOffset=Math.min(total,offset+65536);
   return {part:{id:row.id,context:row.context,offset,total,revision,chunk:characters.slice(offset,nextOffset).join('')},next:nextOffset<total?{record:{id:row.id,offset:nextOffset,revision}}:{after:row.id}};
  });
 }};
}
