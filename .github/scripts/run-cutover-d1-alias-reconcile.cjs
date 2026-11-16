'use strict';
const {resolve}=require('node:path'),{execFileSync}=require('node:child_process');
const {verifyReviewedSource,executionEnv,createGithubTransport}=require('./run-cutover-admission.cjs');
const {createHandoffAwsTransport}=require('./cutover-handoff-aws.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {LEGACY_SOURCE,reconcileLegacyD1Alias}=require('./cutover-d1-alias-reconcile.cjs');
function parse(args){
 if(args.length!==6)throw Error('INVALID_ALIAS_RECONCILIATION_ARGUMENTS');const o={};
 for(let i=0;i<args.length;i+=2){if(!['--run','--hold-source','--operator-source'].includes(args[i])||Object.hasOwn(o,args[i]))throw Error('INVALID_ALIAS_RECONCILIATION_ARGUMENTS');o[args[i]]=args[i+1];}
 if(!/^[a-f0-9]{32}$/.test(o['--run']??'')||o['--hold-source']!==LEGACY_SOURCE||!/^[a-f0-9]{40}$/.test(o['--operator-source']??'')||o['--operator-source']===LEGACY_SOURCE)throw Error('FIXED_LEGACY_HANDOFF_REQUIRED');
 return{run:o['--run'],source:o['--hold-source'],operatorSource:o['--operator-source']};
}
async function main({args=process.argv.slice(2),env=process.env,root=resolve(__dirname,'../..'),execute=execFileSync,verifySource=verifyReviewedSource,aws=createHandoffAwsTransport({env,root,execute}),github=createGithubTransport({env,root,execute}),fetcher=fetch}={}){
 const operation=parse(args);
 if(env.GITHUB_ACTIONS||env.VIDEOQ_AWS_CLI||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('LOCAL_REVIEWED_RECONCILIATION_REQUIRED');
 await verifySource({source:operation.operatorSource,root,env,execute});
 execute('git',['merge-base','--is-ancestor',operation.source,operation.operatorSource],{cwd:root,env:executionEnv(env,'git'),stdio:['ignore','pipe','pipe'],timeout:30000});
 if((await aws('sts','GetCallerIdentity',{})).Account!=='257240362763')throw Error('FIXED_RECONCILIATION_ACCOUNT_REQUIRED');
 const transport=createCloudflareTrafficTransport(env.VIDEOQ_CUTOVER_CONTROL_TOKEN??env.CLOUDFLARE_API_TOKEN,{fetcher});
 const cloudflare=(method,...rest)=>{if(method!=='GET')throw Error('READ_ONLY_RECONCILIATION_REQUIRED');return transport(method,...rest);};
 const readOnlyGithub=(method,...rest)=>{if(method!=='GET')throw Error('READ_ONLY_RECONCILIATION_REQUIRED');return github(method,...rest);};
 const boundedAws=(service,command,input)=>{if(service==='lambda'&&command!=='GetFunctionConfiguration'&&command!=='ListEventSourceMappings'||service==='ssm'||service==='sfn'&&command!=='DescribeExecution'&&command!=='DescribeStateMachineForExecution'&&command!=='GetExecutionHistory')throw Error('READ_ONLY_RUNTIME_RECONCILIATION_REQUIRED');return aws(service,command,input);};
 return reconcileLegacyD1Alias({...operation,aws:boundedAws,github:readOnlyGithub,cloudflare,fetcher});
}
module.exports={parse,main};
if(require.main===module)main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('D1_ALIAS_RECONCILIATION_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;});
