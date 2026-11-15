const {test}=require('node:test'),assert=require('node:assert/strict');
const {createDeploymentFreeze}=require('./cutover-deployment-freeze.cjs');
function fixture(){
 const rows=[{id:252628432,path:'.github/workflows/cd.yml',state:'active'},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml',state:'disabled_manually'}],writes=[],calls=[];
 let lost=false,ownership=0,revoke=Infinity,runs=()=>({total_count:0,workflow_runs:[]});
 const request=async(method,path)=>{
  calls.push({method,path});const match=/workflows\/(\d+)(.*)$/.exec(path),row=rows.find(r=>r.id===Number(match[1])),suffix=match[2];assert.ok(row);
  if(method==='GET')return suffix?runs(row,new URL('https://api.github.com/'+path).searchParams):{...row};
  assert.equal(method,'PUT');assert.ok(['/disable','/enable'].includes(suffix));writes.push(path);row.state=suffix==='/disable'?'disabled_manually':'active';if(lost){lost=false;throw Error('lost response');}return null;
 };
 const control=createDeploymentFreeze(request,{assertOwnership:async()=>{if(++ownership>=revoke)throw Error('lost ownership');}});
 return{rows,writes,calls,control,request,setRuns:f=>runs=f,lose:()=>lost=true,revokeAt:n=>revoke=n};
}
test('fixed workflow freeze and original-state restore are idempotent',async()=>{
 const f=fixture(),p=await f.control.prepare();assert.equal(f.writes.length,0);
 assert.deepEqual(await f.control.freeze(p),{admissionFrozen:true,githubRunsDrained:true,blockedRuns:[]});await f.control.freeze(p);assert.equal(f.writes.length,1);
 assert.equal((await f.control.restore(p)).originalAdmissionRestored,true);await f.control.restore(p);assert.equal(f.writes.length,2);assert.equal(f.rows[1].state,'disabled_manually');
});
test('no mutation without ownership and malformed plan never reaches transport',async()=>{
 const f=fixture(),p=await f.control.prepare();await assert.rejects(createDeploymentFreeze(f.request).freeze(p),/OWNERSHIP/);assert.equal(f.writes.length,0);
 for(const change of [p=>p.repository='other/repo',p=>p.workflows[0].id=1,p=>p.workflows[0].path='.github/workflows/ci.yml',p=>p.workflows[0].wasActive='true']){const v=structuredClone(p);change(v);const n=f.calls.length;await assert.rejects(f.control.freeze(v),/PLAN/);assert.equal(f.calls.length,n);}
});
test('partial lost response and ownership loss retain the stopped state',async()=>{
 const f=fixture();f.rows[1].state='active';const p=await f.control.prepare();f.lose();await assert.rejects(f.control.freeze(p),/lost response/);assert.equal(f.rows[0].state,'disabled_manually');assert.equal(f.rows[1].state,'active');assert.equal((await f.control.freeze(p)).admissionFrozen,true);
 const g=fixture();g.rows[1].state='active';const q=await g.control.prepare();g.revokeAt(3);await assert.rejects(g.control.freeze(q),/lost ownership/);assert.equal(g.writes.length,1);assert.equal(g.rows[0].state,'disabled_manually');
});
test('all five nonterminal statuses and an older page block drain',async()=>{
 const f=fixture(),p=await f.control.prepare();f.setRuns((row,q)=>{if(row.id!==f.rows[0].id)return{total_count:0,workflow_runs:[]};const page=Number(q.get('page')),status=q.get('status');return{total_count:101,workflow_runs:page===1?Array.from({length:100},(_,i)=>({id:i+1,workflow_id:row.id,status:'completed'})):[{id:101+['queued','in_progress','waiting','pending','requested'].indexOf(status),workflow_id:row.id,status}]};});
 const result=await f.control.freeze(p);assert.equal(result.admissionFrozen,true);assert.equal(result.githubRunsDrained,false);assert.equal(result.blockedRuns.length,5);assert.equal(f.writes.length,1);
});
test('truncated or foreign run inventory refuses drain',async()=>{
 for(const response of [{total_count:1000,workflow_runs:[]},{total_count:1,workflow_runs:[{id:1,workflow_id:1,status:'queued'}]},{total_count:1,workflow_runs:[{id:1,workflow_id:252628432,status:'unknown'}]},{workflow_runs:[]}]){const f=fixture(),p=await f.control.prepare();f.setRuns(()=>response);await assert.rejects(f.control.freeze(p),/INVENTORY/);assert.equal(f.rows[0].state,'disabled_manually');}
});
test('replaced workflow and originally disabled drift refuse writes',async()=>{
 for(const mutate of [f=>f.rows[0].path='.github/workflows/other.yml',f=>f.rows[0].state='disabled_inactivity',f=>f.rows[1].state='active']){const f=fixture(),p=await f.control.prepare();mutate(f);await assert.rejects(f.control.freeze(p),/DRIFT/);assert.equal(f.writes.length,0);}
});
test('concurrent re-enable during scan does not report frozen admission',async()=>{
 const f=fixture(),p=await f.control.prepare();f.setRuns(()=>{f.rows[0].state='active';return{total_count:0,workflow_runs:[]};});const result=await f.control.freeze(p);assert.equal(result.admissionFrozen,false);assert.equal(result.githubRunsDrained,true);
});
test('lost restore response is retryable and does not enable originally disabled workflow',async()=>{
 const f=fixture(),p=await f.control.prepare();await f.control.freeze(p);f.lose();await assert.rejects(f.control.restore(p),/lost response/);assert.equal(f.rows[0].state,'active');assert.equal(f.rows[1].state,'disabled_manually');assert.equal((await f.control.restore(p)).originalAdmissionRestored,true);assert.equal(f.writes.length,2);
});
