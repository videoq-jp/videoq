const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {readFileSync,readdirSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {smokeBackend,d1SmokeStore,postgresSmokeStore}=require('./production-smoke-store.cjs');
const id='373d6ca5-2796-460d-8ab1-e644de46bb3c';
const settings=()=>({bindings:[{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'d1'},{name:'DEPLOYMENT_EDITION',type:'plain_text',text:'cloud'},{name:'DB',type:'d1',id}]});
const user=()=>{const id=randomUUID();return{id,username:'ops_smoke_'+id,email:id+'@example.invalid',name:'VideoQ automated smoke check',role:'user',quota_source:'admin'};};
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync('apps/api/drizzle-d1').filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync('apps/api/drizzle-d1/'+name,'utf8'));
 let deployed=settings(),beforeQuery;const calls=[];
 const env={CLOUDFLARE_ACCOUNT_ID:'12daec56fdba43f677f2766ee26a5a39',CLOUDFLARE_API_TOKEN:'synthetic-token',VIDEOQ_SMOKE_IDENTITY_KEY:'a'.repeat(64),VIDEOQ_SMOKE_D1_DATABASE_ID:id};
 const fetcher=async(url,options)=>{
  assert.equal(options.redirect,'error');
  if(url.endsWith('/settings'))return Response.json({success:true,result:deployed});
  assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/d1/database/'+id+'/query');
  const {sql,params}=JSON.parse(options.body);calls.push({sql,params});beforeQuery?.(sql);
  // D1 counts cascading writes in metadata. Mutation proof must use RETURNING,
  // not assume a user deletion reports changes===1.
  const before=db.prepare('SELECT total_changes() n').get().n;
  const statement=db.prepare(sql);const results=statement.all(...params);const changes=db.prepare('SELECT total_changes() n').get().n-before;
  return Response.json({success:true,result:[{success:true,results,meta:{changes}}]});
 };
 return{db,calls,store:d1SmokeStore({env,fetcher}),setSettings:value=>{deployed=value;},beforeQuery:callback=>{beforeQuery=callback;},close:()=>db.close()};
}
test('backend selection rejects ambiguous, paused or incomplete cloud bindings',()=>{
 assert.deepEqual(smokeBackend({bindings:[]}),{backend:'postgres'});assert.deepEqual(smokeBackend(settings()),{backend:'d1',databaseId:id});
 for(const value of [null,{bindings:[...settings().bindings,{name:'DB',type:'d1',id}]},{bindings:settings().bindings.filter(v=>v.name!=='DEPLOYMENT_EDITION')},{bindings:[...settings().bindings,{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'}]},{bindings:[{name:'PERSISTENCE_BACKEND',type:'plain_text',text:'unknown'}]}])assert.throws(()=>smokeBackend(value));
});
test('real migrated SQLite schema supports synthetic creation, password rotation, expiry and cleanup',async()=>{
 const f=fixture();try{
  const u=user();await f.store.connect();await f.store.createUser(u,'h'.repeat(64),true);
  assert.deepEqual((await f.store.oldUsers()).map(v=>v.id),[u.id]);
  assert.equal(f.db.prepare('SELECT ai_answers_limit n FROM users WHERE id=?').get(u.id).n,3);
  await f.store.password(u,'j'.repeat(64));assert.equal(f.db.prepare('SELECT password FROM account WHERE user_id=?').get(u.id).password,'j'.repeat(64));
  f.db.prepare("INSERT INTO session(id,token,user_id,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00.000Z')").run(randomUUID(),randomUUID(),u.id);await f.store.expire(u);
  assert.ok(Date.parse(f.db.prepare('SELECT expires_at FROM session WHERE user_id=?').get(u.id).expires_at)<Date.now()+3_601_000);
  assert.deepEqual(await f.store.videos(u),[]);assert.equal(await f.store.processingVisuals(u),0);assert.equal(await f.store.pendingCleanup(u),0);assert.deepEqual(await f.store.courses(u),[]);assert.equal(await f.store.sceneCount(u,1),0);assert.equal(await f.store.hasChatLog(u,1),false);
  assert.equal(await f.store.deleteUser(u),true);assert.equal(f.db.prepare('SELECT count(*) n FROM account').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM session').get().n,0);
 }finally{f.close();}
});
test('customer-controlled synthetic fields or a copied signed image cannot authorize customer writes',async()=>{
 const f=fixture();try{
  const legit=user(),impostor=user();await f.store.createUser(legit,'h'.repeat(64),false);
  const marker=f.db.prepare('SELECT image FROM users WHERE id=?').get(legit.id).image;
  f.db.prepare(`INSERT INTO users(id,username,email,name,image,quota_source,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,?,'admin',0,0,0,0)`).run(impostor.id,impostor.username,impostor.email,impostor.name,marker);
  assert.deepEqual((await f.store.oldUsers()).map(v=>v.id),[legit.id]);
  for(const operation of [()=>f.store.password(impostor,'x'.repeat(64)),()=>f.store.expire(impostor),()=>f.store.deleteUser(impostor),()=>f.store.videos(impostor)])await assert.rejects(operation,/UNPROVEN_SMOKE_IDENTITY/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM users WHERE id=?').get(impostor.id).n,1);
 }finally{f.close();}
});
test('mutation repeats the signed predicate if the identity changes after observation',async()=>{
 const f=fixture();try{
  const u=user();await f.store.createUser(u,'h'.repeat(64),false);
  f.beforeQuery(sql=>{if(sql.startsWith('UPDATE account'))f.db.prepare("UPDATE users SET image='changed' WHERE id=?").run(u.id);});
  await assert.rejects(()=>f.store.password(u,'x'.repeat(64)),/SMOKE_IDENTITY_CHANGED/);assert.equal(f.db.prepare('SELECT password FROM account WHERE user_id=?').get(u.id).password,'h'.repeat(64));
 }finally{f.close();}
});
test('an interrupted create is reconciled only for a proven synthetic identity',async()=>{
 const f=fixture();try{
  const u=user();await f.store.createUser(u,'h'.repeat(64),false);f.db.prepare('DELETE FROM account WHERE user_id=?').run(u.id);await f.store.password(u,'x'.repeat(64));assert.equal(f.db.prepare('SELECT count(*) n FROM account WHERE user_id=?').get(u.id).n,1);
  f.db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES(?,?,'credential',?,?)").run(randomUUID(),u.id,u.id,'h'.repeat(64));await assert.rejects(()=>f.store.password(u,'y'.repeat(64)),/SMOKE_CREDENTIAL_COLLISION/);
 }finally{f.close();}
});
test('backend or D1 target change is rejected before SQL',async()=>{
 const f=fixture();try{
  f.setSettings({bindings:[]});await assert.rejects(()=>f.store.oldUsers(),/SMOKE_BACKEND_CHANGED/);assert.equal(f.calls.length,0);
  const other=settings();other.bindings.find(v=>v.name==='DB').id=randomUUID();f.setSettings(other);await assert.rejects(()=>f.store.oldUsers(),/SMOKE_BACKEND_CHANGED/);assert.equal(f.calls.length,0);
 }finally{f.close();}
});
test('PostgreSQL store keeps the existing security-definer create transaction',async()=>{
 const calls=[],db={query:async(...args)=>{calls.push(args);return{rows:[]};}};const store=postgresSmokeStore(db),u=user();await store.createUser(u,'h'.repeat(64),true);
 assert.deepEqual(calls,[['BEGIN'],['SELECT videoq_security.smoke_create($1::uuid,$2,$3)',[u.id,'h'.repeat(64),true]],['COMMIT']]);
});
