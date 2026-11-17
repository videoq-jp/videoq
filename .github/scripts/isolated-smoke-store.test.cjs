const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{readFileSync,readdirSync}=require('node:fs'),{randomUUID}=require('node:crypto');
const {isolatedD1SmokeStore,d1SmokeStore}=require('./production-smoke-store.cjs');
const {validateIsolatedSmokeManifest:validate}=require('./isolated-smoke-target.cjs');
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync('apps/api/drizzle-d1').filter(v=>v.endsWith('.sql')).sort())db.exec(readFileSync('apps/api/drizzle-d1/'+name,'utf8'));
 const manifest={version:1,nonce:'a'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:100000};
 let active=validate(manifest,2000),clock=2000;const queries=[];
 const env={CLOUDFLARE_ACCOUNT_ID:active.accountId,CLOUDFLARE_API_TOKEN:'synthetic-token-only-for-tests',VIDEOQ_SMOKE_D1_DATABASE_ID:manifest.databaseId,VIDEOQ_SMOKE_IDENTITY_KEY:'c'.repeat(64)};
 const fetcher=async(url,options)=>{
  const prefix='https://api.cloudflare.com/client/v4/accounts/'+active.accountId+'/',suffix=url.slice(prefix.length);assert.ok(url.startsWith(prefix));assert.equal(options.redirect,'error');
  if(suffix===`d1/database/${manifest.databaseId}/query`){assert.equal(options.method,'POST');const {sql,params}=JSON.parse(options.body);queries.push(sql);const results=db.prepare(sql).all(...params);return Response.json({success:true,result:[{success:true,results}]});}
  assert.equal(options.method,'GET');let result;
  if(suffix==='workers/subdomain')result={subdomain:active.workersSubdomain};
  else if(suffix===`d1/database/${manifest.databaseId}`)result={uuid:manifest.databaseId,name:active.databaseName};
  else if(suffix.startsWith('vectorize/')){const dimensions=suffix.endsWith('1536')?1536:768;result={name:dimensions===1536?active.largeIndex:active.smallIndex,config:{dimensions,metric:'cosine'}};}
  else if(suffix===`r2/buckets/${active.bucket}`)result={name:active.bucket};
  else if(suffix.endsWith('/settings'))result={bindings:[{name:'DB',type:'d1',id:active.databaseId},{name:'SCENE_VECTORIZE_1536',type:'vectorize',index_name:active.largeIndex},{name:'SCENE_VECTORIZE_768',type:'vectorize',index_name:active.smallIndex},{name:'VIDEO_BUCKET',type:'r2_bucket',bucket_name:active.bucket},...Object.entries({DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',MIGRATION_TRAFFIC_STATE:'running',BETTER_AUTH_URL:active.origin,OAUTH_ISSUER_URL:active.origin,FRONTEND_URL:active.origin,CORS_ALLOW_ORIGIN:active.origin,R2_BUCKET_NAME:active.bucket}).map(([name,text])=>({name,type:'plain_text',text}))]};
  else assert.fail('unexpected metadata path');return Response.json({success:true,result});
 };
 const store=isolatedD1SmokeStore({manifest,env,fetcher,now:()=>clock});
 return{db,manifest,env,fetcher,store,queries,setActive:value=>{active=value;},expire:()=>{clock=100000;}};
}
const user=()=>{const id=randomUUID();return{id,username:'ops_smoke_'+id,email:id+'@example.invalid',name:'VideoQ automated smoke check',role:'user',quota_source:'admin'};};
test('isolated factory uses all real SQLite migrations and preserves synthetic CRUD predicates',async t=>{
 const f=fixture(t),u=user();await f.store.connect();await f.store.createUser(u,'h'.repeat(64),true);assert.deepEqual((await f.store.oldUsers()).map(v=>v.id),[u.id]);
 const record=f.db.prepare('SELECT image,ai_answers_limit FROM users WHERE id=?').get(u.id);assert.ok(record.image.startsWith('https://videoq-isolated-api-'));assert.equal(record.ai_answers_limit,3);
 await f.store.password(u,'j'.repeat(64));assert.equal(f.db.prepare('SELECT password FROM account WHERE user_id=?').get(u.id).password,'j'.repeat(64));assert.deepEqual(await f.store.videos(u),[]);assert.equal(await f.store.sceneCount(u,1),0);assert.equal(await f.store.deleteUser(u),true);assert.equal(f.db.prepare('SELECT count(*) n FROM account').get().n,0);
});
test('same key and synthetic fields cannot authorize another isolated run or production marker realm',async t=>{
 const f=fixture(t),u=user();await f.store.createUser(u,'h'.repeat(64),true);
 const production=d1SmokeStore({env:f.env,fetcher:f.fetcher});assert.deepEqual(await production.oldUsers(),[]);await assert.rejects(production.password(u,'j'.repeat(64)),/UNPROVEN_SMOKE_IDENTITY/);
 const other={...f.manifest,nonce:'b'.repeat(16)};f.setActive(validate(other,2000));const isolated=isolatedD1SmokeStore({manifest:other,env:f.env,fetcher:f.fetcher,now:()=>2000});assert.deepEqual(await isolated.oldUsers(),[]);await assert.rejects(isolated.password(u,'j'.repeat(64)),/UNPROVEN_SMOKE_IDENTITY/);
});
test('binding drift or expiry stops before SQL; mismatch cannot retarget a factory',async t=>{
 const f=fixture(t),u=user();assert.throws(()=>isolatedD1SmokeStore({manifest:f.manifest,env:{...f.env,VIDEOQ_SMOKE_D1_DATABASE_ID:'e57d0931-18cb-4f00-ae7f-b0068030fb04'},fetcher:f.fetcher,now:()=>2000}),/DATABASE_REQUIRED/);
 f.setActive({...validate(f.manifest,2000),databaseName:'videoq-prod-db'});await assert.rejects(f.store.createUser(u,'h'.repeat(64),true),/TARGET_DRIFT/);assert.equal(f.queries.length,0);
 f.expire();await assert.rejects(f.store.oldUsers(),/MANIFEST_REQUIRED/);assert.equal(f.queries.length,0);
});
