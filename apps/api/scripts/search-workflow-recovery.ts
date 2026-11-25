import { readFile } from 'node:fs/promises';

/** Session credentials go only to the explicitly selected API, never redirects. */
export async function recoveryRequest(api:string, cookie:string, input:unknown, restart:boolean, local=false, request:typeof fetch=fetch):Promise<unknown> {
  const base=new URL(api);
  if(base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
    base.protocol !== 'https:' && !(local && base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) throw new Error('RECOVERY_INVALID_TARGET');
  const url=new URL(`/api/trpc/admin.${restart?'restartSearchWorkflow':'inspectSearchRecovery'}`,base);
  if(!restart)url.searchParams.set('input',JSON.stringify(input));
  const response=await request(url,{method:restart?'POST':'GET',redirect:'error',headers:{cookie,'content-type':'application/json'},...(restart?{body:JSON.stringify(input)}:{})});
  if(!response.ok){await response.body?.cancel();throw new Error('RECOVERY_REQUEST_FAILED');}
  const data=await response.json() as {result?:{data?:unknown}};
  if(!data.result || !('data' in data.result)) throw new Error('RECOVERY_INVALID_RESPONSE');
  return data.result.data;
}
async function main() {
  const args=process.argv.slice(2);
  const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
  const api=value('--api'),jobPath=value('--job-file'),inspection=value('--expected-inspection');
  const restart=args.includes('--restart'),cookie=process.env.VIDEOQ_ADMIN_SESSION_COOKIE;
  if(!api || !jobPath || !cookie || restart && !inspection || restart===args.includes('--inspect'))throw new Error('RECOVERY_USAGE');
  const job:unknown=JSON.parse(await readFile(jobPath,'utf8'));
  const result=await recoveryRequest(api,cookie,restart?{job,inspection}:{job},restart,args.includes('--local'));
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]?.endsWith('/search-workflow-recovery.ts'))main().catch(()=>{console.error('SEARCH_WORKFLOW_RECOVERY_FAILED');process.exitCode=1;});
