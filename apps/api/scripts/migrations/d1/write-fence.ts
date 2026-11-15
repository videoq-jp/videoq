import {createHash} from 'node:crypto';
import type {D1Database} from '@cloudflare/workers-types';
const prefix='videoq_migration_fence_';
const verbs=['INSERT','UPDATE','DELETE'] as const;
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(message:string):never=>{throw new Error(message);};
export type D1WriteFencePlan={version:1;databaseId:string;operationId:string;tables:string[];schemaSha256:string};
/** Operator must independently verify the binding ID in a fixed config.
 * D1 SQL cannot establish identity from this caller-supplied string. */
export type D1WriteFenceConnection={database:D1Database;databaseId:string};
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
function identity(c:D1WriteFenceConnection,p?:D1WriteFencePlan){
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c.databaseId)||p&&(p.version!==1||p.databaseId!==c.databaseId||!/^[a-f0-9]{32}$/.test(p.operationId)||!/^[a-f0-9]{64}$/.test(p.schemaSha256)))fail('Write-fence identity mismatch.');
}
function tableNames(names:readonly string[]){
 if(names.length<1||names.length>200||new Set(names).size!==names.length||names.some(t=>!/^[a-z][a-z0-9_]{0,100}$/.test(t)||t.startsWith('sqlite_')||t.startsWith(prefix)))fail('Invalid write-fence table inventory.');
}
async function inventory(c:D1WriteFenceConnection){
 const result=await c.database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all<ObjectRow>();
 if(!result.success)fail('Cannot inspect write-fence schema.');
 const objects=result.results.filter(r=>!r.name.startsWith('sqlite_')&&!r.name.startsWith('_cf_'));
 return {objects,tables:objects.filter(r=>r.type==='table').map(r=>r.name).sort()};
}
function triggers(p:D1WriteFencePlan){return p.tables.flatMap(table=>verbs.map(verb=>{
 const name=prefix+p.operationId+'_'+hash(table).slice(0,16)+'_'+verb.toLowerCase();
 return {name,table,sql:`CREATE TRIGGER ${quote(name)} BEFORE ${verb} ON ${quote(table)} BEGIN SELECT RAISE(ABORT, 'VIDEOQ_MIGRATION_WRITES_FENCED'); END`};
}));}
const schemaHash=(rows:ObjectRow[])=>hash(rows.filter(r=>!r.name.startsWith(prefix)));
const same=(a:readonly string[],b:readonly string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
/** Read-only preparation. Persist plan before installing; no automatic expiry. */
export async function prepareD1WriteFence(c:D1WriteFenceConnection,expectedTables:readonly string[],operationId:string):Promise<D1WriteFencePlan>{
 identity(c);tableNames(expectedTables);if(!/^[a-f0-9]{32}$/.test(operationId))fail('Invalid write-fence operation.');
 const {objects,tables}=await inventory(c);
 if(!same(tables,expectedTables))fail('Write-fence table inventory mismatch.');
 if(objects.some(r=>r.name.startsWith(prefix)))fail('Another write-fence plan already exists.');
 return {version:1,databaseId:c.databaseId,operationId,tables,schemaSha256:schemaHash(objects)};
}
/** Verify exact trigger bodies AND underlying schema; count alone is insufficient. */
export async function inspectD1WriteFence(c:D1WriteFenceConnection,p:D1WriteFencePlan){
 identity(c,p);tableNames(p.tables);const {objects,tables}=await inventory(c);
 if(!same(tables,p.tables)||schemaHash(objects)!==p.schemaSha256)fail('Write-fence schema drift.');
 const expected=triggers(p),byName=new Map(expected.map(t=>[t.name,t])),installed=objects.filter(r=>r.name.startsWith(prefix));
 for(const row of installed){const item=byName.get(row.name);if(!item||row.type!=='trigger'||row.tbl_name!==item.table||row.sql!==item.sql)fail('Unknown or modified write-fence object.');}
 return {state:installed.length===expected.length?'fenced' as const:installed.length===0?'open' as const:'partial' as const,installedTriggers:installed.length,expectedTriggers:expected.length,missing:expected.filter(t=>!installed.some(r=>r.name===t.name)).map(t=>t.name)};
}
/** Bounded resumable batches. Installation is NOT whole-DB atomic; a snapshot
 * is allowed only after every trigger is verified and upstream work is drained. */
export async function installD1WriteFence(c:D1WriteFenceConnection,p:D1WriteFencePlan){
 const state=await inspectD1WriteFence(c,p),missing=new Set(state.missing),pending=triggers(p).filter(t=>missing.has(t.name));
 for(let offset=0;offset<pending.length;offset+=20){const results=await c.database.batch(pending.slice(offset,offset+20).map(t=>c.database.prepare(t.sql)));if(results.some(r=>!r.success))fail('Write-fence installation incomplete; keep upstream writers stopped.');}
 const verified=await inspectD1WriteFence(c,p);if(verified.state!=='fenced')fail('Write-fence installation incomplete; keep upstream writers stopped.');return verified;
}
/** Keep upstream API/queue/schedulers stopped throughout release. Partial
 * release is neither a fence nor permission to resume traffic. */
export async function releaseD1WriteFence(c:D1WriteFenceConnection,p:D1WriteFencePlan){
 const state=await inspectD1WriteFence(c,p),missing=new Set(state.missing),installed=triggers(p).filter(t=>!missing.has(t.name));
 for(let offset=0;offset<installed.length;offset+=20){const results=await c.database.batch(installed.slice(offset,offset+20).map(t=>c.database.prepare('DROP TRIGGER '+quote(t.name))));if(results.some(r=>!r.success))fail('Write-fence release incomplete; keep upstream writers stopped.');}
 const verified=await inspectD1WriteFence(c,p);if(verified.state!=='open')fail('Write-fence release incomplete; keep upstream writers stopped.');return verified;
}
