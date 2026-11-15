import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {STAGING_DATABASE_ID} from './staging-target';
export class RealRecoveryError extends Error {readonly name='RealRecoveryError';}
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint=z.object({tables:z.array(z.string().min(1)).min(1),data_sha256:sha,data_bytes:z.number().int().positive(),schema_sha256:sha,sequences_sha256:sha}).strict();
export const realRecoveryStateSchema=z.object({version:z.literal(1),database_id:z.literal(STAGING_DATABASE_ID),archive_sha256:sha,nonce:z.uuid(),bookmark:z.string().regex(/^[a-f0-9-]{16,256}$/),created_at:z.iso.datetime(),snapshot:fingerprint}).strict();
export type RealRecoveryState=z.infer<typeof realRecoveryStateSchema>;
export type RecoverySnapshot=z.infer<typeof fingerprint>&{probe:{token:string;kind:string;resource_id:number;effect_applied:number}[]};
export interface RealRecoveryProvider {
 assertQuiescent():Promise<void>;
 snapshot():Promise<RecoverySnapshot>;
 bookmark():Promise<string>;
 insertProbe(nonce:string):Promise<void>;
 restore(bookmark:string):Promise<void>;
}
const fail=(message:string):never=>{throw new RealRecoveryError(message);};
const base=(snapshot:RecoverySnapshot)=>fingerprint.parse({tables:snapshot.tables,data_sha256:snapshot.data_sha256,data_bytes:snapshot.data_bytes,schema_sha256:snapshot.schema_sha256,sequences_sha256:snapshot.sequences_sha256});
function matches(snapshot:RecoverySnapshot,state:RealRecoveryState){
 if(JSON.stringify(base(snapshot))!==JSON.stringify(state.snapshot))fail('Recovery target data, schema or sequences changed outside the probe.');
}
function ownedProbe(snapshot:RecoverySnapshot,state:RealRecoveryState){
 if(snapshot.probe.length!==1||snapshot.probe[0].token!==state.nonce||snapshot.probe[0].kind!=='migration_recovery_probe'||snapshot.probe[0].resource_id!==0||snapshot.probe[0].effect_applied!==0)fail('Recovery probe ownership does not match.');
}
export async function prepareRealRecovery(provider:RealRecoveryProvider,archiveSha256:string){
 if(!sha.safeParse(archiveSha256).success)fail('Invalid recovery archive fingerprint.');
 await provider.assertQuiescent();const first=await provider.snapshot(),second=await provider.snapshot();
 if(first.probe.length||second.probe.length||JSON.stringify(base(first))!==JSON.stringify(base(second)))fail('A stable, empty-probe recovery baseline is required.');
 // Bookmarks can advance due to platform maintenance without changing row data.
 // Equality is proved using export bytes, schema and sequence values instead.
 const bookmark=await provider.bookmark();await provider.assertQuiescent();
 return realRecoveryStateSchema.parse({version:1,database_id:STAGING_DATABASE_ID,archive_sha256:archiveSha256,nonce:randomUUID(),bookmark,created_at:new Date().toISOString(),snapshot:base(second)});
}
export async function runRealRecoveryPhase(provider:RealRecoveryProvider,raw:unknown,archiveSha256:string,phase:'mutate'|'restore'|'verify'){
 const parsed=realRecoveryStateSchema.safeParse(raw);if(!parsed.success||parsed.data.archive_sha256!==archiveSha256)fail('Recovery state does not match this dedicated target and archive.');const state=parsed.data!;
 await provider.assertQuiescent();const before=await provider.snapshot();matches(before,state);
 if(phase==='mutate'){
  if(before.probe.length)ownedProbe(before,state);else await provider.insertProbe(state.nonce);
  const after=await provider.snapshot();matches(after,state);ownedProbe(after,state);
  return {recovery_probe_verified:true,existing_probe_reused:before.probe.length===1,production_modified:false,execution_complete:false};
 }
 let acknowledged=false;
 if(phase==='restore'&&before.probe.length){ownedProbe(before,state);await provider.restore(state.bookmark);acknowledged=true;}
 else if(before.probe.length)fail('Recovery probe still exists; restore has not completed.');
 const after=await provider.snapshot();matches(after,state);if(after.probe.length)fail('Recovery probe was not removed by restore.');
 await provider.assertQuiescent();
 return {recovery_snapshot_verified:true,provider_restore_acknowledged:acknowledged,all_original_tables_verified:after.tables.length+1,sql_export_bytes_verified:after.data_bytes,original_schema_and_sequences_verified:true,probe_absent:true,production_modified:false,execution_complete:false};
}
