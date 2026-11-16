// Explicitly invoked contract fixture only. The harness creates/deletes a private
// disposable D1 database. Worker metadata is a test transport; SQL uses real D1.
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const {d1SmokeStore}=require('./production-smoke-store.cjs');
let stage='context';
async function main(){
 const account='12daec56fdba43f677f2766ee26a5a39',id=process.env.VIDEOQ_SMOKE_D1_DATABASE_ID,name=process.env.VIDEOQ_SMOKE_CONTRACT_DATABASE_NAME,token=process.env.CLOUDFLARE_API_TOKEN;
 if(process.env.VIDEOQ_SMOKE_CONTRACT_TEST!=='1'||!/^videoq-smoke-contract-[a-f0-9]{12}$/.test(name??'')||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id??'')||!token)throw Error('DISPOSABLE_D1_CONTRACT_CONTEXT_REQUIRED');
 stage='database-metadata';
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+id,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)}),metadata=await response.json();
 if(!response.ok||metadata.success!==true||metadata.result?.name!==name||metadata.result?.uuid!==id)throw Error('DISPOSABLE_D1_DATABASE_REQUIRED');
 const env={CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token,VIDEOQ_SMOKE_D1_DATABASE_ID:id,VIDEOQ_SMOKE_IDENTITY_KEY:randomBytes(32).toString('hex')};
 const store=d1SmokeStore({env,fetcher:(url,options)=>url.endsWith('/workers/scripts/videoq-api/settings')?Promise.resolve(Response.json({success:true,result:{bindings:[{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id}]}})):fetch(url,options)});
 const uuid=randomUUID(),user={id:uuid,username:'ops_smoke_'+uuid,email:uuid+'@example.invalid',name:'VideoQ automated smoke check',role:'user',quota_source:'admin'};let created=false;
 try{
  stage='connect';await store.connect();stage='create';await store.createUser(user,'synthetic-hash-'.repeat(5),false);created=true;
  stage='lookup';assert.deepEqual((await store.oldUsers()).map(v=>v.id),[uuid]);stage='password';await store.password(user,'synthetic-new-hash-'.repeat(4));stage='expire';await store.expire(user);
  stage='business-reads';assert.deepEqual(await store.videos(user),[]);assert.deepEqual(await store.courses(user),[]);assert.equal(await store.processingVisuals(user),0);assert.equal(await store.pendingCleanup(user),0);assert.equal(await store.sceneCount(user,1),0);assert.equal(await store.hasChatLog(user,1),false);
  stage='cleanup';assert.equal(await store.deleteUser(user),true);created=false;assert.deepEqual(await store.oldUsers(),[]);
  console.log(JSON.stringify({realDisposableD1:true,actualMigratedSchema:true,syntheticCreatePasswordExpiryCleanup:true,productionWorkerMetadataMocked:true,productionAccess:false}));
 }finally{if(created)await store.deleteUser(user);await store.close();}
}
main().catch(()=>{console.error('DISPOSABLE_D1_SMOKE_CONTRACT_FAILED:'+stage);process.exitCode=1;});
