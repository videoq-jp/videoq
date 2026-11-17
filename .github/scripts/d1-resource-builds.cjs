// Fixed maintenance metadata only. No logs, app configuration, credentials,
// build starts/stops or lock mutation. Admission fencing remains required.
const {resourceDigest}=require('./d1-resource-journal.cjs');
const PROJECTS=Object.freeze(['videoq-db-migration-prod','videoq-db-smoke-prod','videoq-db-deploy-prod']);
const PREFIX='arn:aws:codebuild:ap-northeast-1:257240362763:build/';
function buildId(value,project){
 if(typeof value!=='string')throw Error('RESOURCE_BUILD_INVENTORY_INVALID');
 const id=value.startsWith(PREFIX)?value.slice(PREFIX.length):value;
 if(!new RegExp('^'+project+':[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$').test(id))throw Error('RESOURCE_BUILD_INVENTORY_INVALID');return id;
}
async function readResourceBuildInventory(aws){
 if(typeof aws!=='function')throw Error('RESOURCE_BUILD_TRANSPORT_REQUIRED');
 const projects=[];
 for(const projectName of PROJECTS){
  const ids=new Set(),tokens=new Set(),active=[];let token;
  for(let page=0;page<25;page++){
   const list=await aws('codebuild','ListBuildsForProject',{projectName,...(token?{nextToken:token}:{})});
   if(!Array.isArray(list.ids)||list.ids.length>100)throw Error('RESOURCE_BUILD_INVENTORY_INCOMPLETE');
   const pageIds=list.ids.map(id=>buildId(id,projectName));
   if(new Set(pageIds).size!==pageIds.length||pageIds.some(id=>ids.has(id)))throw Error('RESOURCE_BUILD_INVENTORY_CHANGED');
   pageIds.forEach(id=>ids.add(id));
   if(pageIds.length){
    const response=await aws('codebuild','BatchGetBuilds',{ids:pageIds});
    if(response.buildsNotFound?.length||!Array.isArray(response.builds)||response.builds.length!==pageIds.length)throw Error('RESOURCE_BUILD_INVENTORY_INCOMPLETE');
    const found=new Set();for(const build of response.builds){
     const id=buildId(build.id,projectName);
     if(!pageIds.includes(id)||found.has(id)||build.arn!==PREFIX+id||build.projectName!==projectName||typeof build.buildComplete!=='boolean'||!['IN_PROGRESS','SUCCEEDED','FAILED','FAULT','STOPPED','TIMED_OUT'].includes(build.buildStatus)||build.buildComplete!==(build.buildStatus!=='IN_PROGRESS'))throw Error('RESOURCE_BUILD_INVENTORY_INVALID');
     found.add(id);if(!build.buildComplete)active.push({arn:build.arn,status:build.buildStatus});
    }
   }
   token=list.nextToken;if(!token)break;if(typeof token!=='string'||tokens.has(token)||page===24)throw Error('RESOURCE_BUILD_INVENTORY_INCOMPLETE');tokens.add(token);
  }
  projects.push({name:projectName,buildCount:ids.size,active});
 }
 return{projects};
}
function createResourceBuildGuard({aws,journal,plans,proof}){
 if(typeof aws!=='function'||['assertExecutor','assertAbortExecutor','inspect'].some(k=>typeof journal?.[k]!=='function')||typeof plans?.load!=='function'||typeof proof?.matchesBuild!=='function')throw Error('RESOURCE_BUILD_GUARD_CONTEXT_REQUIRED');
 return async function assertBuildsSafe({allowOwnedSmoke=false,abort=false}={}){
  if(typeof allowOwnedSmoke!=='boolean'||typeof abort!=='boolean'||abort&&allowOwnedSmoke)throw Error('RESOURCE_BUILD_GUARD_MODE_REQUIRED');
  const owned=()=>abort?journal.assertAbortExecutor():journal.assertExecutor();await owned();
  const inventory=await readResourceBuildInventory(aws),active=inventory.projects.flatMap(v=>v.active);
  if(active.length){
   if(!allowOwnedSmoke||active.length!==1||!active[0].arn.startsWith(PREFIX+'videoq-db-smoke-prod:'))throw Error('RESOURCE_UNOWNED_BUILD_ACTIVE');
   const state=await journal.inspect(),plan=await plans.load('verify-e2e'),entry=state.steps.at(-1);
   if(state.nextStep!=='verify-e2e'||entry?.step!=='verify-e2e'||entry.state!=='intent'||!plan||entry.planSha256!==resourceDigest(plan)||!await proof.matchesBuild(plan.nativePlan,active[0].arn,resourceDigest(plan)))throw Error('RESOURCE_UNOWNED_BUILD_ACTIVE');
  }
  await owned();return inventory;
 };
}
module.exports={readResourceBuildInventory,createResourceBuildGuard};
