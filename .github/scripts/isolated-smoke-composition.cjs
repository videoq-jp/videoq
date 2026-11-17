// Compose real scoped checks/store with the API pipeline. No default entry,
// credential discovery, resource creation, automatic recovery or production URL.
const {createIsolatedAwsGuard}=require('./isolated-smoke-aws.cjs');
const {createIsolatedAwsTransport}=require('./isolated-smoke-aws-transport.cjs');
const {createDeployedWorkerImageCheck}=require('./isolated-smoke-image.cjs');
const {isolatedD1SmokeStore}=require('./production-smoke-store.cjs');
const {runIsolatedVideoSmoke}=require('./isolated-smoke-runner.cjs');
const {verifyReviewedSource}=require('./run-cutover-admission.cjs');
async function runIsolatedSmoke({source,manifest,versions,imageDigest,secretSha256,env=process.env,hashPassword,createParser,fixtureBytes,fetcher=fetch,execute,wait,now=Date.now,onStage}){
 if(env.GITHUB_ACTIONS||env.DATABASE_URL||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL)throw Error('ISOLATED_SMOKE_LOCAL_CONTEXT_REQUIRED');
 await verifyReviewedSource({source,env});
 const aws=createIsolatedAwsTransport({manifest,versions,env,execute,now});
 const assertAws=createIsolatedAwsGuard({manifest,versions,imageDigest,secretSha256,aws,now});
 const assertImage=createDeployedWorkerImageCheck({imageDigest,env,execute});
 const store=isolatedD1SmokeStore({manifest,env,fetcher,now});
 return runIsolatedVideoSmoke({manifest,env,store,assertAws,assertImage,hashPassword,createParser,fixtureBytes,fetcher,wait,now,onStage});
}
module.exports={runIsolatedSmoke};
