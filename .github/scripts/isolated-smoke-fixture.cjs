// Read only the committed public MP4 blob at the reviewed source, not an
// arbitrary local file. Retain the exact approved content hash before upload.
const path=require('node:path'),{execFileSync}=require('node:child_process');
const {executionEnv}=require('./run-cutover-admission.cjs');
const {fixtureValid}=require('./production-smoke-policy.cjs');
function loadReviewedSmokeFixture({source,root=path.resolve(__dirname,'../..'),execute=execFileSync,env=process.env}){
 if(!/^[a-f0-9]{40}$/.test(source??''))throw Error('ISOLATED_SMOKE_FIXTURE_REQUIRED');
 try{
  const bytes=Buffer.from(execute('git',['show',source+':.github/operations-tools/fixtures/smoke.mp4'],{cwd:root,env:executionEnv(env,'git'),stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:2000001}));
  if(!fixtureValid(bytes))throw Error('hash');return bytes;
 }catch{throw Error('ISOLATED_SMOKE_FIXTURE_REQUIRED');}
}
module.exports={loadReviewedSmokeFixture};
