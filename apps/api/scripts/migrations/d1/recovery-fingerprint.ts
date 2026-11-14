import type {D1Database} from '@cloudflare/workers-types';
import {createHash} from 'node:crypto';
import {migrationBatches} from './batches';
import {quoteMigrationIdentifier as quote} from './manifest';
export class RecoveryProbeError extends Error {readonly name='RecoveryProbeError';}
export type RecoveryFingerprint={tables:{name:string;rows:number;sha256:string}[];sha256:string};
/** Small, synthetic-only staging audit. Stores hashes/counts, never row contents. */
export async function fingerprintRecoveryStaging(database:D1Database):Promise<RecoveryFingerprint>{
 const users=(await database.prepare('SELECT id FROM users ORDER BY id').all<{id:string}>()).results.map(row=>row.id);
 if(JSON.stringify(users)!==JSON.stringify(['migration-rehearsal-learner','migration-rehearsal-owner']))throw new RecoveryProbeError('Recovery probe requires the isolated synthetic rehearsal dataset.');
 const tables=[];
 const catalog=(await database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence') ORDER BY name").all<{name:string;sql:string}>()).results;
 const definitions=await migrationBatches<{name:string}>(database,catalog.map(({name})=>database.prepare(`PRAGMA table_info(${quote(name)})`)));
 const queries=catalog.map(({name},index)=>{const columns=definitions[index].results.map(column=>column.name);if(!columns.length)throw new RecoveryProbeError('Recovery table schema is missing.');return database.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.map(quote).join(',')} LIMIT 1001`);});
 const results=await migrationBatches<Record<string,unknown>>(database,queries);
 for(let index=0;index<catalog.length;index++){
  const {name,sql}=catalog[index],rows=results[index].results,definition=definitions[index].results;
  const content=JSON.stringify({sql,columns:definition,rows});if(rows.length>1000||Buffer.byteLength(content)>10*1024*1024)throw new RecoveryProbeError('Recovery probe exceeds the synthetic dataset budget.');
  tables.push({name,rows:rows.length,sha256:createHash('sha256').update(content).digest('hex')});
 }
 return {tables,sha256:createHash('sha256').update(JSON.stringify(tables)).digest('hex')};
}
