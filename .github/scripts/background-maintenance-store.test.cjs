const {test}=require('node:test'),assert=require('node:assert/strict');
const {createBackgroundMaintenanceStore}=require('./background-maintenance-store.cjs');
function fixture(){
 const run='a'.repeat(32),source='b'.repeat(40),execution='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
 const lock={kind:{S:'migration'},execution_arn:{S:execution},input:{S:JSON.stringify({kind:'migration',source_sha:source,writers_stopped:true})}},row={kind:{S:'migration'},execution_arn:{S:execution}};
 let lose=false;const writes=[];
 const aws=async(service,command,input)=>{
  assert.equal(service,'dynamodb');if(command==='get-item')return{Item:structuredClone(input.Key.pk.S==='maintenance'?lock:row)};
  assert.equal(command,'transact-write-items');writes.push(input);const [check,update]=input.TransactItems;
  assert.equal(check.ConditionCheck.Key.pk.S,'maintenance');assert.equal(check.ConditionCheck.ExpressionAttributeValues[':input'].S,lock.input.S);
  assert.equal(check.ConditionCheck.ExpressionAttributeValues[':execution'].S,execution);
  const field=update.Update.ExpressionAttributeNames['#record'];assert.equal(update.Update.Key.pk.S,'run#'+run);assert.match(update.Update.ConditionExpression,/attribute_not_exists/);
  if(row[field])throw Error('conditional failure');row[field]=structuredClone(update.Update.ExpressionAttributeValues[':record']);if(lose)throw Error('lost response');return{};
 };
 return{row,lock,writes,lose:()=>{lose=true;},create:(verificationOnly=false)=>createBackgroundMaintenanceStore({aws,run,source,verificationOnly,assertOwnership:async()=>{}})};
}
test('create-only plans bind the run/source and survive a lost transaction response',async()=>{
 const f=fixture();f.lose();await f.create().save('background-drain',{pausedObservedAt:123});
 assert.deepEqual(await f.create().load('background-drain'),{pausedObservedAt:123});await f.create().save('background-drain',{pausedObservedAt:123});
 await assert.rejects(f.create().save('background-drain',{pausedObservedAt:456}),/WRITE_FAILED/);
 assert.equal(f.writes[0].TransactItems.length,2);
});
test('verification records require the explicitly owned non-schema request and cannot become schema completion proof',async()=>{
 const f=fixture();await assert.rejects(f.create(true).save('background-verification-paused',{}),/LOCK/);
 const input=JSON.parse(f.lock.input.S);input.writers_stopped=false;input.background_verification=true;f.lock.input.S=JSON.stringify(input);
 await f.create(true).save('background-verification-paused',{version:1});
 await assert.rejects(f.create(true).save('background-schema-complete',{}),/KEY/);
 await assert.rejects(f.create().load('background-verification-paused'),/KEY/);
 await assert.rejects(f.create().load('background-queues'),/LOCK/);
 assert.equal(f.row.background_schema_complete,undefined);
});
test('wrong source, lock ownership, corrupted record and excessive payload fail closed',async()=>{
 const f=fixture();await f.create().save('background-drain',{pausedObservedAt:123});
 const original=f.row.background_drain.S,record=JSON.parse(original);record.source='c'.repeat(40);f.row.background_drain.S=JSON.stringify(record);
 await assert.rejects(f.create().load('background-drain'),/RECORD/);f.row.background_drain.S=original;
 f.lock.execution_arn.S='other';await assert.rejects(f.create().load('background-drain'),/LOCK/);
 const g=fixture();await assert.rejects(g.create().save('background-workflows',{data:'x'.repeat(65000)}),/TOO_LARGE/);assert.equal(g.writes.length,0);
 await assert.rejects(g.create().save('arbitrary',{value:1}),/KEY/);
});
