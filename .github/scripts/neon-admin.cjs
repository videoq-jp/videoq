const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { OWNER, PROFILES, JOURNAL, ROTATE_AFTER_DAYS, loginName, connectionUrl, encodeJournal, decodeJournal, retirementRole } = require('./neon-policy.cjs');
const postgres = () => createRequire(join(__dirname, '../operations-tools/package.json'))('pg');
const REGION = 'ap-northeast-1';
const ADMIN = '/videoq/security/prod/db-admin';
const HYPERDRIVE = 'd69ecb01a493415197e52552db2990f8';
const FUNCTION = 'videoq-worker-prod';
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
function aws(service, command, input = {}) {
  // CLI input may contain credentials. Keep values out of argv and remove the private
  // input directory even on failure; GitHub-hosted runners discard their disks.
  const directory=mkdtempSync(join(tmpdir(),'videoq-neon-'));
  const path=join(directory,'input.json');
  try {
    writeFileSync(path,JSON.stringify(input),{mode:0o600});
    return JSON.parse(execFileSync(process.env.VIDEOQ_AWS_CLI || 'aws',
      [service, command, '--region', REGION, '--output', 'json', '--no-cli-pager', '--cli-input-json', 'file://'+path],
      { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 120000 }));
  } catch { throw new Error(`AWS_${service}_${command}_FAILED`.toUpperCase().replaceAll('-','_')); }
  finally { rmSync(directory,{recursive:true,force:true}); }
}
function readParameter(name, optional = false) {
  try {
    const result = aws('ssm','get-parameter',{Name:name,WithDecryption:true}).Parameter;
    if (result.Type !== 'SecureString') throw new Error('EXPECTED_SECURESTRING');
    const parsed=JSON.parse(result.Value);
    return { ...(name===JOURNAL?decodeJournal(parsed):parsed), parameterVersion: result.Version };
  } catch (error) {
    if (!optional) throw error;
    // Check metadata separately so access errors never masquerade as a missing secret.
    const found = aws('ssm','describe-parameters',{ParameterFilters:[{Key:'Name',Option:'Equals',Values:[name]}]});
    if (found.Parameters.length) throw error;
    return null;
  }
}
function writeParameter(name, value) {
  return aws('ssm','put-parameter',{Name:name,Type:'SecureString',Value:name===JOURNAL?encodeJournal(value):JSON.stringify(value),Overwrite:true}).Version;
}
async function connect(url) {
  const normalized = new URL(url); normalized.searchParams.set('sslmode','verify-full');
  const {Client}=postgres();
  const client = new Client({connectionString:normalized.toString(),connectionTimeoutMillis:15000,
    statement_timeout:30000,application_name:'videoq-db-maintenance'});
  try { await client.connect(); return client; } catch (e) { await client.end().catch(()=>{}); throw e; }
}
async function using(url, callback) {
  const client=await connect(url); try{return await callback(client);}finally{await client.end();}
}
async function denied(client, sql, values = []) {
  await client.query('BEGIN');
  let code;
  try { await client.query(sql, values); } catch(e) { code=e.code; }
  finally { await client.query('ROLLBACK'); }
  if (code !== '42501') throw new Error('PRIVILEGE_DENIAL_NOT_PROVEN');
}
async function verifyRole(purpose, url) {
  return using(url, async client => {
    // Prove ACL denial even if a read-only login changes its session default.
    if(['backup','audit'].includes(purpose)) await client.query('SET default_transaction_read_only=off');
    const {rows:[role]}=await client.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=session_user`);
    if (role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolbypassrls) throw new Error('EXCESSIVE_DATABASE_PRIVILEGES');
    if (purpose==='migration') {
      if(role.current_user!==OWNER) throw new Error('UNSTABLE_SCHEMA_OWNER');
      await client.query('BEGIN');
      try {await client.query(`CREATE TABLE public.${quote('rotation_probe_'+randomBytes(8).toString('hex'))}(id int)`);}
      finally{await client.query('ROLLBACK');}
    } else {
      await denied(client,'CREATE TABLE public.rotation_denial_probe(id int)');
    }
    if(purpose==='api') {
      await client.query('SELECT id FROM public.users LIMIT 0');
      await client.query('UPDATE public.users SET used_ai_answers=0 WHERE false');
      await denied(client,'SELECT * FROM drizzle.__drizzle_migrations LIMIT 0');
      await denied(client,'SELECT * FROM public.app_user LIMIT 0');
    }
    if(purpose==='worker') {
      await client.query('SELECT id,user_id,title,transcript,status,source_type,file,youtube_video_id,transcription_language FROM public.videos LIMIT 0');
      await client.query('SELECT langchain_id FROM public.scene_embeddings_768 LIMIT 0');
      await client.query("UPDATE public.videos SET status='processing',transcript='',processing_seconds=0,error_message='' WHERE false");
      await client.query("UPDATE public.video_transcription_chunks SET segments='[]'::jsonb,fallback_segments='{}'::jsonb,failures=0,last_error='',updated_at=now() WHERE false");
      await client.query("UPDATE public.video_visual_chunks SET frame_count=0,failures=0,last_error='',updated_at=now() WHERE false");
      await client.query('UPDATE public.video_transcription_runs SET completed_at=NULL WHERE false');
      await client.query("UPDATE public.video_visual_runs SET status='ready',last_error='',completed_at=NULL WHERE false");
      await denied(client,"UPDATE public.videos SET user_id='permission_probe' WHERE false");
      await denied(client,"UPDATE public.users SET role='admin' WHERE false");
      await denied(client,'SELECT password FROM public.account LIMIT 0');
    }
    if(purpose==='backup') {
      await client.query('SELECT * FROM drizzle.__drizzle_migrations LIMIT 0');
      await client.query('SELECT * FROM public.account LIMIT 0');
      await denied(client,'UPDATE public.users SET used_ai_answers=0 WHERE false');
    }
    if(['audit','demo'].includes(purpose)) {
      await client.query('SELECT id FROM videoq_security.demo_users');
      await denied(client,'SELECT password FROM public.account LIMIT 0');
      await denied(client,'UPDATE public.users SET ai_answers_limit=100 WHERE false');
      if(purpose==='audit') await denied(client,"SELECT videoq_security.demo_prepare(gen_random_uuid(),repeat('x',64))");
      if(purpose==='demo') {
        await client.query('BEGIN');
        try {
          const {rows:before}=await client.query('SELECT id,used_ai_answers FROM videoq_security.demo_users');
          if(before.length!==1) throw new Error('DEMO_IDENTITY_NOT_UNIQUE');
          await client.query("SELECT videoq_security.demo_prepare($1::uuid,repeat('x',64))",[before[0].id]);
          const {rows:after}=await client.query('SELECT id,used_ai_answers FROM videoq_security.demo_users');
          if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('DEMO_USAGE_COUNTER_CHANGED');
        } finally {await client.query('ROLLBACK');}
      }
    }
    if(purpose==='smoke') {
      await client.query('SELECT id FROM videoq_security.smoke_users');
      await denied(client,"UPDATE public.users SET role='admin' WHERE false");
      await denied(client,'SELECT password FROM public.account LIMIT 0');
      await client.query('BEGIN');
      try {
        const {rows:[{id}]}=await client.query('SELECT gen_random_uuid()::text AS id');
        await client.query("SELECT videoq_security.smoke_create($1::uuid,repeat('x',64),false)",[id]);
        const {rows}=await client.query('SELECT id,ai_answers_limit FROM videoq_security.smoke_users WHERE id=$1',[id]);
        if(rows.length!==1||rows[0].ai_answers_limit!==0) throw new Error('SMOKE_IDENTITY_SCOPE_FAILED');
        await client.query('SELECT videoq_security.smoke_delete($1)',[id]);
      } finally {await client.query('ROLLBACK');}
    }
    return {purpose,login:role.session_user};
  });
}
async function securitySchema(admin) {
  await using(admin, async client=>{
    await client.query('BEGIN');
    try {await client.query(readFileSync(join(__dirname,'../../infra/sql/neon-security.sql'),'utf8'));await client.query('COMMIT');}
    catch(e){await client.query('ROLLBACK');throw e;}
  });
}
async function createLogin(admin, purpose, entry) {
  const user=new URL(entry.DATABASE_URL);
  if(decodeURIComponent(user.username)!==loginName(purpose,entry.generation)||!user.password) throw new Error('UNEXPECTED_CANDIDATE_LOGIN');
  await using(admin,async client=>{
    await client.query('BEGIN');
    try {
      const found=await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[user.username]);
      if(!found.rowCount) {
        await client.query(`CREATE ROLE ${quote(user.username)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(decodeURIComponent(user.password))}`);
        await client.query(`GRANT ${quote(PROFILES[purpose].access)} TO ${quote(user.username)}`);
      }
      if(['backup','audit'].includes(purpose)) await client.query(`ALTER ROLE ${quote(user.username)} SET default_transaction_read_only=on`);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}
  });
  await verifyRole(purpose,entry.DATABASE_URL);
}
async function bootstrap() {
  const admin=readParameter(ADMIN).DATABASE_URL;
  await securitySchema(admin);
  const generation=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'_'+randomBytes(4).toString('hex');
  for(const purpose of ['worker','backup','audit','smoke','demo']) {
    const profile=PROFILES[purpose];
    let entry=readParameter(profile.parameter,true);
    if(!entry || (purpose==='worker' && !entry.created_at)) {
      entry={DATABASE_URL:connectionUrl(admin,purpose,loginName(purpose,generation),randomBytes(48).toString('base64url')),
        purpose,generation,created_at:new Date().toISOString()};
      await createLogin(admin,purpose,entry);
      writeParameter(profile.parameter,entry);
    }
    await verifyRole(purpose,entry.DATABASE_URL);
    console.log('Scoped database access ready: '+purpose);
  }
}
async function cloudflare(method, body) {
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
  if(!/^[a-f0-9]{32}$/.test(account||'')||!token) throw new Error('CLOUDFLARE_CONFIGURATION_REQUIRED');
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs/${HYPERDRIVE}`,
    {method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(60000)});
  const data=await response.json();
  if(!response.ok||!data.success) throw new Error('HYPERDRIVE_UPDATE_FAILED');
  return data.result;
}
async function pointHyperdrive(url, acceptedUsers) {
  const u=new URL(url),old=await cloudflare('GET');
  if(old.id!==HYPERDRIVE||old.origin.host.replace('-pooler.','.')!==u.hostname.replace('-pooler.','.')||old.origin.database!==decodeURIComponent(u.pathname.slice(1))||!acceptedUsers.includes(old.origin.user)) throw new Error('UNEXPECTED_HYPERDRIVE_ORIGIN');
  // PATCH changes the login only; existing TLS/CA/network configuration is preserved.
  await cloudflare('PATCH',{origin:{...old.origin,password:decodeURIComponent(u.password),user:decodeURIComponent(u.username)},caching:{...old.caching,disabled:true}});
  const current=await cloudflare('GET');
  if(current.origin.user!==decodeURIComponent(u.username)||current.caching.disabled!==true) throw new Error('HYPERDRIVE_VERIFICATION_FAILED');
}
async function refreshLambda(generation) {
  for(let i=0;i<60;i++) {
    const config=aws('lambda','get-function-configuration',{FunctionName:FUNCTION});
    if(![PROFILES.api.parameter,PROFILES.worker.parameter].includes(config.Environment?.Variables?.DB_PARAM_NAME)) throw new Error('UNEXPECTED_LAMBDA_DATABASE_PARAMETER');
    if(config.LastUpdateStatus==='InProgress') {await delay(5000);continue;}
    aws('lambda','update-function-configuration',{FunctionName:FUNCTION,RevisionId:config.RevisionId,
      Environment:{Variables:{...config.Environment.Variables,DB_PARAM_NAME:PROFILES.worker.parameter,DB_CREDENTIAL_GENERATION:generation,PGSSLROOTCERT:'/etc/pki/tls/certs/ca-bundle.crt'}}});
    for(let n=0;n<90;n++) {
      const next=aws('lambda','get-function-configuration',{FunctionName:FUNCTION});
      if(next.LastUpdateStatus==='Successful') return next.Timeout;
      if(next.LastUpdateStatus==='Failed') throw new Error('LAMBDA_REFRESH_FAILED');
      await delay(5000);
    }
    throw new Error('LAMBDA_REFRESH_TIMEOUT');
  }
  throw new Error('LAMBDA_UPDATE_BUSY');
}
async function prepare(force=false) {
  const pending=readParameter(JOURNAL,true);
  if(pending&&!['complete','rolled_back'].includes(pending.phase)) return pending;
  if(pending?.phase==='rolled_back'&&!force) throw new Error('ROLLED_BACK_ROTATION_REQUIRES_REVIEW');
  const profiles={};
  for(const [purpose,profile] of Object.entries(PROFILES)) profiles[purpose]=readParameter(profile.parameter);
  const due=Object.values(profiles).some(p=>!Number.isFinite(Date.parse(p.created_at))||Date.now()-Date.parse(p.created_at)>=ROTATE_AFTER_DAYS*86400000);
  if(!force&&!due) {console.log('Database credentials are within the rotation interval');return null;}
  const generation=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'_'+randomBytes(4).toString('hex');
  const admin=readParameter(ADMIN).DATABASE_URL;
  const journal={generation,phase:'prepared',created_at:new Date().toISOString(),entries:{}};
  for(const [purpose,old] of Object.entries(profiles)) {
    const next={DATABASE_URL:connectionUrl(admin,purpose,loginName(purpose,generation),randomBytes(48).toString('base64url')),
      purpose,generation,created_at:journal.created_at};
    journal.entries[purpose]={old,next};
  }
  // Persist encrypted recovery material before creating or changing any credentials.
  writeParameter(JOURNAL,journal);
  for(const [purpose,entry] of Object.entries(journal.entries)) await createLogin(admin,purpose,entry.next);
  return journal;
}
async function promote(journal) {
  const admin=readParameter(ADMIN).DATABASE_URL;
  for(const [purpose,entry] of Object.entries(journal.entries)) {
    await createLogin(admin,purpose,entry.next);
    const current=readParameter(PROFILES[purpose].parameter);
    if(![entry.old.DATABASE_URL,entry.next.DATABASE_URL].includes(current.DATABASE_URL)) throw new Error('DATABASE_PARAMETER_CHANGED_EXTERNALLY');
  }
  await pointHyperdrive(journal.entries.api.next.DATABASE_URL,[journal.entries.api.old,journal.entries.api.next].map(e=>decodeURIComponent(new URL(e.DATABASE_URL).username)));
  for(const [purpose,entry] of Object.entries(journal.entries)) writeParameter(PROFILES[purpose].parameter,entry.next);
  const timeout=await refreshLambda(journal.generation);
  journal.phase='promoted';journal.promoted_at=new Date().toISOString();
  // Old Lambda invocations may reconnect using their cached URL until their timeout.
  journal.retire_after=new Date(Date.now()+(timeout+60)*1000).toISOString();
  writeParameter(JOURNAL,journal);
  return journal;
}
async function verifyCurrent() {
  const checked=[];
  for(const [purpose,profile] of Object.entries(PROFILES)) checked.push(await verifyRole(purpose,readParameter(profile.parameter).DATABASE_URL));
  console.log(JSON.stringify({status:'database_privileges_verified',profiles:checked}));
  for(const path of ['/health','/ready']) {
    const response=await fetch('https://videoq.jp'+path,{redirect:'error',signal:AbortSignal.timeout(30000)});
    const body=await response.json();
    if(!response.ok||(path==='/ready'&&body.data?.db!=='ok')) throw new Error('PRODUCTION_READINESS_FAILED');
  }
}
async function retire(journal) {
  if(journal.phase!=='promoted') throw new Error('ROTATION_NOT_PROMOTED');
  if(!Number.isFinite(Date.parse(journal.retire_after))) throw new Error('INVALID_RETIREMENT_TIME');
  if(Date.now()<Date.parse(journal.retire_after)) throw new Error('OLD_LAMBDA_INVOCATIONS_MAY_STILL_BE_RUNNING');
  await verifyCurrent();
  const admin=readParameter(ADMIN).DATABASE_URL;
  await using(admin,async client=>{
    for(const [purpose,entry] of Object.entries(journal.entries)) {
      const old=decodeURIComponent(new URL(entry.old.DATABASE_URL).username);
      const next=decodeURIComponent(new URL(entry.next.DATABASE_URL).username);
      retirementRole(purpose,old);
      if(old===next) throw new Error('UNEXPECTED_RETIREMENT_ROLE');
      const {rows:[state]}=await client.query(`SELECT count(*)::int AS active FROM pg_stat_activity
        WHERE usename=$1 AND state='active'`,[old]);
      if(state.active) throw new Error('OLD_DATABASE_ROLE_STILL_ACTIVE');
      await client.query(`ALTER ROLE ${quote(old)} NOLOGIN PASSWORD NULL`);
      // Only terminate idle sessions after disabling new authentication; never interrupt a query.
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND state='idle'`,[old]);
      const {rows:[remaining]}=await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1',[old]);
      if(remaining.count) throw new Error('OLD_DATABASE_SESSIONS_NOT_DRAINED');
    }
    const legacy='videoq_worker_20261014';
    const {rows:[active]}=await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND state='active'",[legacy]);
    if(active.count) throw new Error('LEGACY_WORKER_ROLE_STILL_ACTIVE');
    await client.query(`ALTER ROLE ${quote(legacy)} NOLOGIN PASSWORD NULL`);
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND state='idle'",[legacy]);
  });
  for(const entry of Object.values(journal.entries)) {
    let rejected=false;
    try {await using(entry.old.DATABASE_URL,async()=>{});}catch(e){if(e.code==='28P01'||e.code==='28000') rejected=true;else throw e;}
    if(!rejected) throw new Error('OLD_DATABASE_CREDENTIAL_STILL_ACCEPTED');
  }
  await verifyCurrent();
  journal.phase='retired';journal.retired_at=new Date().toISOString();
  writeParameter(JOURNAL,journal);
}
function complete(journal) {
  if(journal.phase!=='retired') throw new Error('ROTATION_NOT_RETIRED');
  writeParameter(JOURNAL,{generation:journal.generation,phase:'complete',completed_at:new Date().toISOString(),
    retired:Object.values(journal.entries).map(e=>decodeURIComponent(new URL(e.old.DATABASE_URL).username))});
}

async function rollback(journal) {
  if(['rollback_pending','rollback_retired'].includes(journal.phase)) return journal;
  if(!journal.entries||journal.phase==='complete') throw new Error('NO_RECOVERABLE_ROTATION');
  const admin=readParameter(ADMIN).DATABASE_URL;
  // Restore old passwords first, including partially retired roles, before switching consumers back.
  await using(admin,async client=>{
    for(const [purpose,{old}] of Object.entries(journal.entries)) {
      const u=new URL(old.DATABASE_URL);
      retirementRole(purpose,decodeURIComponent(u.username));
      await client.query(`ALTER ROLE ${quote(decodeURIComponent(u.username))} LOGIN PASSWORD ${literal(decodeURIComponent(u.password))}`);
    }
  });
  await pointHyperdrive(journal.entries.api.old.DATABASE_URL,[journal.entries.api.old,journal.entries.api.next].map(e=>decodeURIComponent(new URL(e.DATABASE_URL).username)));
  for(const [purpose,entry] of Object.entries(journal.entries)) writeParameter(PROFILES[purpose].parameter,entry.old);
  const timeout=await refreshLambda('rollback-'+journal.generation);
  journal.phase='rollback_pending';journal.rollback_after=new Date(Date.now()+(timeout+60)*1000).toISOString();
  writeParameter(JOURNAL,journal);
  return journal;
}
async function finishRollback(journal) {
  if(journal.phase!=='rollback_pending'||!Number.isFinite(Date.parse(journal.rollback_after))) throw new Error('INVALID_ROLLBACK_PHASE');
  if(Date.now()<Date.parse(journal.rollback_after)) throw new Error('ROLLBACK_INVOCATIONS_MAY_STILL_BE_RUNNING');
  for(const {old} of Object.values(journal.entries)) await using(old.DATABASE_URL,async()=>{});
  const admin=readParameter(ADMIN).DATABASE_URL;
  await using(admin,async client=>{
    for(const [purpose,{next}] of Object.entries(journal.entries)) {
      const user=decodeURIComponent(new URL(next.DATABASE_URL).username);
      if(user!==loginName(purpose,journal.generation)) throw new Error('UNEXPECTED_CANDIDATE_LOGIN');
      const {rows:[active]}=await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=$1 AND state='active'",[user]);
      if(active.count) throw new Error('CANDIDATE_ROLE_STILL_ACTIVE');
      await client.query(`ALTER ROLE ${quote(user)} NOLOGIN PASSWORD NULL`);
      await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND state='idle'",[user]);
    }
  });
  for(const {next} of Object.values(journal.entries)) {
    let rejected=false;
    try{await using(next.DATABASE_URL,async()=>{});}catch(e){if(['28P01','28000'].includes(e.code))rejected=true;else throw e;}
    if(!rejected) throw new Error('ROLLED_BACK_CREDENTIAL_STILL_ACCEPTED');
  }
  journal.phase='rollback_retired';writeParameter(JOURNAL,journal);
}
function completeRollback(journal) {
  if(journal.phase!=='rollback_retired') throw new Error('ROLLBACK_NOT_RETIRED');
  writeParameter(JOURNAL,{phase:'rolled_back',generation:journal.generation,completed_at:new Date().toISOString()});
}

async function main() {
  const op=process.argv[2];
  if(op==='bootstrap') return bootstrap();
  if(op==='verify') return verifyCurrent();
  if(op==='prepare') return prepare(process.argv.includes('--force'));
  if(op==='promote') return promote(readParameter(JOURNAL));
  if(op==='retire') return retire(readParameter(JOURNAL));
  if(op==='rollback') return rollback(readParameter(JOURNAL));
  if(op==='audit') {
    for(const [purpose,profile] of Object.entries(PROFILES)) {
      const p=readParameter(profile.parameter);console.log(JSON.stringify({purpose,created_at:p.created_at||null,
        rotation_due:!Number.isFinite(Date.parse(p.created_at))||Date.now()-Date.parse(p.created_at)>=ROTATE_AFTER_DAYS*86400000}));
    }
    return;
  }
  throw new Error('UNKNOWN_DATABASE_MAINTENANCE_OPERATION');
}
module.exports={aws,readParameter,writeParameter,verifyRole,denied,prepare,promote,retire,complete,rollback,finishRollback,completeRollback,bootstrap,verifyCurrent,refreshLambda,PROFILES,JOURNAL};
if(require.main===module) main().catch(e=>{console.error('Database maintenance failed: '+(e.code||(/^[A-Z_]+$/.test(e.message)?e.message:e.name)));process.exitCode=1;});
