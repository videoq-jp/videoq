import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,session,oauthClient,oauthAccessToken,oauthRefreshToken,oauthConsent,externalTasks} from '../../src/db/schema';
import {createApp} from '../../src/app';
import {testAuthHeaders} from '../helpers/auth';
import * as admin from '../../src/repositories/admin-repository';
import {PLAN_CATALOG} from '../../src/features/billing/catalog';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} admin user contract`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,dispose:()=>Promise<void>,query:(sql:string)=>Promise<Record<string,unknown>[]>;
  beforeEach(async()=>{
   if(backend==='d1'){
    const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
    query=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,session,oauthClient,oauthAccessToken,oauthRefreshToken,oauthConsent,externalTasks}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    query=async(sql)=>(await f.pool.query(sql)).rows;
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
   }
   Object.assign(env,{ENVIRONMENT:'development',BETTER_AUTH_URL:'https://admin.example',BETTER_AUTH_SECRET:'admin-fixture-secret-01234567890123456789'});
   for(const id of ['a','b','c'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',[id,'User-'+id,id+'@example.test',false]);
  });
  afterEach(async()=>{await dispose?.();});
  it('locks deletion, revokes native sessions and OAuth grants, and returns one durable job across retries',async()=>{
   await execute("INSERT INTO session(id,user_id,token,expires_at) VALUES('s','a','private-token','2099-01-01T00:00:00Z')");
   await execute('INSERT INTO oauth_client(id,client_id,redirect_uris) VALUES(?,?,?)',['client','client',backend==='d1'?'[]':[]]);
   await execute('INSERT INTO oauth_refresh_token(id,user_id,client_id,token,scopes) VALUES(?,?,?,?,?)',['refresh','a','client','private-refresh',backend==='d1'?'[]':[]]);
   await execute('INSERT INTO oauth_access_token(id,user_id,client_id,token,scopes) VALUES(?,?,?,?,?)',['access','a','client','private-access',backend==='d1'?'[]':[]]);
   await execute('INSERT INTO oauth_consent(id,user_id,client_id,scopes) VALUES(?,?,?,?)',['consent','a','client',backend==='d1'?'[]':[]]);
   const [first,second]=await Promise.all([admin.lockUserForHardDelete(env,'a'),admin.lockUserForHardDelete(env,'a')]);expect(first).toEqual(second);expect(first).toMatchObject({taskId:expect.any(Number),jobId:expect.any(String)});expect((await admin.getAdminUser(env,'a'))?.is_active).toBe(false);
   for(const table of ['session','oauth_access_token','oauth_consent'])expect(await query(`SELECT id FROM ${table} WHERE user_id='a'`)).toEqual([]);
   expect((await query("SELECT revoked FROM oauth_refresh_token WHERE id='refresh'"))[0].revoked).not.toBeNull();expect(await query('SELECT id FROM external_tasks')).toHaveLength(1);expect((await admin.getAdminUser(env,'b'))?.is_active).toBe(true);
  });
  it('never queues deletion for another admin or a missing user',async()=>{
   await execute("UPDATE users SET role='user,admin' WHERE id='a'");expect(await admin.lockUserForHardDelete(env,'a')).toEqual({forbiddenAdmin:true});expect(await admin.lockUserForHardDelete(env,'missing')).toEqual({notFound:true});expect(await query('SELECT id FROM external_tasks')).toEqual([]);expect((await admin.getAdminUser(env,'a'))?.is_active).toBe(true);
  });
  it('rolls back deletion guards and session revocation on a late outbox failure',async()=>{
   await execute("INSERT INTO session(id,user_id,token,expires_at) VALUES('s','a','private-token','2099-01-01T00:00:00Z')");
   if(backend==='d1')await execute("CREATE TRIGGER fail_outbox BEFORE INSERT ON external_tasks BEGIN SELECT RAISE(ABORT,'outbox failure'); END");
   else await execute("CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox failure'; END $$; CREATE TRIGGER fail_outbox BEFORE INSERT ON external_tasks FOR EACH ROW EXECUTE FUNCTION fail_outbox()");
   await expect(admin.lockUserForHardDelete(env,'a')).rejects.toThrow();expect((await admin.getAdminUser(env,'a'))?.is_active).toBe(true);expect(await query("SELECT id FROM session WHERE user_id='a'")).toHaveLength(1);expect(await query('SELECT id FROM external_tasks')).toEqual([]);
  });
  it('rejects an unusable persisted deletion job without committing account or session changes',async()=>{
   await execute("INSERT INTO session(id,user_id,token,expires_at) VALUES('s','a','private-token','2099-01-01T00:00:00Z')");
   await execute('INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES(?,?,?)',['sqs_job','{"message":{}}','account-delete:a']);
   await expect(admin.lockUserForHardDelete(env,'a')).rejects.toThrow();expect((await admin.getAdminUser(env,'a'))?.is_active).toBe(true);expect(await query("SELECT id FROM session WHERE user_id='a'")).toHaveLength(1);
  });
  it('selects the backend through real tRPC routes and enforces administrator access',async()=>{
   await execute("UPDATE users SET role='admin' WHERE id='a'");const app=createApp();
   const list=await app.request('/api/trpc/admin.listUsers',{headers:testAuthHeaders('a')},env);expect(list.status).toBe(200);const body=await list.json<{result:{data:{data:unknown[]}}}>();expect(body.result.data.data).toHaveLength(3);
   const updated=await app.request('/api/trpc/admin.patchQuota',{method:'POST',headers:{...testAuthHeaders('a'),'content-type':'application/json'},body:JSON.stringify({id:'b',ai_answers_limit:17})},env);expect(updated.status).toBe(200);expect((await admin.getAdminUser(env,'b'))?.ai_answers_limit).toBe(17);
   expect((await app.request('/api/trpc/admin.listUsers',{headers:testAuthHeaders('b')},env)).status).toBe(403);
  });
  it('lists stable pages with literal case-insensitive searches and consistent total counts',async()=>{
   await execute('UPDATE users SET username=? WHERE id=?',['A%_\\SPECIAL','b']);
   expect((await admin.listAdminUsers(env,'',1,1)).results.map(r=>r.id)).toEqual(['b']);
   expect(await admin.listAdminUsers(env,'',2,8)).toEqual({count:3,results:[]});
   for(const q of ['%','_','\\','special','b@EXAMPLE']){const list=await admin.listAdminUsers(env,q,10,0);expect(list.count).toBe(1);expect(list.results.map(r=>r.id)).toEqual(['b']);}
  });
  it('uses identical Unicode literal matching for usernames and email in both backends',async()=>{
   await execute("UPDATE users SET username=?,email=? WHERE id='b'",['ÜBER ΚΟΣΜΟΣ Москва Kelvin 東京','ÜSER@example.test']);
   for(const q of ['über','ΚΟΣΜΟΣ','κοσμος','МОСКВА','kelvin','東京','üser@EXAMPLE']){
    const result=await admin.listAdminUsers(env,q,10,0);expect(result.count).toBe(1);expect(result.results.map(row=>row.id)).toEqual(['b']);
   }
   // Lowercasing is deliberately locale-independent, without accent stripping,
   // compatibility normalization or full case folding (ß is distinct from ss).
   for(const q of ['uber','ＴＯＫＹＯ',"' OR 1=1 --"])expect((await admin.listAdminUsers(env,q,10,0)).count).toBe(0);
  });
  it('counts matches across scan pages and applies pagination after matching',async()=>{
   const rows=Array.from({length:405},(_,index)=>({id:'scan-'+String(index).padStart(4,'0'),name:(index%2===0?'Ünicode match ':'Unrelated ')+index,email:'scan'+index+'@example.test'}));
   if(backend==='d1')await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.email'),0,0,0,0 FROM json_each(?)",[JSON.stringify(rows)]);
   else await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) SELECT value->>'id',value->>'name',value->>'email',false,0,0,0 FROM jsonb_array_elements(?::jsonb)",[JSON.stringify(rows)]);
   expect(await admin.listAdminUsers(env,'ünicode',2,199)).toMatchObject({count:203,results:[{id:'scan-0398'},{id:'scan-0400'}]});
   expect(await admin.listAdminUsers(env,'ünicode',2,202)).toMatchObject({count:203,results:[{id:'scan-0404'}]});
   expect(await admin.listAdminUsers(env,'ünicode',2,203)).toEqual({count:203,results:[]});
  });
  it('maps role tokens exactly and evaluates permanent and expired bans',async()=>{
   await execute("UPDATE users SET role='user,admin',banned=?,ban_expires=NULL WHERE id='a'",[true]);
   expect(await admin.isAdmin(env,'a')).toBe(true);expect(await admin.getAdminUser(env,'a')).toMatchObject({is_active:false,is_admin:true});
   await execute("UPDATE users SET role='administrator',ban_expires='2000-01-01T00:00:00Z' WHERE id='a'");expect(await admin.isAdmin(env,'a')).toBe(false);expect(await admin.getAdminUser(env,'a')).toMatchObject({is_active:true,is_admin:false});
   expect(await admin.isAdmin(env,'missing')).toBe(false);expect(await admin.getAdminUser(env,'missing')).toBeNull();
  });
  it.each([{plan:'basic',status:'active',expected:'basic'},{plan:'pro',status:'past_due',expected:'pro'},{plan:'pro',status:'canceled',expected:'free'},{plan:'basic',status:null,expected:'free'}]as const)('restores current subscription limits for $plan/$status in one update',async({plan,status,expected})=>{
   await execute("UPDATE users SET plan_code=?,subscription_status=?,quota_source='admin',used_ai_answers=7,used_storage_bytes=1024 WHERE id='a'",[plan,status]);
   const user=await admin.patchAdminUserQuota(env,'a',{quota_source:'plan',ai_answers_limit:99});const e=PLAN_CATALOG[expected].entitlements;
   expect(user).toMatchObject({quota_source:'plan',max_video_upload_size_mb:e.maxVideoUploadSizeMb,monthly_upload_limit_gb:e.monthlyUploadLimitGb,storage_limit_gb:e.storageLimitGb,processing_limit_minutes:e.processingLimitMinutes,ai_answers_limit:e.aiAnswersLimit,used_ai_answers:7,used_storage_bytes:1024});
  });
  it('supports explicit unlimited quotas, zero, partial updates and a no-op patch',async()=>{
   const result=await admin.patchAdminUserQuota(env,'a',{storage_limit_gb:null,ai_answers_limit:0});expect(result).toMatchObject({quota_source:'admin',storage_limit_gb:null,ai_answers_limit:0});expect(await admin.patchAdminUserQuota(env,'a',{})).toEqual(result);expect(await admin.patchAdminUserQuota(env,'missing',{ai_answers_limit:1})).toBeNull();
   expect((await admin.getAdminUser(env,'b'))?.quota_source).toBe('plan');
  });
  it('normalizes usage dates, preserves safe large byte counts and limits the patch to its target',async()=>{
   const user=await admin.patchAdminUserUsage(env,'a',{used_storage_bytes:9007199254740991,used_processing_seconds:5,used_ai_answers:7,is_over_quota:true,usage_period_start:'2026-09-01T09:00:00+09:00'});
   expect(user).toMatchObject({used_storage_bytes:9007199254740991,used_processing_seconds:5,used_ai_answers:7,is_over_quota:true,usage_period_start:'2026-09-01T00:00:00.000Z'});
   expect(await admin.patchAdminUserUsage(env,'a',{})).toEqual(user);expect((await admin.patchAdminUserUsage(env,'a',{usage_period_start:null}))?.usage_period_start).toBeNull();expect((await admin.getAdminUser(env,'b'))?.used_ai_answers).toBe(0);expect(await admin.patchAdminUserUsage(env,'missing',{used_ai_answers:1})).toBeNull();
  });
 });
}
