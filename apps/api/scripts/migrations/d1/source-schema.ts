import type pg from 'pg';
import type {buildMigrationManifest} from './manifest';
/** Metadata only: no SELECT on source application rows, counts or secret fields. */
export async function collectSourceSchema(client:pg.Client|pg.PoolClient,manifest:ReturnType<typeof buildMigrationManifest>,schema='public'){
 if(!schema||schema.length>63||schema.includes('\0'))throw new Error('Invalid source schema.');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
  const tables=(await client.query<{name:string;can_read_rows:boolean;estimated_rows:string;relation_bytes:string}>(`SELECT c.relname AS name,has_table_privilege(c.oid,'SELECT') AS can_read_rows,c.reltuples::text AS estimated_rows,pg_total_relation_size(c.oid)::text AS relation_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`,[schema])).rows;
  const columns=(await client.query<{table:string;column:string;type:string;not_null:boolean}>(`SELECT c.relname AS "table",a.attname AS "column",format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[schema])).rows;
  const assessment=compareSourceSchema(tables.map(table=>table.name),columns,manifest);
  await client.query('COMMIT');
  return {version:1,measured_at:new Date().toISOString(),schema,transaction:'repeatable-read/read-only',metadata_only:true,row_contents_read:false,exact_row_counts_collected:false,tables,columns,...assessment,execution_complete:false,limitations:['Storage bytes are PostgreSQL physical estimates and do not predict D1 capacity.','reltuples is an estimate and can be stale or unknown.','Special-table column conversion and auxiliary schemas require separate verification.','No record contents, exact counts, bigint ranges or vector dimensions were scanned.']};
 }catch(error){await client.query('ROLLBACK');throw error;}
}

const canonical=(type:string)=>type.replace(/^character varying/,'varchar').replace(/^public\./,'');
export function compareSourceSchema(names:string[],columns:{table:string;column:string;type:string;not_null:boolean}[],manifest:ReturnType<typeof buildMigrationManifest>){
  const expected=manifest.tables.map(table=>table.source),unmapped=names.filter(name=>!expected.includes(name)),missing=expected.filter(name=>!names.includes(name));
  const drift=[];
  for(const table of manifest.tables.filter(table=>table.policy==='convert_rows')){
   const actual=columns.filter(column=>column.table===table.source);
   for(const column of table.columns){const found=actual.find(value=>value.column===column.name);if(!found)drift.push({table:table.source,column:column.name,issue:'missing_source_column'});else if(canonical(found.type)!==canonical(column.source_type)||found.not_null===column.nullable)drift.push({table:table.source,column:column.name,issue:'source_column_contract_changed',actual_type:found.type,expected_type:column.source_type,actual_not_null:found.not_null,expected_not_null:!column.nullable});}
   for(const column of actual)if(!table.columns.some(mapped=>mapped.name===column.column))drift.push({table:table.source,column:column.column,issue:'unmapped_source_column'});
  }
 return {expected_tables:expected.length,unmapped_tables:unmapped,missing_tables:missing,column_drift:drift,mapping_ready:unmapped.length===0&&missing.length===0&&drift.length===0};
}
