const {test}=require('node:test'),assert=require('node:assert/strict');
const {readResourceBuildInventory,createResourceBuildGuard}=require('./d1-resource-builds.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
function fixture({active=false,pages=false,activeProject='videoq-db-smoke-prod'}={}){
 const calls=[],uuid=i=>'00000000-0000-0000-0000-'+String(i).padStart(12,'0');let mode='valid';
 const aws=async(service,command,input)=>{
  calls.push({service,command,input});assert.equal(service,'codebuild');
  if(command==='ListBuildsForProject'){
   assert.equal(Object.hasOwn(input,'sortOrder'),false);const many=pages&&input.projectName==='videoq-db-smoke-prod';
   return{ids:Array.from({length:many&&!input.nextToken?100:1},(_,i)=>input.projectName+':'+uuid(input.nextToken?100:i)),...(many&&!input.nextToken?{nextToken:'second'}:{})};
  }
  assert.equal(command,'BatchGetBuilds');const builds=input.ids.map(id=>({id,arn:'arn:aws:codebuild:ap-northeast-1:257240362763:build/'+id,projectName:id.split(':')[0],buildStatus:active&&id.startsWith(activeProject+':')?'IN_PROGRESS':'SUCCEEDED',buildComplete:!(active&&id.startsWith(activeProject+':'))}));
  if(mode==='missing')return{builds:[],buildsNotFound:input.ids};if(mode==='wrong-project')builds[0].projectName='other';if(mode==='duplicate'&&builds.length>1)builds[1]=builds[0];return{builds};
 };
 return{aws,calls,change:v=>mode=v};
}
test('fixed three-project inventory reads all pages with no sort option and returns only safe metadata',async()=>{
 const f=fixture({pages:true}),result=await readResourceBuildInventory(f.aws);assert.deepEqual(result.projects.map(v=>v.buildCount),[1,101,1]);assert.ok(result.projects.every(v=>v.active.length===0));assert.ok(f.calls.every(v=>['ListBuildsForProject','BatchGetBuilds'].includes(v.command)));
});
test('missing build metadata, wrong project and duplicate records refuse an idle claim',async()=>{
 for(const mode of ['missing','wrong-project','duplicate']){const f=fixture({pages:true});f.change(mode);await assert.rejects(readResourceBuildInventory(f.aws),/^Error: RESOURCE_BUILD_INVENTORY_/);}
});
test('guard permits only the exact pinned pending E2E build, including before ARN registration',async()=>{
 const f=fixture({active:true}),plan={nativePlan:{actionId:'a'.repeat(32)}},state={nextStep:'verify-e2e',steps:[{step:'verify-e2e',state:'intent',planSha256:resourceDigest(plan)}]};let owned=true,match=true;
 const guard=createResourceBuildGuard({aws:f.aws,journal:{assertExecutor:async()=>{if(!owned)throw Error('RESOURCE_OWNER_LOST');},assertAbortExecutor:async()=>{},inspect:async()=>state},plans:{load:async()=>plan},proof:{matchesBuild:async()=>match}});
 await assert.rejects(guard(),/UNOWNED_BUILD_ACTIVE/);await guard({allowOwnedSmoke:true});match=false;await assert.rejects(guard({allowOwnedSmoke:true}),/UNOWNED_BUILD_ACTIVE/);owned=false;await assert.rejects(guard({allowOwnedSmoke:true}),/OWNER_LOST/);
});
test('abort guard demands no active builds and cannot exempt E2E',async()=>{
 const f=fixture({active:true}),guard=createResourceBuildGuard({aws:f.aws,journal:{assertExecutor:async()=>assert.fail('normal ownership'),assertAbortExecutor:async()=>{},inspect:async()=>{}},plans:{load:async()=>null},proof:{matchesBuild:async()=>false}});
 await assert.rejects(guard({abort:true}),/UNOWNED_BUILD_ACTIVE/);await assert.rejects(guard({abort:true,allowOwnedSmoke:true}),/MODE_REQUIRED/);
});

test('a migration build is never exempted as native smoke even if a supplied matcher approves',async()=>{
 const f=fixture({active:true,activeProject:'videoq-db-migration-prod'}),guard=createResourceBuildGuard({aws:f.aws,journal:{assertExecutor:async()=>{},assertAbortExecutor:async()=>{},inspect:async()=>assert.fail('must reject project first')},plans:{load:async()=>null},proof:{matchesBuild:async()=>true}});await assert.rejects(guard({allowOwnedSmoke:true}),/UNOWNED_BUILD_ACTIVE/);
});
