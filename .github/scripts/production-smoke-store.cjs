// Fixed business operations for the production smoke. PostgreSQL retains its
// security-definer boundary; D1 verifies an HMAC-bound synthetic identity and
// repeats that exact identity predicate in every mutation.
const {createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const {synthetic}=require('./production-smoke-policy.cjs');
const {readDeploymentSettings}=require('./protect-api-deployment.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
function smokeBackend(settings){
 if(!Array.isArray(settings?.bindings))throw Error('INVALID_SMOKE_BACKEND');
 const vars={};for(const name of ['DEPLOYMENT_EDITION','PERSISTENCE_BACKEND','MIGRATION_TRAFFIC_STATE']){
  const values=settings.bindings.filter(v=>v.name===name);if(values.length>1||values.some(v=>v.type!=='plain_text'||typeof v.text!=='string'))throw Error('INVALID_SMOKE_BACKEND');if(values.length)vars[name]=values[0].text;
 }
 if(vars.MIGRATION_TRAFFIC_STATE!==undefined&&vars.MIGRATION_TRAFFIC_STATE!=='running')throw Error('SMOKE_REQUIRES_RUNNING_API');
 if(vars.DEPLOYMENT_EDITION!==undefined&&!['cloud','onprem'].includes(vars.DEPLOYMENT_EDITION))throw Error('INVALID_SMOKE_BACKEND');
 const backend=vars.PERSISTENCE_BACKEND??(vars.DEPLOYMENT_EDITION==='cloud'?'d1':'postgres');
 if(backend==='postgres')return{backend};
 const databases=settings.bindings.filter(v=>v.name==='DB');
 if(backend!=='d1'||vars.DEPLOYMENT_EDITION!=='cloud'||databases.length!==1||databases[0].type!=='d1'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databases[0].id??''))throw Error('INVALID_SMOKE_BACKEND');
 return{backend,databaseId:databases[0].id};
}
function postgresSmokeStore(db){
 const rows=async(sql,params=[])=>(await db.query(sql,params)).rows;
 return{
  connect:()=>db.connect(),close:()=>db.end(),rollback:()=>db.query('ROLLBACK'),
  oldUsers:()=>rows(`SELECT id,username,email,name,role,quota_source FROM videoq_security.smoke_users WHERE username='ops_smoke_'||id AND email=id||'@example.invalid' AND name='VideoQ automated smoke check' AND role='user' AND quota_source='admin' ORDER BY created_at LIMIT 10`),
  createUser:async(user,password,ai)=>{await db.query('BEGIN');await db.query('SELECT videoq_security.smoke_create($1::uuid,$2,$3)',[user.id,password,ai]);await db.query('COMMIT');},
  password:(user,hash)=>db.query('SELECT videoq_security.smoke_password($1,$2)',[user.id,hash]),
  expire:user=>db.query('SELECT videoq_security.smoke_expire($1)',[user.id]),
  videos:user=>rows('SELECT id,status FROM videoq_security.smoke_videos WHERE user_id=$1',[user.id]),
  processingVisuals:async user=>Number((await rows(`SELECT count(*) FROM videoq_security.smoke_visual_runs r JOIN videoq_security.smoke_videos v ON v.id=r.video_id WHERE v.user_id=$1 AND r.status='processing'`,[user.id]))[0].count),
  pendingCleanup:async user=>Number((await rows(`SELECT count(*) FROM videoq_security.smoke_external_tasks WHERE kind='storage_cleanup' AND user_id=$1 AND completed_at IS NULL`,[user.id]))[0].count),
  courses:user=>rows('SELECT id FROM videoq_security.smoke_courses WHERE user_id=$1',[user.id]),
  deleteUser:async user=>(await rows('SELECT videoq_security.smoke_delete($1) AS removed',[user.id]))[0].removed===true,
  sceneCount:async(user,video)=>Number((await rows('SELECT count(*) FROM videoq_security.smoke_scene_embeddings WHERE user_id=$1 AND video_id=$2',[user.id,video]))[0].count),
  hasChatLog:async(user,id)=>(await rows('SELECT id FROM videoq_security.smoke_chat_logs WHERE id=$1 AND user_id=$2',[id,user.id])).length===1,
 };
}
function scopedD1SmokeStore({env=process.env,fetcher=fetch}={}){
 const key=env.VIDEOQ_SMOKE_IDENTITY_KEY,databaseId=env.VIDEOQ_SMOKE_D1_DATABASE_ID;
 if(env.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT||!/^[a-f0-9]{64}$/.test(key??'')||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(databaseId??'')||!env.CLOUDFLARE_API_TOKEN)throw Error('SCOPED_D1_SMOKE_CONTEXT_REQUIRED');
 const origin='https://videoq.jp',domain='videoq-production-smoke:v1:';
 const marker=user=>origin+'/favicon.ico?ops_smoke_v1='+createHmac('sha256',Buffer.from(key,'hex')).update(domain+user.id).digest('hex');
 const proven=user=>{if(!synthetic(user)||typeof user.image!=='string')return false;const expected=Buffer.from(marker(user)),actual=Buffer.from(user.image);return actual.length===expected.length&&timingSafeEqual(actual,expected);};
 const predicate="u.id=? AND u.username=? AND u.email=? AND u.name=? AND u.role='user' AND u.quota_source='admin' AND u.image=?";
 const parameters=user=>[user.id,user.username,user.email,user.name,user.image];
 async function assertTarget(){const selected=smokeBackend(await readDeploymentSettings(env,fetcher));if(selected.backend!=='d1'||selected.databaseId!==databaseId)throw Error('SMOKE_BACKEND_CHANGED');}
 async function query(sql,params=[]){
  await assertTarget();
  const response=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+databaseId+'/query',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({sql,params})});
  if(!response.ok||!response.body)throw Error('D1_SMOKE_QUERY_FAILED');let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.byteLength;if(size>256*1024)throw Error('D1_SMOKE_QUERY_FAILED');chunks.push(Buffer.from(chunk));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('D1_SMOKE_QUERY_FAILED');}
  if(body?.success!==true||body.result?.length!==1||body.result[0].success!==true||!Array.isArray(body.result[0].results))throw Error('D1_SMOKE_QUERY_FAILED');return body.result[0];
 }
 async function owned(user){if(!synthetic(user))throw Error('UNSAFE_SMOKE_IDENTITY');const found=(await query('SELECT id,username,email,name,role,quota_source,image FROM users WHERE id=?',[user.id])).results;if(found.length!==1||!proven(found[0]))throw Error('UNPROVEN_SMOKE_IDENTITY');return found[0];}
 const scoped=async(user,sql,extra=[])=>{const found=await owned(user);return query(sql,[...extra,...parameters(found)]);};
 const count=async(user,sql,extra=[])=>{const rows=(await scoped(user,sql,extra)).results;if(rows.length!==1||!Number.isSafeInteger(rows[0]?.count)||rows[0].count<0)throw Error('D1_SMOKE_COUNT_UNVERIFIED');return rows[0].count;};
 return{
  connect:assertTarget,close:async()=>{},rollback:async()=>{},
  oldUsers:async()=>(await query("SELECT id,username,email,name,role,quota_source,image FROM users WHERE username='ops_smoke_'||id AND email=id||'@example.invalid' AND name='VideoQ automated smoke check' AND role='user' AND quota_source='admin' ORDER BY created_at LIMIT 100")).results.filter(proven).slice(0,10),
  createUser:async(user,password,ai)=>{
   if(!synthetic(user)||typeof password!=='string'||password.length<32||password.length>1024||typeof ai!=='boolean')throw Error('UNSAFE_SMOKE_IDENTITY');
   // Each insert is independently retry-safe. A failed account creation leaves a
   // proven synthetic user that the next run can safely reconcile; no customer
   // record can satisfy the signed predicate.
   const created=await query(`INSERT INTO users(id,username,email,name,image,role,email_verified,password_reset_required,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,quota_source,processing_limit_minutes,ai_answers_limit,storage_limit_gb,monthly_upload_limit_gb) VALUES(?,?,?,?,?,'user',1,0,0,0,0,0,'admin',1,?,0.01,0.01) RETURNING id`,[user.id,user.username,user.email,user.name,marker(user),ai?3:0]);
   if(created.results.length!==1||created.results[0].id!==user.id)throw Error('SMOKE_IDENTITY_CHANGED');
   const credential=await scoped(user,`INSERT INTO account(id,account_id,provider_id,user_id,password) SELECT ?,?,'credential',?,? FROM users u WHERE ${predicate} RETURNING user_id`,[randomUUID(),user.id,user.id,password]);
   if(credential.results.length!==1||credential.results[0].user_id!==user.id)throw Error('SMOKE_IDENTITY_CHANGED');
  },
  password:async(user,password)=>{
   if(typeof password!=='string'||password.length<32||password.length>1024)throw Error('UNSAFE_SMOKE_PASSWORD');
   const found=await owned(user),p=parameters(found);
   const existing=(await query(`SELECT count(*) AS count FROM account WHERE provider_id='credential' AND user_id IN(SELECT u.id FROM users u WHERE ${predicate})`,p)).results[0].count;
   if(existing===0){const result=await scoped(user,`INSERT INTO account(id,account_id,provider_id,user_id,password) SELECT ?,?,'credential',?,? FROM users u WHERE ${predicate} RETURNING user_id`,[randomUUID(),user.id,user.id,password]);if(result.results.length!==1||result.results[0].user_id!==user.id)throw Error('SMOKE_IDENTITY_CHANGED');return;}
   if(existing!==1)throw Error('SMOKE_CREDENTIAL_COLLISION');
   const result=await scoped(user,`UPDATE account SET password=? WHERE provider_id='credential' AND user_id IN(SELECT u.id FROM users u WHERE ${predicate}) RETURNING user_id`,[password]);if(result.results.length!==1||result.results[0].user_id!==user.id)throw Error('SMOKE_IDENTITY_CHANGED');
  },
  expire:user=>scoped(user,`UPDATE session SET expires_at=min(expires_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')) WHERE user_id IN(SELECT u.id FROM users u WHERE ${predicate})`),
  videos:async user=>(await scoped(user,`SELECT id,status FROM videos WHERE user_id IN(SELECT u.id FROM users u WHERE ${predicate})`)).results,
  processingVisuals:user=>count(user,`SELECT count(*) AS count FROM video_visual_runs r JOIN videos v ON v.id=r.video_id WHERE r.status='processing' AND v.user_id IN(SELECT u.id FROM users u WHERE ${predicate})`),
  pendingCleanup:user=>count(user,`SELECT count(*) AS count FROM external_tasks WHERE kind='storage_cleanup' AND completed_at IS NULL AND json_extract(payload,'$.user_id') IN(SELECT u.id FROM users u WHERE ${predicate})`),
  courses:async user=>(await scoped(user,`SELECT id FROM video_courses WHERE user_id IN(SELECT u.id FROM users u WHERE ${predicate})`)).results,
  deleteUser:async user=>{const result=await scoped(user,`DELETE FROM users AS u WHERE ${predicate} AND NOT EXISTS(SELECT 1 FROM videos WHERE user_id=u.id) RETURNING id`);return result.results.length===1&&result.results[0].id===user.id;},
  sceneCount:(user,video)=>count(user,`SELECT count(*) AS count FROM scenes s JOIN videos v ON v.id=s.video_id WHERE v.id=? AND v.user_id IN(SELECT u.id FROM users u WHERE ${predicate})`,[video]),
  hasChatLog:async(user,id)=>(await scoped(user,`SELECT id FROM chat_logs WHERE id=? AND user_id IN(SELECT u.id FROM users u WHERE ${predicate})`,[id])).results.length===1,
 };
}
function d1SmokeStore(options={}){return scopedD1SmokeStore(options);}
module.exports={smokeBackend,postgresSmokeStore,d1SmokeStore};
