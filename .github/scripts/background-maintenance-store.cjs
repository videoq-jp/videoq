// Persist plans on the existing migration run; atomically check the global
// maintenance lock for every create-only write. Never store provider credentials.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const FIELDS={
 'background-queues':'background_queues',
 'background-drain':'background_drain',
 'background-workflows':'background_workflows',
 'background-restore':'background_restore',
 'background-schema-complete':'background_schema_complete',
 'background-verification-paused':'background_verification_paused',
 'background-verification-complete':'background_verification_complete',
};
function createBackgroundMaintenanceStore({aws,run,source,assertOwnership,verificationOnly=false}){
 if(typeof verificationOnly!=='boolean')throw Error('BACKGROUND_STORE_CONTEXT_REQUIRED');
 if(typeof aws!=='function'||typeof assertOwnership!=='function'||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??''))throw Error('BACKGROUND_STORE_CONTEXT_REQUIRED');
 const table='videoq-db-maintenance-prod',execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 function field(key){if(!Object.hasOwn(FIELDS,key)||verificationOnly&&key==='background-schema-complete'||!verificationOnly&&key.startsWith('background-verification-'))throw Error('BACKGROUND_STORE_KEY_REQUIRED');return FIELDS[key];}
 async function owned(){
  await assertOwnership();
  const lock=(await aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:'maintenance'}},ConsistentRead:true})).Item;
  let input;try{input=JSON.parse(lock?.input?.S);}catch{throw Error('BACKGROUND_STORE_LOCK_REQUIRED');}
  if(lock?.kind?.S!=='migration'||lock.execution_arn?.S!==execution||input.kind!=='migration'||input.source_sha!==source||input.writers_stopped!==!verificationOnly||(input.background_verification===true)!==verificationOnly)throw Error('BACKGROUND_STORE_LOCK_REQUIRED');
  return lock.input.S;
 }
 return{
  async load(key){
   const name=field(key);await owned();
   const row=(await aws('dynamodb','get-item',{TableName:table,Key:{pk:{S:'run#'+run}},ConsistentRead:true})).Item;
   if(row?.kind?.S!=='migration'||row.execution_arn?.S!==execution)throw Error('BACKGROUND_STORE_RUN_REQUIRED');
   if(row[name]===undefined)return null;
   let envelope;try{envelope=JSON.parse(row[name].S);}catch{throw Error('BACKGROUND_STORE_RECORD_INVALID');}
   if(envelope?.version!==1||envelope.run!==run||envelope.source!==source||envelope.key!==key||resourceDigest(envelope.value)!==envelope.sha256)throw Error('BACKGROUND_STORE_RECORD_INVALID');
   await owned();return envelope.value;
  },
  async save(key,value){
   const name=field(key),input=await owned();
   const encoded=JSON.stringify({version:1,run,source,key,value,sha256:resourceDigest(value)});
   if(Buffer.byteLength(encoded)>64000)throw Error('BACKGROUND_STORE_RECORD_TOO_LARGE');
   let failure;
   try{await aws('dynamodb','transact-write-items',{TransactItems:[
    {ConditionCheck:{TableName:table,Key:{pk:{S:'maintenance'}},ConditionExpression:'#kind=:kind AND execution_arn=:execution AND #input=:input',ExpressionAttributeNames:{'#kind':'kind','#input':'input'},ExpressionAttributeValues:{':kind':{S:'migration'},':execution':{S:execution},':input':{S:input}}}},
    {Update:{TableName:table,Key:{pk:{S:'run#'+run}},UpdateExpression:'SET #record=:record',ConditionExpression:'#kind=:kind AND execution_arn=:execution AND attribute_not_exists(#record)',ExpressionAttributeNames:{'#kind':'kind','#record':name},ExpressionAttributeValues:{':kind':{S:'migration'},':execution':{S:execution},':record':{S:encoded}}}},
   ]});}catch(error){failure=error;}
   // A lost response can be reconciled only with the exact same immutable value.
   const saved=await this.load(key);
   if(saved===null||resourceDigest(saved)!==resourceDigest(value))throw Error(failure?'BACKGROUND_STORE_WRITE_FAILED':'BACKGROUND_STORE_READBACK_FAILED');
  },
 };
}
module.exports={createBackgroundMaintenanceStore};
