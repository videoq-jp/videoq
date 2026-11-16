// Fixed GitHub deployment admission only. This does not fence AWS, Cloudflare,
// administrator activity or a build already accepted outside GitHub Actions.
const {randomUUID}=require('node:crypto');
const repository='videoq-jp/videoq';
const workflows=[{id:252628432,path:'.github/workflows/cd.yml'},{id:403417588,path:'.github/workflows/db-maintenance-cd.yml'}];
const statuses=['queued','in_progress','waiting','pending','requested'];
const prefix=`repos/${repository}/actions/workflows/`;
function validate(plan){
  if(plan?.version!==1||plan.repository!==repository||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(plan.operationId??'')||!Array.isArray(plan.workflows)||plan.workflows.length!==workflows.length)throw Error('INVALID_DEPLOYMENT_FREEZE_PLAN');
  for(let i=0;i<workflows.length;i++){const row=plan.workflows[i],fixed=workflows[i];if(row.id!==fixed.id||row.path!==fixed.path||typeof row.wasActive!=='boolean')throw Error('INVALID_DEPLOYMENT_FREEZE_PLAN');}
  return plan;
}
function createDeploymentFreeze(request,{assertOwnership=async()=>{throw Error('DEPLOYMENT_FREEZE_OWNERSHIP_REQUIRED');}}={}){
  async function workflow(fixed){
    const row=await request('GET',prefix+fixed.id);
    if(row?.id!==fixed.id||row.path!==fixed.path||!['active','disabled_manually'].includes(row.state))throw Error('DEPLOYMENT_WORKFLOW_DRIFT');
    return row;
  }
  async function inventory(plan){
    validate(plan);const rows=[];
    for(const fixed of plan.workflows){const row=await workflow(fixed);if(!fixed.wasActive&&row.state!=='disabled_manually')throw Error('DEPLOYMENT_WORKFLOW_DRIFT');rows.push(row);}
    return rows;
  }
  async function activeRuns(fixed){
    const found=new Set();
    for(const status of statuses){
      let complete=false;
      for(let page=1;page<=10;page++){
        const result=await request('GET',`${prefix}${fixed.id}/runs?status=${status}&per_page=100&page=${page}`);
        if(!Number.isSafeInteger(result?.total_count)||result.total_count<0||result.total_count>=1000||!Array.isArray(result.workflow_runs)||result.workflow_runs.length>100)throw Error('DEPLOYMENT_RUN_INVENTORY_INCOMPLETE');
        for(const row of result.workflow_runs){
          if(!Number.isSafeInteger(row.id)||row.id<=0||row.workflow_id!==fixed.id||![...statuses,'completed'].includes(row.status))throw Error('DEPLOYMENT_RUN_INVENTORY_INVALID');
          // A run can finish between listing and response. All other known
          // nonterminal states block, even if the filter raced a transition.
          if(row.status!=='completed')found.add(row.id);
        }
        if(result.workflow_runs.length<100){complete=true;break;}
      }
      if(!complete)throw Error('DEPLOYMENT_RUN_INVENTORY_INCOMPLETE');
    }
    return [...found].sort((a,b)=>a-b);
  }
  return{
    async prepare(){const rows=[];for(const fixed of workflows){const row=await workflow(fixed);rows.push({...fixed,wasActive:row.state==='active'});}return validate({version:1,operationId:randomUUID(),repository,workflows:rows});},
    async inspectAdmission(plan){
      const rows=await inventory(plan);
      return {originalAdmissionRestored:rows.every((r,i)=>(r.state==='active')===plan.workflows[i].wasActive)};
    },
    async inspect(plan){
      const rows=await inventory(plan),blocked=[];
      for(const fixed of plan.workflows)for(const id of await activeRuns(fixed))blocked.push({workflowId:fixed.id,runId:id});
      // Re-read admission after the paginated scan to detect a concurrent enable.
      const after=await inventory(plan);
      return{admissionFrozen:rows.every(r=>r.state==='disabled_manually')&&after.every(r=>r.state==='disabled_manually'),githubRunsDrained:blocked.length===0,blockedRuns:blocked};
    },
    async freeze(plan){
      validate(plan);await assertOwnership('freeze',plan);const rows=await inventory(plan);
      for(let i=0;i<rows.length;i++)if(rows[i].state==='active'){
        await assertOwnership('freeze',plan);await request('PUT',prefix+plan.workflows[i].id+'/disable');
      }
      await assertOwnership('freeze',plan);return this.inspect(plan);
    },
    async restore(plan){
      validate(plan);await assertOwnership('restore',plan);const rows=await inventory(plan);
      for(let i=0;i<rows.length;i++)if(plan.workflows[i].wasActive&&rows[i].state==='disabled_manually'){
        await assertOwnership('restore',plan);await request('PUT',prefix+plan.workflows[i].id+'/enable');
      }
      await assertOwnership('restore',plan);const after=await inventory(plan);
      return{originalAdmissionRestored:after.every((r,i)=>(r.state==='active')===plan.workflows[i].wasActive)};
    },
  };
}
module.exports={createDeploymentFreeze,validateDeploymentFreezePlan:validate};
