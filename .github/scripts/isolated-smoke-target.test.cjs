const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateIsolatedSmokeManifest:validate,createIsolatedSmokeTarget:create}=require('./isolated-smoke-target.cjs');
const manifest=()=>({version:1,nonce:'a'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:100000});
function fixture(){
 let clock=2000;const input=manifest(),target=validate(input,clock),calls=[];
 const vars={DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',MIGRATION_TRAFFIC_STATE:'running',BETTER_AUTH_URL:target.origin,OAUTH_ISSUER_URL:target.origin,FRONTEND_URL:target.origin,CORS_ALLOW_ORIGIN:target.origin,R2_BUCKET_NAME:target.bucket};
 const settings={bindings:[{name:'DB',type:'d1',id:target.databaseId},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:target.largeIndex},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:target.smallIndex},{name:'VIDEO_BUCKET',type:'r2_bucket',bucket_name:target.bucket},...Object.entries(vars).map(([name,text])=>({name,type:'plain_text',text}))]};
 const rows=[{subdomain:target.workersSubdomain},settings,{uuid:target.databaseId,name:target.databaseName},{name:target.largeIndex,config:{dimensions:1536,metric:'cosine'}},{name:target.smallIndex,config:{dimensions:768,metric:'cosine'}},{name:target.bucket}];
 const env={CLOUDFLARE_ACCOUNT_ID:target.accountId,CLOUDFLARE_API_TOKEN:'synthetic-token-for-fixtures-only'};
 const fetcher=async(url,options)=>{calls.push({url,method:options.method});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');const suffix=url.split('/accounts/'+target.accountId+'/')[1];const index=suffix==='workers/subdomain'?0:suffix.endsWith('/settings')?1:suffix.startsWith('d1/')?2:suffix.endsWith(target.largeIndex)?3:suffix.endsWith(target.smallIndex)?4:5;return Response.json({success:true,result:rows[index]});};
 return{input,manifest:input,target,settings,rows,calls,env,fetcher,now:()=>clock,setClock:v=>clock=v};
}
test('manifest derives every storage/origin name from one nonce and rejects production identities',()=>{
 const m=manifest(),t=validate(m,2000);assert.ok(t.origin.startsWith('https://videoq-isolated-api-'+m.nonce+'.'));assert.ok(t.bucket.endsWith(m.nonce));
 for(const patch of [{databaseId:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},{databaseId:'587bd210-6d9d-4f32-abb7-a490013e65d3'},{workersSubdomain:'videoq.jp/path'},{nonce:'../production'},{expiresAt:2000},{issuedAt:3000},{expiresAt:1000+7200001},{token:'unaccepted'}])assert.throws(()=>validate({...m,...patch},2000),/MANIFEST_REQUIRED/);
});
test('target proof reads only six fixed metadata paths and revalidates every invocation',async()=>{
 const f=fixture(),t=create(f);assert.deepEqual(await t.assertTarget(),{storageAndOriginVerified:true});assert.equal(f.calls.length,6);
 assert.ok(f.calls.every(v=>v.url.includes('/accounts/'+f.target.accountId+'/')&&!v.url.endsWith('/query')));
 f.rows[2].name='videoq-prod-db';await assert.rejects(t.assertTarget(),/TARGET_DRIFT/);assert.equal(f.calls.length,12);
});
test('mixed bindings, duplicate names, wrong owner subdomain or geometry are rejected',async()=>{
 for(const mutate of [
 f=>{f.rows[0].subdomain='another-account';},
 f=>{f.settings.bindings[0].id='e57d0931-18cb-4f00-ae7f-b0068030fb04';},
 f=>{f.settings.bindings[0].database_id='conflicting';},
 f=>{f.settings.bindings.push(f.settings.bindings[1]);},
 f=>{f.settings.bindings.push({name:'EXTRA_DB',type:'d1',id:'e57d0931-18cb-4f00-ae7f-b0068030fb04'});},
 f=>{f.settings.bindings.push({name:'EXTRA_STORAGE',type:'r2_bucket',bucket_name:'videoq-media-prod'});},
 f=>{f.settings.bindings.push({name:'HYPERDRIVE',type:'hyperdrive',id:'legacy'});},
 f=>{f.settings.bindings[1].index_name='videoq-prod-scenes-1536';},
 f=>{f.rows[4].config.dimensions=1536;},
 f=>{f.rows[3].config.metric='euclidean';},
 f=>{f.rows[5].name='videoq-media-prod';},
 f=>{f.settings.bindings.find(v=>v.name==='BETTER_AUTH_URL').text='https://videoq.jp';},
 ]){const f=fixture();mutate(f);await assert.rejects(create(f).assertTarget(),/TARGET_DRIFT/);}
});
test('expiry before or during metadata reads refuses proof; caller cannot rewrite captured manifest',async()=>{
 const f=fixture(),t=create(f);f.input.databaseId='e57d0931-18cb-4f00-ae7f-b0068030fb04';assert.deepEqual(await t.assertTarget(),{storageAndOriginVerified:true});
 f.setClock(100000);await assert.rejects(t.assertTarget(),/MANIFEST_REQUIRED/);assert.equal(f.calls.length,6);
 const g=fixture(),fetcher=async(...args)=>{const value=await g.fetcher(...args);g.setClock(100000);return value;};await assert.rejects(create({...g,fetcher}).assertTarget(),/MANIFEST_REQUIRED/);
});
test('upload URLs stay in the exact nonce bucket and fixed account, expire with context',()=>{
 const f=fixture(),t=create(f),prefix='https://'+t.accountId+'.r2.cloudflarestorage.com/';assert.equal(t.uploadAllowed(prefix+t.bucket+'/fixture.mp4?signature=synthetic'),true);
 for(const url of [prefix+'videoq-media-prod/fixture.mp4',prefix+t.bucket+'-other/fixture.mp4','http://'+t.accountId+'.r2.cloudflarestorage.com/'+t.bucket+'/fixture.mp4',prefix+t.bucket+'/../videoq-media-prod/a',t.origin+'/fixture.mp4'])assert.equal(t.uploadAllowed(url),false);
 f.setClock(100000);assert.equal(t.uploadAllowed(prefix+t.bucket+'/fixture.mp4'),false);
});
test('bad credentials and unavailable, oversized or malformed metadata never produce a proof',async()=>{
 const f=fixture();assert.throws(()=>create({...f,env:{...f.env,CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32)}}),/CREDENTIAL_REQUIRED/);
 for(const response of [()=>new Response('',{status:403}),()=>Response.json({success:false}),()=>new Response('x'.repeat(1024*1024+1)),()=>new Response('not-json')])await assert.rejects(create({...f,fetcher:async()=>response()}).assertTarget(),/METADATA_UNAVAILABLE/);
});
