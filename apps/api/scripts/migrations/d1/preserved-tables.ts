import type pg from 'pg';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {openPrivateInput,readPrivateInput} from './private-input';
import {buildMigrationManifest,quoteMigrationIdentifier as quote} from './manifest';
type Manifest=ReturnType<typeof buildMigrationManifest>;
const sha=z.string().regex(/^[a-f0-9]{64}$/),base64=z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const identifier=z.string().min(1).max(63).refine(value=>!value.includes('\0'));
const count=z.string().regex(/^(0|[1-9][0-9]*)$/);
export const preservedTablePolicySchema=z.object({version:z.literal(1),purpose:z.literal('preserve-legacy-outside-d1'),source_schema:identifier,mapping_sha256:sha,
 backup:z.object({run_id:z.string().regex(/^[a-f0-9]{32}$/),manifest_version_id:z.string().min(1).max(1024),manifest_sha256_base64:base64,dump_sha256_base64:base64}).strict(),
 tables:z.array(z.object({name:identifier,structure_sha256:sha,rows:count,rows_sha256:sha}).strict()).min(1)}).strict();
export type PreservedTablePolicy=z.infer<typeof preservedTablePolicySchema>;
const loaded=new WeakSet<object>();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw new Error('Preserved source policy or backup recovery evidence does not match.');};
/** Integrity and operator provenance checks, not a signature or independent
 * attestation. These files must come from the approved retrieval/recovery run. */
export async function readPreservationEvidence(directory:string){
 const manifestBytes=await readPrivateInput(join(directory,'verified-backup.json'),4*1024**2);
 const dumpSchema=z.object({key:z.string().min(1),version_id:z.string().min(1),bytes:z.number().int().positive().max(5*1024**3),sha256_base64:base64}).strict();
 const manifest=z.object({version:z.literal(1),status:z.literal('restored-and-retained'),schemas:z.array(z.string()),inventory:z.record(z.string(),count),dump:dumpSchema}).passthrough().parse(JSON.parse(manifestBytes.toString()) as unknown);
 const receipt=z.object({transport_integrity_verified:z.literal(true),source_run_id:z.string(),manifest_version_id:z.string(),manifest_sha256_base64:base64,dump:dumpSchema}).passthrough().parse(JSON.parse((await readPrivateInput(join(directory,'download-verified.json'),4*1024**2)).toString()) as unknown);
 const restore=z.object({retrieved_backup_restore_verified:z.literal(true),row_counts_match:z.literal(true),constraints_validated:z.literal(true),network:z.literal('none'),source_run_id:z.string(),table_count:z.number().int().positive()}).passthrough().parse(JSON.parse((await readPrivateInput(join(directory,'restore-verified.json'),1024**2)).toString()) as unknown);
 if(manifest.version!==1||manifest.status!=='restored-and-retained'||receipt.transport_integrity_verified!==true||
   restore.retrieved_backup_restore_verified!==true||restore.row_counts_match!==true||restore.constraints_validated!==true||restore.network!=='none'||
   restore.source_run_id!==receipt.source_run_id||receipt.manifest_sha256_base64!==createHash('sha256').update(manifestBytes).digest('base64')||
   JSON.stringify(manifest.dump)!==JSON.stringify(receipt.dump)||!manifest.inventory||Array.isArray(manifest.inventory)||
   restore.table_count!==Object.keys(manifest.inventory).length||!Object.values(manifest.inventory).every(value=>count.safeParse(value).success)||
   JSON.stringify(manifest.schemas)!==JSON.stringify(['public','drizzle','videoq_security','chat_memory']))fail();
 const {file,info}=await openPrivateInput(join(directory,'database.dump'));const hash=createHash('sha256');let bytes=0;
 try{const buffer=Buffer.alloc(64*1024);for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;hash.update(buffer.subarray(0,bytesRead));}if(bytes!==info.size||bytes!==manifest.dump.bytes||hash.digest('base64')!==manifest.dump.sha256_base64)fail();}finally{await file.close();}
 const backup={run_id:receipt.source_run_id,manifest_version_id:receipt.manifest_version_id,manifest_sha256_base64:receipt.manifest_sha256_base64,dump_sha256_base64:manifest.dump.sha256_base64};
 if(!preservedTablePolicySchema.shape.backup.safeParse(backup).success||manifest.dump.key!==`verified/${backup.run_id}/database.dump`)fail();
 return {backup,inventory:manifest.inventory};
}
export function validatePreservedPolicy(input:unknown,manifest:Manifest,evidence:Awaited<ReturnType<typeof readPreservationEvidence>>){
 const parsed=preservedTablePolicySchema.safeParse(input);if(!parsed.success)fail();const policy=parsed.data!;
 if(policy.mapping_sha256!==digest(manifest)||JSON.stringify(policy.backup)!==JSON.stringify(evidence.backup)||
   new Set(policy.tables.map(table=>table.name)).size!==policy.tables.length||
   policy.tables.some(table=>manifest.tables.some(mapped=>mapped.source===table.name)||evidence.inventory[quote(policy.source_schema)+'.'+quote(table.name)]!==table.rows))fail();
 return policy;
}
export async function loadPreservedTablePolicy(directory:string,path:string,manifest:Manifest){
 const evidence=await readPreservationEvidence(directory);
 const policy=validatePreservedPolicy(JSON.parse((await readPrivateInput(path,4*1024**2)).toString()),manifest,evidence);
 // Freeze nested content: callers cannot change an already checked policy.
 Object.freeze(policy.backup);policy.tables.forEach(Object.freeze);Object.freeze(policy.tables);Object.freeze(policy);loaded.add(policy);return policy;
}
/** Caller owns the repeatable-read, read-only snapshot. Raw rows and SQL metadata
 * are hashed in memory and never returned as diagnostics or policy contents. */
export async function fingerprintPreservedTable(client:pg.Client|pg.PoolClient,schema:string,name:string){
 const qualified=quote(schema)+'.'+quote(name);
 const columns=(await client.query(`SELECT a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,
  pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[schema,name])).rows;
 if(!columns.length)fail();
 const constraints=(await client.query(`SELECT c.conname,c.contype,pg_get_constraintdef(c.oid,true) AS definition,c.convalidated FROM pg_constraint c WHERE c.conrelid=$1::regclass ORDER BY c.conname COLLATE "C"`,[qualified])).rows;
 const relation=(await client.query(`SELECT c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions FROM pg_class c WHERE c.oid=$1::regclass`,[qualified])).rows;
 const indexes=(await client.query(`SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::regclass ORDER BY c.relname COLLATE "C"`,[qualified])).rows;
 const triggers=(await client.query(`SELECT pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY t.tgname COLLATE "C"`,[qualified])).rows;
 const hash=createHash('sha256');let rows=0n;
 await client.query(`DECLARE videoq_preserved_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS data FROM ${qualified} t ORDER BY (row_to_json(t)::text) COLLATE "C"`);
 for(;;){const page=(await client.query<{data:string}>('FETCH FORWARD 100 FROM videoq_preserved_cursor')).rows;if(!page.length)break;for(const row of page){hash.update(row.data+'\n');rows++;}}
 await client.query('CLOSE videoq_preserved_cursor');
 return {name,structure_sha256:digest({relation,columns,constraints,indexes,triggers}),rows:rows.toString(),rows_sha256:hash.digest('hex')};
}
export async function verifyPreservedTables(client:pg.Client|pg.PoolClient,manifest:Manifest,schema:string,found:string[],policy:PreservedTablePolicy){
 if(!loaded.has(policy)||policy.source_schema!==schema||policy.mapping_sha256!==digest(manifest))fail();
 const expected=manifest.tables.map(table=>table.source),extra=found.filter(name=>!expected.includes(name));
 if(extra.length!==policy.tables.length||extra.some(name=>!policy.tables.some(table=>table.name===name)))fail();
 for(const table of policy.tables){const actual=await fingerprintPreservedTable(client,schema,table.name);if(JSON.stringify(actual)!==JSON.stringify(table))fail();}
 // Current tables may never depend on an excluded legacy table.
 const dependencies=(await client.query<{source_schema:string;source:string;target:string}>(`SELECT sn.nspname AS source_schema,s.relname AS source,t.relname AS target FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_class t ON t.oid=c.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE c.contype='f' AND (sn.nspname=$1 OR sn.nspname=ANY($2::text[])) AND tn.nspname=$1`,[schema,manifest.auxiliary_sources.map(source=>source.schema)])).rows;
 if(dependencies.some(edge=>(edge.source_schema!==schema||expected.includes(edge.source))&&extra.includes(edge.target)))fail();
 return new Set(extra);
}

/** Build a private policy from an explicit, reviewed list on the restored copy.
 * The caller must keep writers stopped and own a read-only repeatable snapshot. */
export async function buildPreservedTablePolicy(client:pg.Client|pg.PoolClient,manifest:Manifest,names:string[],evidence:Awaited<ReturnType<typeof readPreservationEvidence>>,schema='public'){
 if(!names.length||new Set(names).size!==names.length||names.some(name=>!identifier.safeParse(name).success||manifest.tables.some(table=>table.source===name)))fail();
 const found=(await client.query<{schema:string;name:string}>("SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY schemaname,tablename",[[schema,'drizzle','videoq_security','chat_memory']])).rows;
 if(found.length!==Object.keys(evidence.inventory).length)fail();
 for(const table of found){const qualified=quote(table.schema)+'.'+quote(table.name);if(evidence.inventory[qualified]===undefined||(await client.query<{count:string}>(`SELECT count(*)::text AS count FROM ${qualified}`)).rows[0].count!==evidence.inventory[qualified])fail();}
 const extra=found.filter(table=>table.schema===schema&&!manifest.tables.some(mapped=>mapped.source===table.name)).map(table=>table.name);
 if(extra.length!==names.length||extra.some(name=>!names.includes(name)))fail();
 const tables=[];for(const name of [...names].sort())tables.push(await fingerprintPreservedTable(client,schema,name));
 return validatePreservedPolicy({version:1,purpose:'preserve-legacy-outside-d1',source_schema:schema,mapping_sha256:digest(manifest),backup:evidence.backup,tables},manifest,evidence);
}
