const {test}=require('node:test'),assert=require('node:assert/strict');
const {createOwnedDeploymentFreeze}=require('./cutover-owned-deployment-freeze.cjs');
test('owned deployment mutations require explicit capability and fixed metadata before any transport',async()=>{
 let calls=0;const dependencies={aws:()=>{calls++;},request:()=>{calls++;},table:'unused',machine:'unused',expectedDefinitionHash:'a'.repeat(64)};
 await assert.rejects(createOwnedDeploymentFreeze(dependencies)({action:'freeze',run:'b'.repeat(32),source:'c'.repeat(40)}),/DISABLED/);
 for(const action of ['command','freeze'])await assert.rejects(createOwnedDeploymentFreeze({...dependencies,enabled:true})({action,run:'bad',source:'c'.repeat(40)}),/CONTEXT/);
 assert.equal(calls,0);
});
test('atomic hold release also verifies DB, consumer and deployment completion markers',()=>{
 const {definition}=require('../../infra/db-maintenance/state-machine.cjs');const check=definition({table:'test',projects:{}}).States.ReleaseCutoverHold.Parameters.TransactItems[0].ConditionCheck;
 for(const condition of ['database_mutations_started = :false','attribute_not_exists(consumer_admission_restored) OR consumer_admission_restored = :requested','attribute_not_exists(deployment_admission_restored) OR deployment_admission_restored = :requested'])assert.ok(check.ConditionExpression.includes(condition));
 assert.deepEqual(check.ExpressionAttributeValues[':false'],{Bool:false});
});
