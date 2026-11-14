import {inspect} from 'node:util';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {hashPassword} from 'better-auth/crypto';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as pgSchema from '../../src/db/schema';
import * as authSchema from '../../src/db/schema/better-auth';
import {createAuth} from '../../src/persistence/postgres/auth';
import {createD1Auth} from '../../src/persistence/d1/auth';
import {createApp} from '../../src/app';
import {patchFlags} from '../../src/features/admin/service';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} native admin flag contract`,()=>{
  let env:Bindings,headers:Headers,execute:(sql:string,args?:unknown[])=>Promise<void>,rows:(sql:string)=>Promise<Record<string,unknown>[]>,dispose:()=>Promise<void>,database:D1Database|undefined;
  const actor='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002';
  beforeEach(async()=>{
   let signIn:()=>Promise<Response>;
   if(backend==='d1'){
    const f=await createD1Fixture();database=f.database;dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
    rows=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
    signIn=()=>createD1Auth(env,f.database,'browser').api.signInEmail({body:{email:'admin@example.test',password:'Admin-contract-password-123'},asResponse:true});
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users:pgSchema.users,runtimeRateLimits:pgSchema.runtimeRateLimits,...authSchema}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};rows=async(sql)=>(await f.pool.query(sql)).rows;
    signIn=()=>createAuth(env,drizzle(f.pool,{schema:pgSchema}),'browser').api.signInEmail({body:{email:'admin@example.test',password:'Admin-contract-password-123'},asResponse:true});
   }
   Object.assign(env,{ENVIRONMENT:'test',BETTER_AUTH_URL:'https://admin-flags.example.test',FRONTEND_URL:'https://admin-flags.example.test',BETTER_AUTH_SECRET:'admin-contract-secret-012345678901234567890'});
   for(const [id,name,role]of [[actor,'admin','admin'],[target,'target','user']])await execute('INSERT INTO users(id,username,email,role,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,password_reset_required) VALUES(?,?,?,?,?,?,0,0,0,?)',[id,name,name+'@example.test',role,true,false,false]);
   await execute('INSERT INTO account(id,account_id,user_id,provider_id,password) VALUES(?,?,?,?,?)',['account',actor,actor,'credential',await hashPassword('Admin-contract-password-123')]);
   const response=await signIn();expect(response.status).toBe(200);headers=new Headers({cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')});
   await execute('INSERT INTO session(id,user_id,token,expires_at) VALUES(?,?,?,?)',['target-session',target,'private-target-token','2099-01-01T00:00:00Z']);
  });
  afterEach(async()=>{vi.restoreAllMocks();await dispose?.();});
  const state=async()=>({users:await rows('SELECT id,role,banned,ban_expires,ban_reason FROM users ORDER BY id'),sessions:await rows('SELECT id,user_id,token FROM session ORDER BY id')});
  it('atomically bans/promotes with native defaults and revokes only the target sessions',async()=>{
   expect(await patchFlags(env,actor,target,{is_active:false,is_admin:true},headers)).toMatchObject({user:{id:target,is_active:false,is_admin:true}});
   const snapshot=await state();expect(snapshot.users.find(u=>u.id===target)).toMatchObject({role:'admin',ban_reason:'No reason',ban_expires:null});expect(snapshot.sessions).toHaveLength(1);expect(snapshot.sessions[0].user_id).toBe(actor);
  });
  it('clears ban state without recreating old sessions and can remove administrator role',async()=>{
   await patchFlags(env,actor,target,{is_active:false,is_admin:true},headers);
   expect(await patchFlags(env,actor,target,{is_active:true,is_admin:false},headers)).toMatchObject({user:{is_active:true,is_admin:false}});
   expect((await state()).users.find(u=>u.id===target)).toMatchObject({ban_reason:null,ban_expires:null,role:'user'});expect((await state()).sessions).toHaveLength(1);
  });
  it('rejects absent or revoked native sessions without changing the target',async()=>{
   const before=await state();await expect(patchFlags(env,actor,target,{is_active:false},new Headers())).rejects.toMatchObject({statusCode:401});expect(await state()).toEqual(before);
   await execute('DELETE FROM session WHERE user_id=?',[actor]);await expect(patchFlags(env,actor,target,{is_admin:true},headers)).rejects.toMatchObject({statusCode:401});expect((await state()).users).toEqual(before.users);
  });
  it('rejects an authenticated non-admin and protects self lockout',async()=>{
   expect(await patchFlags(env,actor,actor,{is_admin:false},headers)).toEqual({selfLockout:true});expect(await patchFlags(env,actor,actor,{is_active:false},headers)).toEqual({selfLockout:true});
   await execute("UPDATE users SET role='user' WHERE id=?",[actor]);const before=await state();await expect(patchFlags(env,actor,target,{is_admin:true},headers)).rejects.toMatchObject({statusCode:403});expect(await state()).toEqual(before);
  });
  it('authorizes a real cookie session through tRPC and returns the updated user',async()=>{
   const response=await createApp().request('/api/trpc/admin.patchFlags',{method:'POST',headers:new Headers({...Object.fromEntries(headers),'content-type':'application/json'}),body:JSON.stringify({id:target,is_active:false,is_admin:true})},env);
   expect(response.status).toBe(200);expect(await response.json()).toMatchObject({result:{data:{id:target,is_active:false,is_admin:true}}});
   expect(await rows("SELECT id FROM session WHERE id='target-session'")).toEqual([]);
  });
  it('rolls back the user update when session revocation fails afterwards',async()=>{
   if(backend==='d1')await execute("CREATE TRIGGER fail_session BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT,'session failure'); END");
   else await execute("CREATE FUNCTION fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'session failure'; END $$; CREATE TRIGGER fail_session BEFORE DELETE ON session FOR EACH ROW EXECUTE FUNCTION fail_session()");
   const before=await state();await expect(patchFlags(env,actor,target,{is_active:false,is_admin:true},headers)).rejects.toThrow();expect(await state()).toEqual(before);
  });
  it('returns notFound for a missing target',async()=>{expect(await patchFlags(env,actor,crypto.randomUUID(),{is_admin:true},headers)).toEqual({notFound:true});});
  it('rolls back all flags and session effects on a database failure',async()=>{
   if(backend==='d1')await execute("CREATE TRIGGER fail_role BEFORE UPDATE OF role ON users WHEN NEW.role='admin' BEGIN SELECT RAISE(ABORT,'role failure'); END");
   else await execute("CREATE FUNCTION fail_role() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='admin' THEN RAISE EXCEPTION 'role failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_role BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_role()");
   const before=await state();await expect(patchFlags(env,actor,target,{is_active:false,is_admin:true},headers)).rejects.toThrow();expect(await state()).toEqual(before);
  });
  if(backend==='d1')it('does not expose the administrator session token in persistence error logs',async()=>{
   const [session]=await rows(`SELECT token FROM session WHERE user_id='${actor}'`);
   await execute("CREATE TRIGGER fail_role BEFORE UPDATE OF role ON users WHEN NEW.role='admin' BEGIN SELECT RAISE(ABORT,'role failure'); END");
   const log=vi.spyOn(console,'error').mockImplementation(()=>{});
   const response=await createApp().request('/api/trpc/admin.patchFlags',{method:'POST',headers:new Headers({...Object.fromEntries(headers),'content-type':'application/json'}),body:JSON.stringify({id:target,is_admin:true})},env);
   expect(response.status).toBe(500);expect(inspect(log.mock.calls,{depth:null})).not.toContain(session.token);expect(await response.text()).not.toContain(session.token);
  });
  if(backend==='d1')it.each(['session','expiry','role','ban']as const)('rechecks %s changes after session verification and before the atomic batch',async(kind)=>{
   const db=database!,original=db.batch.bind(db);let injected=false;
   env.DB=new Proxy(db,{get(object,key){if(key!=='batch'){const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}return async(statements:D1PreparedStatement[])=>{
    if(!injected){injected=true;if(kind==='session')await execute('DELETE FROM session WHERE user_id=?',[actor]);else if(kind==='expiry')await execute("UPDATE session SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=?",[actor]);else if(kind==='role')await execute("UPDATE users SET role='user' WHERE id=?",[actor]);else await execute('UPDATE users SET banned=?,ban_expires=NULL WHERE id=?',[true,actor]);}
    return original(statements);
   };}});
   await expect(patchFlags(env,actor,target,{is_active:false,is_admin:true},headers)).rejects.toMatchObject({statusCode:403});expect(injected).toBe(true);expect((await state()).users.find(u=>u.id===target)).toMatchObject({role:'user',ban_reason:null});expect((await rows("SELECT id FROM session WHERE id='target-session'"))).toHaveLength(1);
  });
 });
}
