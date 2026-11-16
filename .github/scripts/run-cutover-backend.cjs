'use strict';
const {resolve}=require('node:path');
const {verifyReviewedSource,createGithubTransport}=require('./run-cutover-admission.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {createHandoffAwsTransport}=require('./cutover-handoff-aws.cjs');
const {handoffBackend}=require('./cutover-backend-handoff.cjs');
async function main({args=process.argv.slice(2),env=process.env,root=resolve(__dirname,'../..'),verifySource=verifyReviewedSource,aws=createHandoffAwsTransport({env,root}),github=createGithubTransport({env,root}),fetcher=fetch}={}){
 if(args.length!==4||args[0]!=='--run'||args[2]!=='--source'||!/^[a-f0-9]{32}$/.test(args[1])||!/^[a-f0-9]{40}$/.test(args[3])||env.GITHUB_ACTIONS||env.VIDEOQ_AWS_CLI||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('LOCAL_REVIEWED_HANDOFF_REQUIRED');
 await verifySource({source:args[3],root,env});if((await aws('sts','GetCallerIdentity',{})).Account!=='257240362763')throw Error('FIXED_HANDOFF_ACCOUNT_REQUIRED');
 return handoffBackend({run:args[1],source:args[3],aws,github,cloudflare:createCloudflareTrafficTransport(env.VIDEOQ_CUTOVER_CONTROL_TOKEN??env.CLOUDFLARE_API_TOKEN,{fetcher}),fetcher});
}
module.exports={main};
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('BACKEND_HANDOFF_FAILED_KEEP_WRITERS_STOPPED');process.exitCode=1;});
