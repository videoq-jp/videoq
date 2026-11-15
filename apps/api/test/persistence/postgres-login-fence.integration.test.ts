import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {withPostgresLoginFenceTransaction} from '../../scripts/migrations/d1/fenced-postgres-transaction';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import * as applicationSchema from '../../src/db/schema';
import {loadMigrationSnapshot} from '../../scripts/d1-migration-manifest';
import {buildMigrationManifest,quoteMigrationIdentifier as q} from '../../scripts/migrations/d1/manifest';
import {restorePostwriteSnapshot,type RecoveryRows} from '../../scripts/migrations/d1/postwrite-recovery';
import {createD1Fixture} from './d1-fixture';
import {openPrivateInput} from '../../scripts/migrations/d1/private-input';
import {preparePostgresLoginFence,inspectPostgresLoginFence,installPostgresLoginFence,releasePostgresLoginFence,type PostgresLoginFenceTarget} from '../../scripts/migrations/d1/postgres-login-fence';
import {readPostgresCutoverActivity,assertNoActivePostgresLeases} from '../../scripts/migrations/d1/postgres-cutover-activity';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
async function fixture(){
 const source=new URL(url!),database='recovery_'+randomUUID().replaceAll('-',''),prefix=database+'_',password=randomUUID().replaceAll('-','');
 if(!['localhost','127.0.0.1','[::1]','::1'].includes(source.hostname))throw new Error('Login-fence test requires a loopback disposable server.');
 const admin=new pg.Client({connectionString:url});await admin.connect();await admin.query('CREATE DATABASE '+quote(database));source.pathname='/'+database;
 const connectionString=source.toString(),client=new pg.Client({connectionString});await client.connect();
 const roles={api:prefix+'api',smoke:prefix+'smoke',backup:prefix+'backup_1',retired:prefix+'retired',group:prefix+'access',quoted:prefix+'quoted"login'};
 const held:pg.Client[]=[];
 async function connectAs(name:string){const u=new URL(connectionString);u.username=name;u.password=password;const c=new pg.Client({connectionString:u.toString()});c.on('error',()=>{});held.push(c);await c.connect();return c;}
 try{
  for(const [key,name] of Object.entries(roles))await client.query('CREATE ROLE '+quote(name)+(key==='retired'||key==='group'?' NOLOGIN':' LOGIN')+" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"'");
  await client.query('CREATE TABLE public.fence_probe(value integer); GRANT USAGE ON SCHEMA public TO '+Object.values(roles).map(quote).join(','));
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.fence_probe TO '+quote(roles.group)+'; GRANT '+quote(roles.group)+' TO '+quote(roles.api));
  await client.query('GRANT SELECT ON public.fence_probe TO '+quote(roles.backup));
  await client.query("CREATE FUNCTION public.fence_smoke() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS 'INSERT INTO public.fence_probe VALUES (99)'; REVOKE ALL ON FUNCTION public.fence_smoke() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.fence_smoke() TO "+quote(roles.smoke));
  const target={purpose:'isolated-rehearsal',host:client.host,databaseName:database,rolePrefix:prefix} as PostgresLoginFenceTarget;
  return {client,roles,target,connectAs,connectionString,password,async dispose(){for(const c of held)await c.end().catch(()=>{});await client.end();await admin.query('DROP DATABASE '+quote(database)+' WITH (FORCE)');for(const role of Object.values(roles))await admin.query('DROP ROLE '+quote(role));await admin.end();}};
 }catch(error){await client.end();await admin.query('DROP DATABASE '+quote(database)+' WITH (FORCE)');for(const role of Object.values(roles))await admin.query('DROP ROLE IF EXISTS '+quote(role));await admin.end();throw error;}
}
describe.skipIf(!url)('PostgreSQL managed-login fence',()=>{
 it('persists a private plan and keeps the fence across independent operator processes, rejecting wrong destinations and confirmations',async()=>{
  const f=await fixture(),directory=await mkdtemp(join(tmpdir(),'videoq-login-fence-'));
  try{
   const target=join(directory,'target.json'),state=join(directory,'state.json');await writeFile(target,JSON.stringify(f.target),{mode:0o600});
   const env={...process.env};for(const key of Object.keys(env))if(!['PATH','HOME','TMPDIR','LANG'].includes(key))delete env[key];env.VIDEOQ_FENCE_ADMIN_DATABASE_URL=f.connectionString;env.VIDEOQ_MIGRATION_UPSTREAM_STOPPED='1';
   const command=(args:string[],vars=env)=>promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/d1-postgres-login-fence.ts'),...args],{env:vars,timeout:20000,maxBuffer:1024**2,encoding:'utf8'});
   expect(JSON.parse((await command(['--mode','prepare','--target',target,'--state',state])).stdout).prepared).toBe(true);
   const input=await openPrivateInput(state,1024**2);try{expect(input.info.mode&0o077).toBe(0);expect(await input.file.readFile('utf8')).not.toContain(f.password);}finally{await input.file.close();}
   await expect(command(['--mode','install','--state',state,'--confirm-database','wrong_database'])).rejects.toMatchObject({code:1});
   expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(true);
   expect(JSON.parse((await command(['--mode','install','--state',state,'--confirm-database',f.target.databaseName])).stdout).state).toBe('fenced');
   await expect(f.connectAs(f.roles.api)).rejects.toMatchObject({code:'28000'});
   const wrong=new URL(f.connectionString);wrong.hostname='attacker.invalid';
   await expect(command(['--mode','inspect','--state',state],{...env,VIDEOQ_FENCE_ADMIN_DATABASE_URL:wrong.toString()})).rejects.toMatchObject({code:1});
   expect(JSON.parse((await command(['--mode','inspect','--state',state])).stdout).state).toBe('fenced');
   expect(JSON.parse((await command(['--mode','release','--state',state,'--confirm-database',f.target.databaseName])).stdout).state).toBe('open');
   const api=await f.connectAs(f.roles.api);await api.query('INSERT INTO public.fence_probe VALUES (3)');
   await expect(f.connectAs(f.roles.retired)).rejects.toMatchObject({code:'28000'});
  }finally{await rm(directory,{recursive:true,force:true});await f.dispose();}
 },90000);

 it('stops new logins and existing transactions including SECURITY DEFINER callers, retaining ACL-readonly backups and retired roles',async()=>{
  const f=await fixture();try{
   const active=await f.connectAs(f.roles.api),smoke=await f.connectAs(f.roles.smoke),backup=await f.connectAs(f.roles.backup);
   await active.query('BEGIN; INSERT INTO public.fence_probe VALUES (1)');await smoke.query('SELECT 1');await backup.query('SET default_transaction_read_only=off');
   const plan=await preparePostgresLoginFence(f.client,f.target);expect((await inspectPostgresLoginFence(f.client,plan)).state).toBe('open');
   await expect(installPostgresLoginFence(f.client,plan,false)).rejects.toThrow('Externally stopped');
   const fenced=await installPostgresLoginFence(f.client,plan,true);expect(fenced.state).toBe('fenced');expect(fenced.writerLogins).toBe(3);expect(fenced.writerSessions).toBe(0);
   await expect(active.query('COMMIT')).rejects.toThrow();await expect(smoke.query('SELECT public.fence_smoke()')).rejects.toThrow();
   await expect(f.connectAs(f.roles.api)).rejects.toMatchObject({code:'28000'});await expect(f.connectAs(f.roles.smoke)).rejects.toMatchObject({code:'28000'});
   expect((await backup.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(0);
   await expect(backup.query('INSERT INTO public.fence_probe VALUES (5)')).rejects.toMatchObject({code:'42501'});
   expect((await installPostgresLoginFence(f.client,plan,true)).state).toBe('fenced');expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');
   const resumed=await f.connectAs(f.roles.api);await resumed.query('INSERT INTO public.fence_probe VALUES (2)');expect((await backup.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(1);
   await expect(f.connectAs(f.roles.retired)).rejects.toMatchObject({code:'28000'});
  }finally{await f.dispose();}
 },60000);
 it('refuses writable backup capabilities, role drift and prepared transactions without changing original login flags',async()=>{
  const f=await fixture();const extra=f.target.rolePrefix+'extra';let created=false;try{
   await f.client.query('GRANT EXECUTE ON FUNCTION public.fence_smoke() TO '+quote(f.roles.backup));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('possible write authority');await f.client.query('REVOKE EXECUTE ON FUNCTION public.fence_smoke() FROM '+quote(f.roles.backup));
   await f.client.query('GRANT '+quote(f.roles.group)+' TO '+quote(f.roles.backup));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('possible write authority');await f.client.query('REVOKE '+quote(f.roles.group)+' FROM '+quote(f.roles.backup));
   const outsider='fence_outsider_'+randomUUID().replaceAll('-','');await f.client.query('CREATE ROLE '+quote(outsider)+' LOGIN');
   try{await f.client.query('GRANT INSERT ON public.fence_probe TO '+quote(outsider));await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('Unmanaged login');}
   finally{await f.client.query('REVOKE ALL ON public.fence_probe FROM '+quote(outsider));await f.client.query('DROP ROLE '+quote(outsider));}
   const plan=await preparePostgresLoginFence(f.client,f.target);await expect(installPostgresLoginFence(f.client,{...plan,target:{...f.target,databaseName:'recovery_'+'0'.repeat(32)}},true)).rejects.toThrow();
   await f.client.query('CREATE ROLE '+quote(extra)+' LOGIN');created=true;await expect(installPostgresLoginFence(f.client,plan,true)).rejects.toThrow('role or membership drift');expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(true);await f.client.query('DROP ROLE '+quote(extra));created=false;
   if(process.env.PERSISTENCE_TEST_PREPARED_TRANSACTIONS==='1'){
    expect(Number((await f.client.query('SHOW max_prepared_transactions')).rows[0].max_prepared_transactions)).toBeGreaterThan(0);
    const api=await f.connectAs(f.roles.api),transaction='fence_'+randomUUID().replaceAll('-','');await api.query("BEGIN; INSERT INTO public.fence_probe VALUES (7); PREPARE TRANSACTION '"+transaction+"'");
    try{await expect(preparePostgresLoginFence(f.client,f.target)).rejects.toThrow('prepared transactions');await expect(installPostgresLoginFence(f.client,plan,true)).rejects.toThrow('prepared transactions');}
    finally{await f.client.query("ROLLBACK PREPARED '"+transaction+"'");}
   }
   expect((await installPostgresLoginFence(f.client,plan,true)).state).toBe('fenced');await f.client.query('CREATE ROLE '+quote(extra)+' LOGIN');created=true;await expect(releasePostgresLoginFence(f.client,plan,true)).rejects.toThrow('role or membership drift');expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(false);await f.client.query('DROP ROLE '+quote(extra));created=false;await releasePostgresLoginFence(f.client,plan,true);
  }finally{if(created)await f.client.query('DROP ROLE '+quote(extra));await f.dispose();}
 },60000);
 it('holds the fence through commit and refuses concurrent release or a second recovery transaction',async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
  let operation:Promise<string>|undefined;
  try{
   const plan=await preparePostgresLoginFence(f.client,f.target);await installPostgresLoginFence(f.client,plan,true);
   operation=withPostgresLoginFenceTransaction({connectionString:f.connectionString,plan,upstreamStopped:true,operation:async client=>{
    await client.query('INSERT INTO public.fence_probe VALUES (10)');entered.resolve();await finish.promise;return 'committed';
   }});
   await Promise.race([entered.promise,operation.then(()=>{throw new Error('Operation ended before barrier.');})]);
   await expect(releasePostgresLoginFence(f.client,plan,true)).rejects.toThrow('Another fenced operation');
   await expect(installPostgresLoginFence(f.client,plan,true)).rejects.toThrow('Another fenced operation');
   await expect(withPostgresLoginFenceTransaction({connectionString:f.connectionString,plan,upstreamStopped:true,operation:async()=> 'unexpected'})).rejects.toThrow('Another fenced operation');
   expect((await f.client.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(0);
   await expect(f.connectAs(f.roles.api)).rejects.toMatchObject({code:'28000'});
   finish.resolve();expect(await operation).toBe('committed');
   expect((await f.client.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(1);
   expect((await inspectPostgresLoginFence(f.client,plan)).state).toBe('fenced');
   expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');
  }finally{finish.resolve();await operation?.catch(()=>{});await f.dispose();}
 },60000);
 it('rolls back failed recovery work and rechecks live role drift before committing, without reopening writer logins',async()=>{
  const f=await fixture();const extra=f.target.rolePrefix+'external';let created=false;
  try{
   const plan=await preparePostgresLoginFence(f.client,f.target);
   const execute=(operation:(client:pg.Client)=>Promise<void>,upstreamStopped=true,connectionString=f.connectionString)=>withPostgresLoginFenceTransaction({connectionString,plan,upstreamStopped,operation});
   let called=false;
   await expect(execute(async()=>{called=true;})).rejects.toThrow('Verified PostgreSQL login fence');expect(called).toBe(false);
   await installPostgresLoginFence(f.client,plan,true);
   await expect(execute(async()=>{called=true;},false)).rejects.toThrow('Externally stopped');expect(called).toBe(false);
   const wrong=new URL(f.connectionString);wrong.hostname='attacker.invalid';await expect(execute(async()=>{called=true;},true,wrong.toString())).rejects.toThrow('fixed target');expect(called).toBe(false);
   await expect(execute(async client=>{await client.query('INSERT INTO public.fence_probe VALUES (20)');throw new Error('synthetic recovery failure');})).rejects.toThrow('synthetic recovery failure');
   expect((await f.client.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(0);
   expect((await inspectPostgresLoginFence(f.client,plan)).state).toBe('fenced');
   await expect(execute(async client=>{
    await client.query('INSERT INTO public.fence_probe VALUES (30)');
    await f.client.query('CREATE ROLE '+quote(extra)+' NOLOGIN');created=true;
   })).rejects.toThrow('role or membership drift');
   expect((await f.client.query('SELECT count(*)::int n FROM public.fence_probe')).rows[0].n).toBe(0);
   expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(false);
   await f.client.query('DROP ROLE '+quote(extra));created=false;
   expect((await f.client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='videoq-fenced-recovery' AND datname=current_database()")).rows[0].n).toBe(0);
   expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');
  }finally{if(created)await f.client.query('DROP ROLE '+quote(extra));await f.dispose();}
 },60000);

 it('restores actual D1 rows and identity floors under the held login fence, rolling back partial replacement',async()=>{
  const f=await fixture(),fixtureD1=await createD1Fixture(),saver=PostgresSaver.fromConnString(f.connectionString,{schema:'chat_memory'});
  try{
   await f.client.query('CREATE EXTENSION vector WITH SCHEMA public');
   await f.client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(applicationSchema))).join('\n'));
   await saver.setup();
   const manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve('drizzle')),await loadMigrationSnapshot(resolve('drizzle-d1'))),db=fixtureD1.database;
   await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES('owner','owner','owner@example.invalid',0,0,0,0,0)").run();
   const insert=(id:number)=>db.prepare("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(?,'a.mp4','restored','','2026-11-16T00:00:00.000Z','','completed','','owner','uploaded','','')").bind(id).run();
   await insert(1);await insert(500);await db.prepare('DELETE FROM videos WHERE id=500').run();
   const rows=Object.fromEntries(await Promise.all(manifest.target_insert_order.map(async n=>[n,(await db.prepare('SELECT * FROM '+q(n)).all()).results]))) as RecoveryRows;
   const states=(await db.prepare('SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence').all<{name:string;seq:string}>()).results;
   const sequenceHighWater=Object.fromEntries(manifest.target_insert_order.map(n=>[n,states.find(s=>s.name===n)?.seq??'0']));
   const plan=await preparePostgresLoginFence(f.client,f.target);await installPostgresLoginFence(f.client,plan,true);
   const restore=(snapshot:RecoveryRows)=>restorePostwriteSnapshot({client:f.client,schema:'public',checkpointSchema:'chat_memory',restoredDatabase:f.target.databaseName,manifest,rows:snapshot,vectors:[],writersFenced:true,sequenceHighWater,loginFence:{connectionString:f.connectionString,plan}});
   const restored=await restore(rows);expect(restored.productionSafe).toBe(false);expect(restored.commonTables).toHaveLength(manifest.tables.filter(t=>t.target!==null).length);
   expect((await f.client.query('SELECT title FROM public.videos WHERE id=1')).rows[0].title).toBe('restored');
   const sequence=(await f.client.query("SELECT pg_get_serial_sequence('public.videos','id') n")).rows[0].n;
   expect((await f.client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('501');
   const bad=structuredClone(rows);bad.users.push({...bad.users[0],id:'duplicate-owner',username:'duplicate-owner'});
   await expect(restore(bad)).rejects.toThrow('Recovery transaction failed');
   expect((await f.client.query('SELECT count(*)::int n FROM public.users')).rows[0].n).toBe(1);
   expect((await f.client.query('SELECT title FROM public.videos WHERE id=1')).rows[0].title).toBe('restored');
   expect((await f.client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('502');
   expect((await inspectPostgresLoginFence(f.client,plan)).state).toBe('fenced');
   expect((await releasePostgresLoginFence(f.client,plan,true)).state).toBe('open');
  }finally{await saver.end();await fixtureD1.dispose();await f.dispose();}
 },120000);

});

async function activityFixture(){
 const f=await fixture();try{await f.client.query('CREATE EXTENSION vector WITH SCHEMA public');await f.client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(applicationSchema))).join('\n'));return{...f,audit:async()=>{await f.client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');try{return await readPostgresCutoverActivity(f.client);}finally{await f.client.query('ROLLBACK');}}};}catch(error){await f.dispose();throw error;}
}
describe.skipIf(!url)('PostgreSQL cutover activity snapshot',()=>{
 it('requires a fresh read-only statement and never calls an empty observation a complete drain',async()=>{
  const f=await activityFixture();try{const r=await f.audit();expect(r.databaseName).toBe(f.target.databaseName);expect(Object.values(r.counts)).toEqual(Array(10).fill(0));expect(r.activeLeasesObserved).toBe(false);expect(r.requiresReconciliation).toBe(false);expect(r.inFlightDrainProven).toBe(false);expect(()=>assertNoActivePostgresLeases(r)).not.toThrow();await expect(readPostgresCutoverActivity(f.client)).rejects.toThrow('Read-only');await f.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await expect(readPostgresCutoverActivity(f.client)).rejects.toThrow('Read-only');await f.client.query('ROLLBACK');}finally{await f.dispose();}
 },60000);
 it('distinguishes active, expired and malformed leases from unfinished business state without changing rows',async()=>{
  const f=await activityFixture();try{
   await f.client.query("INSERT INTO public.users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.invalid',false,0,0,0)");
   await f.client.query("INSERT INTO public.videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(1,'private.mp4','private-title','',now(),'private transcript','processing','','owner','uploaded','','')");
   await f.client.query("INSERT INTO public.job_executions(job_id,job_type,payload_sha256,status,lease_token,lease_until) VALUES('private-job','media',$1,'running',gen_random_uuid(),now()+interval '1 hour')",['a'.repeat(64)]);
   await f.client.query("INSERT INTO public.chat_conversations(thread_id,owner_user_id,expires_at,lease_id,leased_until) VALUES('private-thread','owner',now()+interval '1 day',gen_random_uuid(),now()+interval '1 hour')");
   await f.client.query("INSERT INTO public.ai_answer_attempts(id,plan_code,quota_source,has_course,streamed,status) VALUES(gen_random_uuid(),'free','included',false,false,'started')");
   await f.client.query("INSERT INTO public.video_transcription_runs(video_id,run_id,file_key,transcript_hash,duration_ms,chunk_seconds,chunk_count) VALUES(1,gen_random_uuid(),'private.mp4',$1,1000,60,1)",['a'.repeat(32)]);
   await f.client.query("INSERT INTO public.video_visual_runs(video_id,run_id,file_key,duration_ms,chunk_count,status) VALUES(1,gen_random_uuid(),'private.mp4',1000,1,'processing')");
   const fingerprint=async()=>createHash('sha256').update(JSON.stringify((await f.client.query("SELECT (SELECT jsonb_agg(t) FROM public.job_executions t) jobs,(SELECT jsonb_agg(t) FROM public.chat_conversations t) chats,(SELECT jsonb_agg(t) FROM public.ai_answer_attempts t) attempts")).rows)).digest('hex');const before=await fingerprint(),active=await f.audit();expect(await fingerprint()).toBe(before);expect(active.counts).toMatchObject({jobLeasesActive:1,chatLeasesActive:1,answerAttemptsStarted:1,videosProcessing:1,transcriptionRunsIncomplete:1,visualRunsProcessing:1});expect(()=>assertNoActivePostgresLeases(active)).toThrow('Active or malformed');expect(JSON.stringify(active)).not.toContain('private-');
   await f.client.query("UPDATE public.job_executions SET lease_until=now()-interval '1 hour'; UPDATE public.chat_conversations SET leased_until=now()-interval '1 hour'");const expired=await f.audit();expect(expired.counts).toMatchObject({jobLeasesActive:0,jobLeasesExpired:1,chatLeasesActive:0,chatLeasesExpired:1});expect(expired.requiresReconciliation).toBe(true);expect(()=>assertNoActivePostgresLeases(expired)).not.toThrow();expect((await f.client.query('SELECT status FROM public.job_executions')).rows[0].status).toBe('running');expect(expired.inFlightDrainProven).toBe(false);
   await f.client.query('UPDATE public.job_executions SET lease_until=NULL,lease_token=NULL; UPDATE public.chat_conversations SET leased_until=NULL');const invalid=await f.audit();expect(invalid.counts).toMatchObject({jobLeasesInvalid:1,chatLeasesInvalid:1});expect(()=>assertNoActivePostgresLeases(invalid)).toThrow('Active or malformed');expect(()=>assertNoActivePostgresLeases({...invalid,requiresReconciliation:false})).toThrow('Inconsistent');
  }finally{await f.dispose();}
 },60000);
 it('private-plan CLI returns only aggregate activity and preserves login admission',async()=>{
  const f=await activityFixture(),directory=await mkdtemp(join(tmpdir(),'videoq-activity-'));try{
   await f.client.query("INSERT INTO public.job_executions(job_id,job_type,payload_sha256,status,lease_token,lease_until) VALUES('private-cli-job','media',$1,'running',gen_random_uuid(),now()+interval '1 hour')",['a'.repeat(64)]);
   const target=join(directory,'target.json'),state=join(directory,'plan.json');await writeFile(target,JSON.stringify(f.target),{mode:0o600});const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.VIDEOQ_FENCE_ADMIN_DATABASE_URL=f.connectionString;
   const command=(args:string[])=>promisify(execFile)(process.execPath,['--import','tsx',resolve('scripts/d1-postgres-login-fence.ts'),...args],{env,timeout:20000,maxBuffer:65536});await command(['--mode','prepare','--target',target,'--state',state]);const {stdout}=await command(['--mode','activity','--state',state]),proof=JSON.parse(stdout),r=proof.activity;expect(r.readOnly).toBe(true);expect(r.counts.jobLeasesActive).toBe(1);expect(stdout).not.toContain('private-cli-job');expect(proof.upstreamStoppedByThisCommand).toBe(false);expect(r.inFlightDrainProven).toBe(false);expect(stdout).not.toContain(f.password);expect((await f.client.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[f.roles.api])).rows[0].rolcanlogin).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});await f.dispose();}
 },60000);
});
