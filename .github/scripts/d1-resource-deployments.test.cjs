const {test}=require('node:test'),assert=require('node:assert/strict');
const {createResourceDeploymentAdapters}=require('./d1-resource-deployments.cjs');
function fixture(){
 const rows=[{id:252628432,path:'.github/workflows/cd.yml',state:'active'},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',state:'disabled_manually'}],plans=new Map(),writes=[];
 let blocked=false,lost=false;
 const request=async(method,path)=>{
  const match=/workflows\/(\d+)(.*)$/.exec(path),row=rows.find(r=>r.id===Number(match[1]));assert.ok(row);
  if(method==='GET')return match[2]?{total_count:blocked?1:0,workflow_runs:blocked?[{id:8,workflow_id:row.id,status:'in_progress'}]:[]}:{...row};
  assert.equal(method,'PUT');writes.push(path);row.state=path.endsWith('/disable')?'disabled_manually':'active';if(lost){lost=false;throw Error('lost');}
 };
 const adapters=createResourceDeploymentAdapters({request,plans:{load:async key=>plans.get(key)??null}});
 return{rows,plans,writes,adapters,context:{assertOwnership:async()=>{}},block:v=>blocked=v,lose:()=>lost=true};
}
async function prepared(f){const plan=await f.adapters['freeze-deployments'].prepare();f.plans.set('freeze-deployments',plan);return plan;}
test('fixed deployment adapters freeze and restore the saved original admission',async()=>{
 const f=fixture(),plan=await prepared(f),freeze=f.adapters['freeze-deployments'],restore=f.adapters['restore-deployments'];
 assert.deepEqual(await freeze.probe(plan),{state:'not-applied'});await freeze.apply(plan,f.context);assert.equal((await freeze.probe(plan)).state,'applied');
 assert.deepEqual(await restore.prepare(),plan);assert.equal((await restore.probe(plan)).state,'not-applied');await restore.apply(plan,f.context);assert.equal((await restore.probe(plan)).state,'applied');assert.equal(f.rows[1].state,'disabled_manually');assert.equal(f.writes.length,2);
});
test('frozen admission with accepted runs is unknown until authoritative drain',async()=>{
 const f=fixture(),plan=await prepared(f),a=f.adapters['freeze-deployments'];f.block(true);await a.apply(plan,f.context);assert.deepEqual(await a.probe(plan),{state:'unknown'});f.block(false);assert.equal((await a.probe(plan)).state,'applied');assert.equal(f.writes.length,1);
});
test('lost freeze and restore responses reconcile without another write',async()=>{
 const f=fixture(),plan=await prepared(f);for(const step of ['freeze-deployments','restore-deployments']){f.lose();await assert.rejects(f.adapters[step].apply(plan,f.context),/lost/);assert.equal((await f.adapters[step].probe(plan)).state,'applied');}assert.equal(f.writes.length,2);
});
test('original plan loss or substitution and ownership loss refuse mutations',async()=>{
 const f=fixture(),plan=await prepared(f);f.plans.clear();await assert.rejects(f.adapters['freeze-deployments'].apply(plan,f.context),/ORIGINAL_PLAN/);await assert.rejects(f.adapters['restore-deployments'].prepare());f.plans.set('freeze-deployments',{...plan,operationId:'00000000-0000-0000-0000-000000000000'});await assert.rejects(f.adapters['restore-deployments'].probe(plan),/ORIGINAL_PLAN/);f.plans.set('freeze-deployments',plan);await assert.rejects(f.adapters['freeze-deployments'].apply(plan,{assertOwnership:async()=>{throw Error('revoked');}}),/revoked/);assert.equal(f.writes.length,0);
});
