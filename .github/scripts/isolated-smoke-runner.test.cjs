const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {runIsolatedVideoSmoke:run}=require('./isolated-smoke-runner.cjs');
const {validateIsolatedSmokeManifest:validate}=require('./isolated-smoke-target.cjs');
const fixtureBytes=require('./isolated-smoke-fixture.cjs').loadReviewedSmokeFixture({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});
function parser({onEvent}){let buffer='';return{feed(text){buffer+=text;for(;;){const at=buffer.indexOf('\n\n');if(at<0)break;const event=buffer.slice(0,at);buffer=buffer.slice(at+2);if(event.startsWith('data: '))onEvent({data:event.slice(6)});}}};}
function fixture(options={}){
 const manifest={version:1,nonce:'a'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:7200000},target=validate(manifest,2000),calls=[];
 const env={CLOUDFLARE_ACCOUNT_ID:target.accountId,CLOUDFLARE_API_TOKEN:'synthetic-token-only-for-fixtures'};let clock=2000,video,course,user,gets=0,created=0,deleted=0;
 const old={id:'11111111-2222-4333-8444-555555555555',username:'ops_smoke_11111111-2222-4333-8444-555555555555',email:'11111111-2222-4333-8444-555555555555@example.invalid',name:'VideoQ automated smoke check',role:'user',quota_source:'admin'};
 if(options.oldPending)video={id:12,status:'processing'};
 const store={connect:async()=>{},oldUsers:async()=>options.oldPending?[old]:[],createUser:async u=>{created++;user=u;},password:async()=>{},expire:async()=>{},videos:async()=>video?[video]:[],processingVisuals:async()=>0,pendingCleanup:async()=>false,courses:async()=>course?[course]:[],deleteUser:async()=>{deleted++;return !video&&!course;},sceneCount:async()=>2,hasChatLog:async(_u,id)=>options.persisted!==false&&id===77,close:async()=>{}};
 const fetcher=async(url,request)=>{
  assert.equal(request.redirect,'error');
  const cf='https://api.cloudflare.com/client/v4/accounts/'+target.accountId+'/';
  if(url.startsWith(cf)){
   assert.equal(request.method,'GET');const path=url.slice(cf.length);let result;
   if(path==='workers/subdomain')result={subdomain:target.workersSubdomain};
   else if(path===`d1/database/${target.databaseId}`)result={uuid:target.databaseId,name:target.databaseName};
   else if(path.startsWith('vectorize/')){const large=path.endsWith('1536');result={name:large?target.largeIndex:target.smallIndex,config:{dimensions:large?1536:768,metric:'cosine'}};}
   else if(path===`r2/buckets/${target.bucket}`)result={name:target.bucket};
   else if(path.endsWith('/settings'))result={bindings:[{name:'DB',type:'d1',id:target.databaseId},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:target.largeIndex},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:target.smallIndex},{name:'VIDEO_BUCKET',type:'r2_bucket',bucket_name:target.bucket},...Object.entries({DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',MIGRATION_TRAFFIC_STATE:'running',BETTER_AUTH_URL:target.origin,OAUTH_ISSUER_URL:target.origin,FRONTEND_URL:target.origin,CORS_ALLOW_ORIGIN:target.origin,R2_BUCKET_NAME:target.bucket}).map(([name,text])=>({name,type:'plain_text',text}))]};
   else assert.fail('unexpected metadata path');return Response.json({success:true,result});
  }
  if(request.method==='PUT'){assert.ok(url.startsWith('https://'+target.accountId+'.r2.cloudflarestorage.com/'+target.bucket+'/'));calls.push('upload-put');return new Response('',{status:200});}
  assert.ok(url.startsWith(target.origin+'/'));const path=new URL(url).pathname;calls.push(path);
  if(path==='/health'||path==='/ready')return Response.json({data:{status:path==='/health'?'ok':'ready',db:'ok'}});
  if(path==='/api/auth/sign-in/email')return Response.json({ok:true},{headers:{'set-cookie':'session_token=synthetic; Secure; HttpOnly'}});
  if(path==='/api/chat/messages/stream'){
   const scoped=JSON.parse(request.body).course_id!==undefined;const events=[...(scoped?[{type:'source',source:{id:91,video_id:12,evidence_type:'transcript'}}]:[]),{type:'text_delta',segmentIndex:0,text:'Synthetic answer'},...(scoped?[{type:'citation',segmentIndex:0,sourceId:91}]:[]),...(!options.incompleteStream?[{type:'done',chat_log_id:scoped?77:null}]:[])];
   return new Response(events.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  }
  const procedure=path.split('/').at(-1);let data;
  if(procedure==='videos.requestUpload'){video={id:12,status:'uploading'};data={video,upload_url:'https://'+target.accountId+'.r2.cloudflarestorage.com/'+(options.badUpload?'videoq-media-prod':target.bucket)+'/fixture.mp4?signature=synthetic'};}
  else if(procedure==='videos.confirmUpload'){video.status='processing';data={};}
  else if(procedure==='videos.get'){gets++;if(!options.processingForever&&gets>=2)video={id:12,status:'completed',transcript:'Synthetic transcript',visual_processing:{status:'ready'}};data=video;}
  else if(procedure==='courses.create'){course={id:22};data=course;}
  else if(procedure==='memberships.addVideo')data={};
  else if(procedure==='chat.send')data={role:'assistant',answer:{segments:[{text:'Synthetic answer',sourceIds:[91]}],sources:options.missingCitation?[]:[{id:91,video_id:12,evidence_type:'transcript'}]}};
  else if(procedure==='videos.delete'){video=undefined;data={};}
  else if(procedure==='courses.delete'){course=undefined;data={};}
  else assert.fail('unexpected RPC');return Response.json({result:{data}});
 };
 return{manifest,env,store,fixtureBytes,fetcher,hashPassword:async()=> 'h'.repeat(64),createParser:parser,assertAws:async()=>({awsConfigurationVerified:options.aws!==false}),assertImage:async()=>({matchesDeployedWorkerImage:options.image!==false}),wait:async ms=>{clock+=ms;},now:()=>clock,calls,stats:()=>({created,deleted,gets,user})};
}
test('API pipeline verifies processing, cited answer, both complete streams and scoped cleanup',async()=>{
 const f=fixture(),report=await run(f);assert.equal(report.status,'ok');assert.equal(report.cleanupComplete,true);assert.ok(Object.values(report.checks).every(v=>v===true));assert.equal(f.stats().created,1);assert.equal(f.stats().deleted,1);assert.equal(f.calls.filter(v=>v==='upload-put').length,1);assert.equal(f.calls.filter(v=>v==='/api/chat/messages/stream').length,2);assert.ok(!JSON.stringify(report).includes('session_token'));
});
test('missing image or AWS proof stops before any application request or user creation',async()=>{
 for(const option of [{aws:false},{image:false}]){const f=fixture(option),report=await run(f);assert.equal(report.status,'error');assert.equal(report.failedStage,'preflight');assert.equal(f.calls.length,0);assert.equal(f.stats().created,0);}
});
test('production-bucket upload response is rejected without PUT or confirmation and cleans synthetic data',async()=>{
 const f=fixture({badUpload:true}),report=await run(f);assert.equal(report.status,'error');assert.equal(report.failedStage,'upload');assert.equal(report.cleanupComplete,true);assert.ok(!f.calls.includes('upload-put'));assert.ok(!f.calls.includes('/api/trpc/videos.confirmUpload'));
});
test('uncited answer, incomplete stream or missing persistence cannot pass the pipeline',async()=>{
 for(const options of [{missingCitation:true},{incompleteStream:true},{persisted:false}]){const f=fixture(options),report=await run(f);assert.equal(report.status,'error');assert.equal(report.cleanupComplete,true);assert.ok(['cited-answer','scoped-stream'].includes(report.failedStage));}
});
test('processing video is retained after timeout instead of force deletion or a second upload',async()=>{
 const f=fixture({processingForever:true}),report=await run(f);assert.equal(report.status,'error');assert.equal(report.failedStage,'video-processing');assert.equal(report.cleanupComplete,false);assert.equal(f.stats().created,1);assert.equal(f.stats().deleted,0);assert.equal(f.calls.filter(v=>v==='upload-put').length,1);assert.ok(!f.calls.includes('/api/trpc/videos.delete'));
});
test('earlier processing synthetic video prevents a new user/upload and remains unresolved',async()=>{
 const f=fixture({oldPending:true}),report=await run(f);assert.equal(report.failedStage,'old-synthetic-cleanup');assert.equal(report.cleanupComplete,false);assert.equal(f.stats().created,0);assert.ok(!f.calls.includes('upload-put'));assert.equal(f.stats().deleted,0);
});
