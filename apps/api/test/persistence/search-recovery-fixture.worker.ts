import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { SearchIndexWorkflow } from '../../src/workflows/search-index';
import { inspectSearchWorkflowRecovery, recoverSearchWorkflow } from '../../src/integrations/background-jobs/recovery';
import { canonicalBackgroundJob } from '../../src/application/background-job';
import { sha256 } from '../../src/integrations/background-jobs/execute';
import type { Bindings } from '../../src/types/bindings';
const job={type:'reindex_video_transcript',job_id:'isolated-recovery',payload:{video_id:1}} as const;
export class RecoveryWorkflow extends SearchIndexWorkflow {
  override async run(event:WorkflowEvent<unknown>,step:WorkflowStep) {
    const mode=await this.env.DB!.prepare('SELECT mode FROM recovery_probe').first<string>('mode');
    if(mode==='stop') await step.sleep('wait-for-termination','1 day');
    this.env.AI={run:async(_model:unknown,input:{input:string[]})=>Response.json({data:input.input.map((_,index)=>({index,embedding:[1,...Array(767).fill(0)]}))})} as unknown as Ai;
    const wrapped={sleep:(...args:Parameters<WorkflowStep["sleep"]>)=>step.sleep(...args)} as WorkflowStep;
    wrapped.do=(async(name:string,_config:unknown,operation:()=>Promise<unknown>)=>step.do(name,{retries:{limit:0,delay:'1 second'},timeout:'1 minute'},async()=>{
      const result=await operation();
      if(mode==='fail' && name==='embed-stage-0') throw new NonRetryableError('Injected isolated failure after staging');
      return result;
    })) as WorkflowStep['do'];
    return super.run(event,wrapped);
  }
}
export default {async fetch(request:Request,env:Bindings) {
  const path=new URL(request.url).pathname;
  try {
    const id=await sha256(`${job.job_id}\n${canonicalBackgroundJob(job)}`);
    if(path==='/create') {await env.SEARCH_INDEX_WORKFLOW!.create({id,params:job});return Response.json({id});}
    if(path==='/status') return Response.json(await (await env.SEARCH_INDEX_WORKFLOW!.get(id)).status());
    if(path==='/terminate') {await (await env.SEARCH_INDEX_WORKFLOW!.get(id)).terminate();return Response.json({});}
    if(path==='/inspect') return Response.json(await inspectSearchWorkflowRecovery(env,job));
    if(path==='/restart') return Response.json(await recoverSearchWorkflow(env,job,await request.text()));
    return new Response('unknown',{status:404});
  } catch(error) {return Response.json({code:error instanceof Error?error.message:'FAILED'},{status:409});}
}};
