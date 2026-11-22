const {test}=require('node:test'),assert=require('node:assert/strict');
const {createDeployedWorkerImageCheck:create}=require('./isolated-smoke-image.cjs');
const imageDigest='a'.repeat(64),image='257240362763.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:'+imageDigest;
test('image baseline reads only safe fields for the three fixed deployed workers',async()=>{
 const names=[];const check=create({imageDigest,env:{PATH:'fixture',HOME:'fixture',AWS_PROFILE:'approved',CLOUDFLARE_API_TOKEN:'must-not-forward'},execute:async(program,args,options)=>{
  assert.equal(program,'aws');assert.deepEqual(args.slice(0,2),['lambda','get-function']);const name=args[args.indexOf('--function-name')+1];names.push(name);assert.ok(!args.at(-1).includes('Environment'));assert.ok(!args.at(-1).includes('Location'));assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.AWS_PROFILE,'approved');assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
  return{stdout:JSON.stringify({name,role:'arn:aws:iam::257240362763:role/videoq-worker-prod',state:'Active',update:'Successful',package:'Image',architectures:['arm64'],image})};
 }});assert.deepEqual(await check(),{matchesDeployedWorkerImage:true});assert.deepEqual(names.sort(),['videoq-worker-account-prod','videoq-worker-prod','videoq-worker-search-prod']);
});
test('drift or provider failure refuses image baseline without leaking response bodies',async()=>{
 for(const patch of [{image:'other'},{update:'InProgress'},{role:'other'}])await assert.rejects(create({imageDigest,execute:async(_program,args)=>({stdout:JSON.stringify({name:args[args.indexOf('--function-name')+1],role:'arn:aws:iam::257240362763:role/videoq-worker-prod',state:'Active',update:'Successful',package:'Image',architectures:['arm64'],image,...patch})})})(),{message:'ISOLATED_DEPLOYED_IMAGE_CHECK_FAILED'});
 await assert.rejects(create({imageDigest,execute:async()=>{throw Error('PRIVATE_PROVIDER_BODY');}})(),{message:'ISOLATED_DEPLOYED_IMAGE_CHECK_FAILED'});assert.throws(()=>create({imageDigest:'tag:latest'}),/DIGEST_REQUIRED/);
});
function retiredExecute({failure,code=254,exists=false,mediaMissing=false}={}){
 return async(_program,args)=>{
  const name=args[args.indexOf('--function-name')+1];
  if(name==='videoq-worker-prod'&&!mediaMissing||exists)return{stdout:JSON.stringify({name,role:'arn:aws:iam::257240362763:role/videoq-worker-prod',state:'Active',update:'Successful',package:'Image',architectures:['arm64'],image})};
  throw Object.assign(Error('private provider body'),{code,stderr:'An error occurred ('+(failure??'ResourceNotFoundException')+') when calling the GetFunction operation: private detail'});
 };
}
test('explicit Cloudflare mode verifies the media image and confirms both retired functions are absent',async()=>{
 const check=create({imageDigest,env:{BACKGROUND_JOBS_RUNTIME:'cloudflare'},execute:retiredExecute()});
 assert.deepEqual(await check(),{matchesDeployedWorkerImage:true});
});
test('Cloudflare mode refuses existing retired functions, denied reads and a missing media function',async()=>{
 for(const options of [{exists:true},{failure:'AccessDeniedException'},{code:'ETIMEDOUT'},{mediaMissing:true}]){
  await assert.rejects(create({imageDigest,env:{BACKGROUND_JOBS_RUNTIME:'cloudflare'},execute:retiredExecute(options)})(),{message:'ISOLATED_DEPLOYED_IMAGE_CHECK_FAILED'});
 }
});
test('legacy mode never accepts missing functions and invalid modes cannot weaken the check',async()=>{
 await assert.rejects(create({imageDigest,execute:retiredExecute()})(),{message:'ISOLATED_DEPLOYED_IMAGE_CHECK_FAILED'});
 assert.throws(()=>create({imageDigest,env:{BACKGROUND_JOBS_RUNTIME:'unknown'}}),/RUNTIME_REQUIRED/);
});
