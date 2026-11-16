const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {assertFenceReleased,assertFenceReceipt}=require('../../infra/db-maintenance/runtime/cutover-hold.cjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
function row(state='released'){
 const plan='{"original":true}',receipt=JSON.stringify({state:state==='released'?'open':'fenced',writerLogins:2,enabledWriterLogins:state==='released'?2:0,writerSessions:0,otherDatabaseSessions:0,unknownSessions:0,preparedTransactions:0});
 return{postgres_fence_original_plan:{S:plan},postgres_fence_original_sha256:{S:hash(plan)},postgres_fence_plan_sha256:{S:hash(plan)},postgres_fence_state:{S:state},postgres_fence_action_id:{S:'a'.repeat(32)},postgres_fence_build_arn:{S:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:11111111-2222-4333-8444-555555555555'},postgres_fence_receipt:{S:receipt},postgres_fence_receipt_sha256:{S:hash(receipt)}};
}
test('only a released same-original-plan receipt permits admission restoration',()=>{
 assert.doesNotThrow(()=>assertFenceReleased({}));assert.doesNotThrow(()=>assertFenceReleased(row()));assert.doesNotThrow(()=>assertFenceReceipt(row('fenced'),'fenced'));
 for(const state of ['installing','fenced','releasing','unknown'])assert.throws(()=>assertFenceReleased(row(state)),/HANDOFF/);
});
test('partial, changed-original and corrupted or unsafe receipts retain exclusion',()=>{
 for(const change of [r=>delete r.postgres_fence_build_arn,r=>r.postgres_fence_original_plan.S='{}',r=>r.postgres_fence_receipt_sha256.S='a'.repeat(64),r=>r.postgres_fence_unrecognized={BOOL:true},r=>{const v=JSON.parse(r.postgres_fence_receipt.S);v.preparedTransactions=1;r.postgres_fence_receipt.S=JSON.stringify(v);r.postgres_fence_receipt_sha256.S=hash(r.postgres_fence_receipt.S);}]){const value=row();change(value);assert.throws(()=>assertFenceReleased(value),/HANDOFF/);}
});
