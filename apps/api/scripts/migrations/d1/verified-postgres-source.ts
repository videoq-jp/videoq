import pg from 'pg';
import {createHash} from 'node:crypto';
import {mkdtemp,copyFile,chmod,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {buildMigrationManifest} from './manifest';
import {exportPostgresArchive} from './export';
import {verifyPostgresArchive} from './verify-archive';
import {validateReadSnapshot} from '../../../src/persistence/postgres/read-snapshot';
type Manifest=ReturnType<typeof buildMigrationManifest>;
type Verified=Awaited<ReturnType<typeof verifyPostgresArchive>>;
export class PostgresSourceVerificationError extends Error {readonly name='PostgresSourceVerificationError';}

/** Compare normalized row bytes AND layouts, rather than timestamped whole-file
 * hashes. An isolated source schema may be restored as public, so only that root
 * schema name is normalized; auxiliary schema names remain exact. */
function fingerprint(archive: Verified) {
 const root=(schema: string)=>schema===archive.source_schema?'source':`auxiliary:${schema}`;
 const tables=archive.table_layouts.map(layout=>{
  const summary=archive.table_summaries.find(table=>table.schema===layout.schema&&table.table===layout.table);
  if(!summary)throw new PostgresSourceVerificationError('Incomplete verified table inventory.');
  return {schema:root(layout.schema),table:layout.table,mode:layout.mode,columns:layout.columns,
   primary_key:layout.primary_key,rows:summary.rows,sha256:summary.sha256};
 }).sort((a,b)=>JSON.stringify([a.schema,a.table]).localeCompare(JSON.stringify([b.schema,b.table])));
 return createHash('sha256').update(JSON.stringify({tables,migration_history:archive.migration_history})).digest('hex');
}

/** Keep the coordinator open until every evaluation consumer is closed. Its
 * exported snapshot is used for both verification export and PG search. No
 * source records/credentials are returned in the proof or error messages. */
export async function openVerifiedPostgresSource(options:{connectionString:string;archivePath:string;manifest:Manifest;sourceSchema?:string}) {
 let directory:string|undefined,coordinator:pg.Client|undefined,reader:pg.Client|undefined,closed=false,unavailable=false;
 const dispose=async()=>{
  if(closed)return;closed=true;
  try{await reader?.end().catch(()=>undefined);}
  finally{try{await coordinator?.query('ROLLBACK').catch(()=>undefined);await coordinator?.end().catch(()=>undefined);}
   finally{if(directory)await rm(directory,{recursive:true,force:true});}}
 };
 try{
  const info=await lstat(options.archivePath);
  if(!info.isFile()||(info.mode&0o077)!==0)throw new PostgresSourceVerificationError('Private source archive is required.');
  directory=await mkdtemp(join(tmpdir(),'.videoq-source-proof-'));
  const expectedPath=join(directory,'expected.videoq-export.ndjson'),actualPath=join(directory,'actual.videoq-export.ndjson');
  await copyFile(options.archivePath,expectedPath);await chmod(expectedPath,0o400);
  const expected=await verifyPostgresArchive(expectedPath,options.manifest);
  coordinator=new pg.Client({connectionString:options.connectionString,connectionTimeoutMillis:10000,statement_timeout:300000,application_name:'videoq-search-snapshot'});
  coordinator.on('error',()=>{unavailable=true;});
  await coordinator.connect();
  await coordinator.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await coordinator.query("SET LOCAL idle_in_transaction_session_timeout='20min'");
  const snapshot=(await coordinator.query<{snapshot:string}>('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  validateReadSnapshot(snapshot);
  reader=new pg.Client({connectionString:options.connectionString,connectionTimeoutMillis:10000,application_name:'videoq-search-source-verification'});
  reader.on('error',()=>undefined);
  await reader.connect();
  await exportPostgresArchive(reader,options.manifest,actualPath,{schema:options.sourceSchema??'public',snapshot,statementTimeoutMs:300000});
  const actual=await verifyPostgresArchive(actualPath,options.manifest),expectedFingerprint=fingerprint(expected);
  if(fingerprint(actual)!==expectedFingerprint)throw new PostgresSourceVerificationError('Source snapshot rows or layouts differ from the migration archive.');
  await reader.end();reader=undefined;
  const assertLive=async()=>{
   if(closed||unavailable||!coordinator)throw new PostgresSourceVerificationError('Source verification snapshot is closed or unavailable.');
   try{
    const state=(await coordinator.query<{isolation:string;readonly:string}>("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly")).rows[0];
    if(state.isolation!=='repeatable read'||state.readonly!=='on')throw new Error();
   }catch{throw new PostgresSourceVerificationError('Source verification snapshot is unavailable.');}
  };
  await assertLive();
  return {snapshot,archiveSha256:expected.archive_sha256,proof:{source_snapshot_equality_verified:true,
   source_rows_and_layouts_sha256:expectedFingerprint,source_tables_verified:expected.tables,
   source_rows_verified:expected.rows,source_catalog_constraints_verified:false,source_sequence_state_verified:false,
   source_verification_scope:'Mapped tables including auxiliary rows, normalized row values, columns, primary-key layouts and Drizzle migration history. Sequence state, other catalog constraints and external objects are excluded.'},
   assertLive,dispose};
 }catch(error){
  await dispose();
  if(error instanceof PostgresSourceVerificationError)throw error;
  throw new PostgresSourceVerificationError('PostgreSQL source verification failed; inspect private archive, schema coverage, snapshot access and permissions.');
 }
}
