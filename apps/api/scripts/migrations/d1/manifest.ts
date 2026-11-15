import {z} from 'zod';
const columnSchema=z.object({name:z.string(),type:z.string(),notNull:z.boolean(),primaryKey:z.boolean().optional(),default:z.unknown().optional()});
const tableSchema=z.object({name:z.string(),columns:z.record(z.string(),columnSchema),foreignKeys:z.record(z.string(),z.object({tableTo:z.string()})).default({})});
const snapshotSchema=z.object({dialect:z.string(),tables:z.record(z.string(),tableSchema)});
export type MigrationColumn=z.infer<typeof columnSchema>;
export type Conversion='text'|'uuid'|'safe_integer'|'boolean_integer'|'finite_real'|'utc_timestamp'|'date'|'json_text'|'text_array_json';
const sourcePolicies:Record<string,string>={scene_embeddings:'split_scene_content_and_vectorize_1536',scene_embeddings_768:'split_scene_content_and_vectorize_768'};
const targetPolicies:Record<string,string>={migration_imports:'initialize_offline_import_progress',conversation_checkpoint_writes:'convert_chat_memory_checkpoint_writes',conversation_checkpoints:'convert_chat_memory_checkpoints_and_blobs',mutation_receipts:'initialize_empty_transient_receipts',scene_index_runs:'rebuild_index_publication_state',scene_index_tasks:'rebuild_vectorize_outbox',scene_staging:'initialize_empty_staging',scenes:'derive_from_postgres_scene_embeddings',video_index_heads:'rebuild_index_publication_state',video_index_versions:'rebuild_index_publication_state',visual_object_attempts:'reconcile_existing_visual_objects'};
const addedPolicies:Record<string,string>={'users.billing_revision':'initialize_default','video_course_invitations.creation_nonce':'initialize_null','video_visual_chunks.object_version':'migrate_legacy_visual_object_references','video_visual_runs.publication_version':'migrate_legacy_visual_object_references'};
function conversion(source:MigrationColumn,target:MigrationColumn):Conversion|null{
 if(target.type==='text'){
  if(source.type==='text'||/^varchar\(\d+\)$/.test(source.type))return 'text';
  if(source.type==='uuid')return 'uuid';if(source.type==='timestamp with time zone')return 'utc_timestamp';if(source.type==='date')return 'date';if(['json','jsonb'].includes(source.type))return 'json_text';if(source.type==='text[]')return 'text_array_json';
 }
 if(target.type==='integer'){if(['bigint','integer'].includes(source.type))return 'safe_integer';if(source.type==='boolean')return 'boolean_integer';}
 if(target.type==='real'&&source.type==='double precision')return 'finite_real';
 return null;
}
export function buildMigrationManifest(sourceInput:unknown,targetInput:unknown){
 const source=snapshotSchema.parse(sourceInput),target=snapshotSchema.parse(targetInput);
 if(source.dialect!=='postgresql'||target.dialect!=='sqlite')throw new Error('Expected PostgreSQL source and SQLite target snapshots.');
 const named=(tables:Record<string,z.infer<typeof tableSchema>>)=>{const result=new Map<string,z.infer<typeof tableSchema>>();for(const table of Object.values(tables)){if(result.has(table.name))throw new Error('Duplicate table names require explicit schema mapping.');result.set(table.name,table);}return result;};
 const from=named(source.tables),to=named(target.tables),issues:string[]=[],tables=[];
 for(const [name,table] of from){
  const destination=to.get(name);
  if(!destination){const policy=sourcePolicies[name];if(!policy)issues.push(`Unmapped source table: ${name}`);tables.push({source:name,target:null,policy:policy??'unmapped',columns:[],added_columns:[]});continue;}
  const columns=[];
  for(const [name,column] of Object.entries(table.columns)){
   const dest=destination.columns[name];if(!dest){issues.push(`Unmapped source column: ${table.name}.${name}`);continue;}
   const rule=conversion(column,dest);if(!rule)issues.push(`Unsupported conversion: ${table.name}.${name} (${column.type} to ${dest.type})`);
   columns.push({name,source_type:column.type,target_type:dest.type,nullable:!dest.notNull,conversion:rule});
  }
  const added=[];
  for(const [column,definition] of Object.entries(destination.columns))if(!table.columns[column]){const policy=addedPolicies[`${name}.${column}`];if(!policy)issues.push(`Unmapped target column: ${name}.${column}`);if(policy==='initialize_default'&&definition.default===undefined)issues.push(`Default missing: ${name}.${column}`);if(policy==='initialize_null'&&definition.notNull)issues.push(`Nullable target required: ${name}.${column}`);added.push({name:column,policy:policy??'unmapped'});}
  tables.push({source:name,target:name,policy:'convert_rows',columns,added_columns:added});
 }
 const targetOnly=[];
 for(const name of to.keys())if(!from.has(name)){const policy=targetPolicies[name];if(!policy)issues.push(`Unmapped target table: ${name}`);targetOnly.push({target:name,policy:policy??'unmapped'});}
 const dependencies=new Map([...to].map(([name,table])=>[name,new Set(Object.values(table.foreignKeys).map(key=>key.tableTo).filter(value=>value!==name))]));
 const order:string[]=[];
 while(dependencies.size){const ready=[...dependencies].filter(([,deps])=>deps.size===0).map(([name])=>name).sort();if(!ready.length){issues.push('Target dependency cycle or unknown referenced table requires an explicit import strategy.');break;}for(const name of ready){order.push(name);dependencies.delete(name);}for(const deps of dependencies.values())for(const name of ready)deps.delete(name);}
 return {version:1,mapping_complete:issues.length===0,issues,tables,target_only:targetOnly,target_insert_order:order,
  auxiliary_sources:[{schema:'chat_memory',tables:['checkpoints','checkpoint_blobs','checkpoint_writes','checkpoint_migrations'],policy:'convert_with_langgraph_serializer_and_validate_history'}],
  execution_complete:false,limitations:['Mapping coverage does not prove row conversion, import, checkpoint/visual/vector reconstruction or data integrity.','Live source schemas, sequences, constraints and migration history must be compared before exporting.','Special policies are required migration work, not implemented transformations.']};
}
export function quoteMigrationIdentifier(value:string){if(!value||value.includes('\0'))throw new Error('Invalid SQL identifier.');return '"'+value.replaceAll('"','""')+'"';}
export function migrationSelectExpression(column:Pick<MigrationColumn,'name'|'type'>){const name=quoteMigrationIdentifier(column.name);return (column.type==='text[]'?`pg_catalog.to_json(${name})` :name)+'::text AS '+name;}
/** Input is PostgreSQL text output (cast columns before the pg driver parses
 * bigint, dates, JSON or arrays). NULL remains distinct from JSON text "null".
 * Error messages contain column/type categories, never source values.
 */
export function convertMigrationValue(value:unknown,rule:Conversion,nullable:boolean):string|number|null{
 if(value===null){if(!nullable)throw new Error('Unexpected SQL NULL.');return null;}
 if(typeof value!=='string')throw new Error('Migration values must use PostgreSQL text output.');
 if(rule==='text')return value;
 if(rule==='uuid'){if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new Error('Invalid UUID.');return value;}
 if(rule==='safe_integer'){if(!/^-?\d+$/.test(value))throw new Error('Invalid integer.');const integer=BigInt(value);if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('Integer outside JavaScript safe range.');return Number(integer);}
 if(rule==='boolean_integer'){if(value==='true'||value==='t')return 1;if(value==='false'||value==='f')return 0;throw new Error('Invalid PostgreSQL boolean.');}
 if(rule==='finite_real'){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))throw new Error('Invalid real.');const number=Number(value);if(!Number.isFinite(number))throw new Error('Non-finite real.');return number;}
 if(rule==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw new Error('Invalid date.');return value;}
 if(rule==='utc_timestamp'){if(!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value))throw new Error('Timestamp requires an explicit timezone.');convertMigrationValue(value.slice(0,10),'date',false);if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)throw new Error('Invalid timestamp.');const time=new Date(value);if(!Number.isFinite(time.getTime()))throw new Error('Invalid timestamp.');return time.toISOString();}
 if(rule!=='json_text'&&rule!=='text_array_json')throw new Error('Unsupported conversion.');
 try{const parsed:unknown=JSON.parse(value);if(rule==='text_array_json'&&(!Array.isArray(parsed)||parsed.some(item=>typeof item!=='string'&&item!==null)))throw new Error();}catch{throw new Error('Invalid serialized JSON or text array.');}
 // Preserve numeric lexemes in JSON, including values larger than JS integers.
 return value;
}
