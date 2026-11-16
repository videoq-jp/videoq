// Bounded frozen-D1 reader. Binary payloads use the recovery contract's compact
// hex representation; only row digests are retained while comparing pages.
'use strict';
const binary={conversation_checkpoints:new Set(['checkpoint','metadata']),conversation_checkpoint_writes:new Set(['value'])};
function normalizeRecoveryRow(table,row){
 const result={...row};
 for(const column of binary[table]??[]){
  const value=result[column];if(value===null)continue;
  if(Array.isArray(value)&&value.every(v=>Number.isInteger(v)&&v>=0&&v<=255))result[column]={hex:Buffer.from(value).toString('hex')};
  else if(value&&typeof value==='object'&&Object.keys(value).length===1&&typeof value.hex==='string'&&/^(?:[a-f0-9]{2})*$/.test(value.hex))result[column]={hex:value.hex};
  else throw Error('RECOVERY_BINARY_REPRESENTATION_INVALID');
 }
 return result;
}
async function frozenTableDigests(query,table,hash){
 if(!/^[a-z][a-z0-9_]{0,100}$/.test(table))throw Error('RECOVERY_TABLE_INVENTORY_CHANGED');
 const columns=(await query('PRAGMA table_info("'+table+'")')).results;
 if(!Array.isArray(columns)||!columns.length||columns.some(c=>!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(c.name)))throw Error('RECOVERY_TABLE_SCHEMA_CHANGED');
 const fields=columns.map(c=>binary[table]?.has(c.name)?'CASE WHEN "'+c.name+'" IS NULL THEN NULL ELSE lower(hex("'+c.name+'")) END AS "'+c.name+'"':'"'+c.name+'"').join(',');
 const digests=[];
 for(let offset=0;offset<=10000;offset+=25){
  const rows=(await query('SELECT '+fields+' FROM "'+table+'" LIMIT 25 OFFSET '+offset)).results;
  if(!Array.isArray(rows)||rows.length>25)throw Error('RECOVERY_TABLE_READ_INVALID');
  for(const row of rows){
   const normalized={...row};for(const column of binary[table]??[])if(normalized[column]!==null)normalized[column]={hex:normalized[column]};
   digests.push(hash(normalizeRecoveryRow(table,normalized)));
   if(digests.length>10000)throw Error('RECOVERY_TABLE_INVENTORY_CHANGED');
  }
  if(rows.length<25)return digests.sort();
 }
 throw Error('RECOVERY_TABLE_INVENTORY_CHANGED');
}
module.exports={normalizeRecoveryRow,frozenTableDigests};
