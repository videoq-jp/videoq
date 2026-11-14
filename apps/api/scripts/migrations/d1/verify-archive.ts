import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sequenceStateSchema} from './sequence-format';
import {ARCHIVE_VERSION} from './archive-format';
import {buildMigrationManifest,convertMigrationValue,type Conversion} from './manifest';
import {preservedTablePolicySchema} from './preserved-tables';
type Manifest=ReturnType<typeof buildMigrationManifest>;
export class ArchiveVerificationError extends Error {readonly name='ArchiveVerificationError';}
const sha=z.string().regex(/^[0-9a-f]{64}$/),count=z.string().regex(/^(?:0|[1-9]\d*)$/);
const identifier=z.string().min(1).refine(value=>!value.includes('\0'));
const tableSummary=z.object({schema:identifier,table:identifier,rows:count,sha256:sha}).strict();
const startSchema=z.object({kind:z.literal('archive_start'),version:z.literal(ARCHIVE_VERSION),source_schema:identifier,created_at:z.iso.datetime(),snapshot:z.literal('repeatable-read/read-only'),mapping_sha256:sha,execution_complete:z.literal(false),sequences:z.array(sequenceStateSchema),preserved_source_tables:preservedTablePolicySchema.optional(),migration_history:z.array(z.object({id:z.number().int(),hash:z.string(),created_at:z.string().regex(/^-?\d+$/)}).strict()).nullable(),auxiliary_sources:z.array(z.object({schema:identifier,tables:z.array(identifier),policy:z.string()}).strict()),auxiliary_inventory:z.array(z.object({schema:identifier,tables:z.array(identifier)}).strict())}).passthrough();
const tableSchema=z.object({kind:z.literal('table_start'),schema:identifier,table:identifier,mode:z.enum(['converted','raw-special']),columns:z.array(z.object({name:identifier,type:z.string().min(1),encoding:z.string().min(1)}).strict()).min(1),primary_key:z.array(identifier)}).strict();
const rowSchema=z.object({kind:z.literal('row'),values:z.array(z.union([z.string(),z.number(),z.null()]))}).strict();
const endSchema=z.object({kind:z.literal('archive_end'),tables:z.array(tableSummary),sha256:sha,execution_complete:z.literal(false)}).strict();
const canonical=(type:string)=>type.replace(/^character varying/,'varchar').replace(/^public\./,'');
const key=(schema:string,table:string)=>JSON.stringify([schema,table]);
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new ArchiveVerificationError('Invalid archive frame structure.');return result.data;}
function validateConverted(value:string|number|null,conversion:Conversion,nullable:boolean){
 if(value===null){if(!nullable)throw new ArchiveVerificationError('Unexpected required NULL.');return;}
 if(conversion==='safe_integer'){if(typeof value!=='number'||!Number.isSafeInteger(value))throw new ArchiveVerificationError('Unsafe converted integer.');return;}
 if(conversion==='boolean_integer'){if(value!==0&&value!==1)throw new ArchiveVerificationError('Invalid converted boolean.');return;}
 if(conversion==='finite_real'){if(typeof value!=='number'||!Number.isFinite(value))throw new ArchiveVerificationError('Invalid converted real.');return;}
 if(typeof value!=='string')throw new ArchiveVerificationError('Invalid converted text value.');
 try{if(convertMigrationValue(value,conversion,nullable)!==value)throw new Error();}catch{throw new ArchiveVerificationError('Invalid or non-normalized converted value.');}
}
/** Verify every byte before an importer may write anything. No raw values are
 * returned/logged. SHA-256 detects corruption, not authenticity or provenance.
 */
export async function verifyPostgresArchive(path:string,manifest:Manifest,options:{maxLineBytes?:number}={}){
 const limit=options.maxLineBytes??16*1024*1024;if(!Number.isSafeInteger(limit)||limit<1024||limit>128*1024*1024)throw new ArchiveVerificationError('Invalid archive line limit.');
 if(!manifest.mapping_complete)throw new ArchiveVerificationError('Migration mapping is incomplete.');
 const metadata=await lstat(path);if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new ArchiveVerificationError('Archive must be a private regular file.');
 const expectedHash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),hash=createHash('sha256');
 let header:z.infer<typeof startSchema>|undefined,current:{header:z.infer<typeof tableSchema>;hash:ReturnType<typeof createHash>;rows:bigint}|undefined,ended=false,archiveSha256:string|undefined;
 const expected=new Set<string>(),seen=new Set<string>(),summaries:z.infer<typeof tableSummary>[]=[],layouts:z.infer<typeof tableSchema>[]=[];
 const processLine=(bytes:Buffer)=>{
  if(ended)throw new ArchiveVerificationError('Unexpected data after archive footer.');
  let raw:unknown;try{const text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,-1));raw=JSON.parse(text) as unknown;if(JSON.stringify(raw)!==text)throw new ArchiveVerificationError();}catch{throw new ArchiveVerificationError('Invalid archive JSON or UTF-8.');}
  const kind=typeof raw==='object'&&raw!==null&&'kind'in raw?raw.kind:undefined;
  if(!header){
   header=parse(startSchema,raw);if(header.mapping_sha256!==expectedHash)throw new ArchiveVerificationError('Archive migration mapping does not match.');
   const preserved=header.preserved_source_tables;
   if(preserved&&(preserved.source_schema!==header.source_schema||preserved.mapping_sha256!==expectedHash||new Set(preserved.tables.map(table=>table.name)).size!==preserved.tables.length||preserved.tables.some(table=>manifest.tables.some(mapped=>mapped.source===table.name))||header.sequences.some(sequence=>preserved.tables.some(table=>sequence.owner_schema===header!.source_schema&&sequence.owner_table===table.name))))throw new ArchiveVerificationError('Invalid preserved legacy-table policy.');
   for(const table of manifest.tables)expected.add(key(header.source_schema,table.source));
   if(JSON.stringify(header.auxiliary_sources)!==JSON.stringify(manifest.auxiliary_sources))throw new ArchiveVerificationError('Auxiliary source mapping mismatch.');
   const sequenceKeys=new Set<string>();for(const sequence of header.sequences){const id=key(sequence.schema,sequence.name);if(sequence.schema!==header.source_schema||sequenceKeys.has(id))throw new ArchiveVerificationError('Invalid sequence inventory.');sequenceKeys.add(id);}
   const inventory=header.auxiliary_inventory;if(inventory.length!==manifest.auxiliary_sources.length)throw new ArchiveVerificationError('Auxiliary inventory mismatch.');
   const schemas=new Set<string>();
   for(const entry of inventory){const plan=manifest.auxiliary_sources.find(source=>source.schema===entry.schema);if(!plan||schemas.has(entry.schema)||entry.schema===header.source_schema||new Set(entry.tables).size!==entry.tables.length||(entry.tables.length!==0&&entry.tables.length!==plan.tables.length)||entry.tables.some(table=>!plan.tables.includes(table)))throw new ArchiveVerificationError('Auxiliary inventory mismatch.');schemas.add(entry.schema);for(const table of entry.tables)expected.add(key(entry.schema,table));}
  }else if(kind==='table_start'){
   if(current)throw new ArchiveVerificationError('Previous table is incomplete.');const table=parse(tableSchema,raw),id=key(table.schema,table.table);
   if(!expected.has(id)||seen.has(id))throw new ArchiveVerificationError('Unexpected or duplicate archive table.');
   if(new Set(table.columns.map(column=>column.name)).size!==table.columns.length||new Set(table.primary_key).size!==table.primary_key.length||table.primary_key.some(name=>!table.columns.some(column=>column.name===name)))throw new ArchiveVerificationError('Invalid archive column/key coverage.');
   const plan=table.schema===header.source_schema?manifest.tables.find(source=>source.source===table.table):undefined;
   if(plan?.policy==='convert_rows'){
    if(table.mode!=='converted'||table.columns.length!==plan.columns.length||table.columns.some(column=>!plan.columns.some(mapped=>mapped.name===column.name&&canonical(mapped.source_type)===canonical(column.type)&&mapped.conversion===column.encoding)))throw new ArchiveVerificationError('Converted archive columns differ from migration mapping.');
   }else if(table.mode!=='raw-special'||table.columns.some(column=>column.encoding!==(column.type==='bytea'?'hex':'postgres-text')))throw new ArchiveVerificationError('Invalid special-table encoding.');
   seen.add(id);layouts.push(table);current={header:table,hash:createHash('sha256'),rows:0n};
  }else if(kind==='row'){
   if(!current)throw new ArchiveVerificationError('Archive row outside a table.');const row=parse(rowSchema,raw);if(row.values.length!==current.header.columns.length)throw new ArchiveVerificationError('Archive row width mismatch.');
   const plan=current.header.mode==='converted'?manifest.tables.find(table=>table.source===current!.header.table):undefined;
   for(let i=0;i<row.values.length;i++){const value=row.values[i],column=current.header.columns[i];if(plan){const mapped=plan.columns.find(mapped=>mapped.name===column.name)!;if(!mapped.conversion)throw new ArchiveVerificationError('Unsupported archive conversion.');validateConverted(value,mapped.conversion,mapped.nullable);}else if(value!==null&&(typeof value!=='string'||column.encoding==='hex'&&!/^(?:[0-9a-f]{2})*$/.test(value)))throw new ArchiveVerificationError('Invalid raw archive value.');}
   current.hash.update(bytes);current.rows++;
  }else if(kind==='table_end'){
   if(!current)throw new ArchiveVerificationError('Unexpected table footer.');const end=parse(tableSummary.extend({kind:z.literal('table_end')}),raw);
   if(end.schema!==current.header.schema||end.table!==current.header.table||end.rows!==current.rows.toString()||end.sha256!==current.hash.digest('hex'))throw new ArchiveVerificationError('Archive table integrity mismatch.');
   summaries.push({schema:end.schema,table:end.table,rows:end.rows,sha256:end.sha256});current=undefined;
  }else if(kind==='archive_end'){
   const end=parse(endSchema,raw);if(current||seen.size!==expected.size||end.sha256!==hash.digest('hex')||JSON.stringify(end.tables)!==JSON.stringify(summaries))throw new ArchiveVerificationError('Archive completeness or integrity mismatch.');archiveSha256=end.sha256;ended=true;return;
  }else throw new ArchiveVerificationError('Unknown archive frame.');
  hash.update(bytes);
 };
 for await(const line of readArchiveLines(path,limit))processLine(line);
 if(!header||!ended||current)throw new ArchiveVerificationError('Truncated or incomplete archive.');
 return {source_schema:header.source_schema,...(header.preserved_source_tables?{preserved_source_tables:header.preserved_source_tables}:{}),migration_history:header.migration_history,table_layouts:layouts,sequence_states:header.sequences,archive_sha256:archiveSha256!,table_summaries:summaries,verified:true,version:ARCHIVE_VERSION,tables:summaries.length,rows:summaries.reduce((sum,table)=>sum+BigInt(table.rows),0n).toString(),execution_complete:false};
}

/** Internal bounded line reader; callers must verify the complete private file
 * before using any yielded frame to authorize writes. */
export async function* readArchiveLines(path:string,limit=16*1024*1024){
 const stream=createReadStream(path);let parts:Buffer[]=[],length=0;
 try{for await(const chunk of stream){const buffer=chunk as Buffer;let offset=0;while(offset<buffer.length){const newline=buffer.indexOf(10,offset),end=newline<0?buffer.length:newline+1,part=buffer.subarray(offset,end);length+=part.length;if(length>limit)throw new ArchiveVerificationError('Archive line exceeds configured size limit.');parts.push(part);offset=end;if(newline>=0){yield Buffer.concat(parts,length);parts=[];length=0;}}}}
 finally{stream.destroy();}
 if(length)throw new ArchiveVerificationError('Truncated or incomplete archive.');
}
