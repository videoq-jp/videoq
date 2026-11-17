// API pipeline rehearsal only. No resource creation, production origin, browser
// bypass, automatic retry of mutations, or unsafe deletion of processing jobs.
const {randomUUID,randomBytes}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {createIsolatedSmokeTarget,validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
const {synthetic,fixtureValid,completed,deletable,waitForCleanup,citedAnswerValid}=require('./production-smoke-policy.cjs');
const {verifyStream}=require('./production-stream-proof.cjs');
async function runIsolatedVideoSmoke({manifest,env,store,assertAws,assertImage,hashPassword,createParser,fixtureBytes,fetcher=fetch,wait=delay,now=Date.now,onStage=()=>{}}){
 if([assertAws,assertImage,hashPassword,createParser,fetcher,wait,now,onStage].some(v=>typeof v!=='function')||!store||['connect','oldUsers','createUser','password','expire','videos','processingVisuals','pendingCleanup','courses','deleteUser','sceneCount','hasChatLog','close'].some(k=>typeof store[k]!=='function')||!fixtureValid(fixtureBytes))throw Error('ISOLATED_SMOKE_RUNNER_CONTEXT_REQUIRED');
 const context=Object.freeze(structuredClone(manifest)),bytes=Buffer.from(fixtureBytes),target=createIsolatedSmokeTarget({manifest:context,env,fetcher,now});
 let currentUser,cookie='',stage='preflight';
 const progress=value=>{stage=value;onStage({stage:value});};
 const checks={health:false,upload:false,processed:false,scenes:false,citedAnswer:false,scopedStream:false,unscopedStream:false};
 const request=(path,options={})=>{validateIsolatedSmokeManifest(context,now());return fetcher(target.origin+path,{...options,redirect:'error',signal:options.signal??AbortSignal.timeout(30000)});};
 async function guard(){await target.assertTarget();if((await assertImage())?.matchesDeployedWorkerImage!==true)throw Error('ISOLATED_SMOKE_IMAGE_PROOF_REQUIRED');const proof=await assertAws();if(proof?.awsConfigurationVerified!==true)throw Error('ISOLATED_SMOKE_AWS_PROOF_REQUIRED');validateIsolatedSmokeManifest(context,now());}
 async function json(response){if(!response.ok||!response.body)throw Error('HTTP_FAILED');let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)throw Error('BODY_LIMIT');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 async function rpc(procedure,input,mutation=false,timeoutMs=30000){
  if(mutation)await guard();
  const response=await request('/api/trpc/'+procedure+(mutation?'':'?input='+encodeURIComponent(JSON.stringify(input))),{method:mutation?'POST':'GET',signal:AbortSignal.timeout(timeoutMs),headers:{cookie,Origin:target.origin,'Content-Type':'application/json'},...(mutation?{body:JSON.stringify(input)}:{})});
  const body=await json(response);if(!body.result||body.error)throw Error('RPC_FAILED');return body.result.data;
 }
 async function login(user,password){
  if(!synthetic(user))throw Error('UNSAFE_IDENTITY');await guard();
  const response=await request('/api/auth/sign-in/email',{method:'POST',headers:{Origin:target.origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password})});
  if(!response.ok)throw Error('SIGN_IN_FAILED');cookie=response.headers.getSetCookie().map(v=>v.split(';',1)[0]).join('; ');if(!cookie.includes('session_token='))throw Error('SIGNED_SESSION_REQUIRED');await store.expire(user);
 }
 async function cleanup(user){
  if(!synthetic(user))throw Error('UNSAFE_IDENTITY');const videos=await store.videos(user);
  if(videos.some(v=>!deletable(v.status))||await store.processingVisuals(user))return false;
  for(const video of videos)await rpc('videos.delete',{id:Number(video.id)},true);
  if(await store.pendingCleanup(user))return false;
  for(const course of await store.courses(user))await rpc('courses.delete',{id:Number(course.id)},true);
  return store.deleteUser(user);
 }
 const report={scope:'isolated-api-pipeline',cleanupScope:'synthetic-data',status:'error',cleanupComplete:false,checks};
 try{
  progress('preflight');await guard();
  for(const path of ['/health','/ready']){const body=await json(await request(path));if(!['ok','ready'].includes(body.data?.status)||path==='/ready'&&body.data.db!=='ok')throw Error('HEALTH_FAILED');}checks.health=true;
  progress('old-synthetic-cleanup');await store.connect();
  for(const user of await store.oldUsers()){
   if(!synthetic(user))throw Error('UNSAFE_IDENTITY');const password=randomBytes(32).toString('base64url');await guard();await store.password(user,await hashPassword(password));await login(user,password);
   if(!await waitForCleanup(()=>cleanup(user),wait))throw Error('EARLIER_VIDEO_PROCESSING');
  }
  progress('synthetic-sign-in');const id=randomUUID(),password=randomBytes(32).toString('base64url');currentUser={id,username:'ops_smoke_'+id,email:id+'@example.invalid',name:'VideoQ automated smoke check',role:'user',quota_source:'admin'};
  await guard();await store.createUser(currentUser,await hashPassword(password),true);await login(currentUser,password);
  progress('upload');const title='Isolated smoke '+id;
  const upload=await rpc('videos.requestUpload',{filename:'operations-smoke.mp4',title,description:'Isolated synthetic verification',contentType:'video/mp4',fileSize:bytes.length},true);
  if(!Number.isSafeInteger(upload.video?.id)||upload.video.id<=0||!target.uploadAllowed(upload.upload_url))throw Error('UPLOAD_TARGET_REFUSED');
  await guard();if(!target.uploadAllowed(upload.upload_url))throw Error('UPLOAD_TARGET_REFUSED');const put=await fetcher(upload.upload_url,{method:'PUT',body:bytes,headers:{'Content-Type':'video/mp4'},redirect:'error',signal:AbortSignal.timeout(60000)});if(!put.ok)throw Error('UPLOAD_FAILED');
  await rpc('videos.confirmUpload',{id:upload.video.id},true);checks.upload=true;
  progress('video-processing');const deadline=now()+12*60*1000;let video;
  while(now()<deadline){
   video=await rpc('videos.get',{id:upload.video.id});if(video.id!==upload.video.id||video.status==='error'||video.visual_processing?.status==='error')throw Error('PROCESSING_FAILED');if(completed(video))break;
   await wait(Math.min(20000,Math.max(0,deadline-now())));
  }
  if(!video||!completed(video)||!video.transcript?.trim())throw Error('PROCESSING_INCOMPLETE');checks.processed=true;
  const scenes=await store.sceneCount(currentUser,video.id);if(!Number.isSafeInteger(scenes)||scenes<1)throw Error('SCENES_REQUIRED');checks.scenes=true;
  progress('cited-answer');const course=await rpc('courses.create',{name:title,description:'Temporary isolated verification'},true);await rpc('memberships.addVideo',{courseId:course.id,videoId:video.id},true);
  const answer=await rpc('chat.send',{courseId:course.id,messages:[{role:'user',content:'What is said in this video? Summarize it and cite the transcript evidence.'}]},true,180000);
  if(!citedAnswerValid(answer,Number(video.id)))throw Error('CITED_ANSWER_REQUIRED');checks.citedAnswer=true;
  for(const scoped of [true,false]){
   progress(scoped?'scoped-stream':'unscoped-stream');await guard();
   const response=await request('/api/chat/messages/stream',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:target.origin},body:JSON.stringify({messages:[{role:'user',content:scoped?'Summarize what is said in this video and cite its transcript evidence.':'Briefly explain what a video transcript is.'}],...(scoped?{course_id:course.id}:{})}),signal:AbortSignal.timeout(180000)});
   const log=await verifyStream(response,createParser,scoped?Number(video.id):undefined);if(scoped&&(await store.hasChatLog(currentUser,log))!==true)throw Error('PERSISTED_ANSWER_REQUIRED');checks[scoped?'scopedStream':'unscopedStream']=true;
  }
  report.status='ok';
 }catch{report.failedStage=stage;}
 finally{
  try{report.cleanupComplete=currentUser?await waitForCleanup(()=>cleanup(currentUser),wait):stage!=='old-synthetic-cleanup';}catch{report.cleanupComplete=false;}
  if(!report.cleanupComplete)report.status='error';await store.close().catch(()=>{report.status='error';});
 }
 return report;
}
module.exports={runIsolatedVideoSmoke};
