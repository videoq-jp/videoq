'use strict';
const {resolve,join}=require('node:path');
const {execFileSync}=require('node:child_process');
const {verifyReviewedSource,executionEnv,createGithubTransport}=require('./run-cutover-admission.cjs');
const {createHandoffAwsTransport}=require('./cutover-handoff-aws.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {createFinalizer,validateCanonicalD1}=require('./cutover-finalize.cjs');
function parse(args){
 if(![6,10].includes(args.length))throw Error('INVALID_FINALIZER_ARGUMENTS');const o={};for(let i=0;i<args.length;i+=2){if(!['--action','--run','--source','--smoke-build','--smoke-run'].includes(args[i])||Object.hasOwn(o,args[i])||!args[i+1])throw Error('INVALID_FINALIZER_ARGUMENTS');o[args[i]]=args[i+1];}
 if(!['resume','complete','stop'].includes(o['--action'])||!/^[a-f0-9]{32}$/.test(o['--run']??'')||!/^[a-f0-9]{40}$/.test(o['--source']??'')||(o['--action']!=='complete'?args.length!==6:args.length!==10))throw Error('INVALID_FINALIZER_ARGUMENTS');return{action:o['--action'],run:o['--run'],source:o['--source'],smokeBuildArn:o['--smoke-build'],smokeRunId:o['--smoke-run']};
}
async function main({args=process.argv.slice(2),env=process.env,root=resolve(__dirname,'../..'),execute=execFileSync,verifySource=verifyReviewedSource,aws=createHandoffAwsTransport({env,root,execute}),github=createGithubTransport({env,root,execute}),fetcher=fetch}={}){
 const operation=parse(args);if(env.GITHUB_ACTIONS||env.VIDEOQ_AWS_CLI||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('LOCAL_REVIEWED_FINALIZER_REQUIRED');
 await verifySource({source:operation.source,root,env,execute});if((await aws('sts','GetCallerIdentity',{})).Account!=='257240362763')throw Error('FIXED_FINALIZER_ACCOUNT_REQUIRED');
 const verifyCanonical=async()=>{
  const current=await verifySource({source:operation.source,root,env,execute});
  const json=execute('git',['show',current.currentMain+':apps/api/wrangler.jsonc'],{cwd:root,env:executionEnv(env,'git'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024});
  const {parse}=require(join(root,'.github/deploy-tools/node_modules/jsonc-parser')),errors=[];const config=parse(json,errors);if(errors.length)throw Error('CANONICAL_D1_CONFIGURATION_REQUIRED');validateCanonicalD1(config);
 };
 const finalizer=createFinalizer({...operation,aws,github,verifyCanonical,cloudflare:createCloudflareTrafficTransport(env.VIDEOQ_CUTOVER_CONTROL_TOKEN??env.CLOUDFLARE_API_TOKEN,{fetcher}),fetcher});
 if(operation.action==='stop')return finalizer.stop();
 try{return operation.action==='resume'?await finalizer.resume():await finalizer.complete(operation);}
 catch(error){await finalizer.stop().catch(()=>{});throw error;}
}
module.exports={parse,main};
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('D1_FINAL_HANDOFF_FAILED_KEEP_MAINTENANCE_OWNED');process.exitCode=1;});
