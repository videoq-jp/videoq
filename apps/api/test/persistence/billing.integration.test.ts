import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,stripeEvents} from '../../src/db/schema';
import {assignBillingCustomer,findBillingUser,getBillingUser,commitStripeEvent,hasProcessedStripeEvent,BillingStateChangedError} from '../../src/repositories/billing-repository';
import {PLAN_CATALOG} from '../../src/features/billing/catalog';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} billing contract`,()=>{
  let env:Bindings,execute:(sql:string,args?:unknown[])=>Promise<void>,read:()=>Promise<Record<string,unknown>>,dispose:()=>Promise<void>,failUpdate:()=>Promise<void>;
  beforeEach(async()=>{
   if(backend==='d1'){
    const f=await createD1Fixture();dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
    read=async()=>(await f.database.prepare("SELECT * FROM users WHERE id='owner'").first<Record<string,unknown>>())!;
    failUpdate=()=>execute("CREATE TRIGGER billing_fail BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'billing failure'); END");
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,stripeEvents}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
    read=async()=>(await f.pool.query("SELECT * FROM users WHERE id='owner'")).rows[0];
    failUpdate=()=>execute("CREATE FUNCTION billing_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'billing failure'; END $$; CREATE TRIGGER billing_fail BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION billing_fail()");
   }
   await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)',['owner','owner','owner@example.test',false]);
  });
  afterEach(async()=>{await dispose?.();});
  const event=(id='evt')=>({id,type:'invoice.paid'});
  const update=async()=>({userId:'owner',expectedRevision:(await findBillingUser(env,{userId:'owner'}))!.revision,patch:{planCode:'pro' as const,stripeCustomerId:'cus',stripeSubscriptionId:'sub',subscriptionStatus:'active',entitlements:PLAN_CATALOG.pro.entitlements}});
  it('finds billing identities by owner/customer and excludes active bans only when requested',async()=>{
   expect(await findBillingUser(env,{})).toBeNull();expect(await getBillingUser(env,'missing')).toBeNull();
   expect(await assignBillingCustomer(env,'owner','cus')).toBe('cus');expect((await findBillingUser(env,{customerId:'cus'}))?.id).toBe('owner');
   await execute('UPDATE users SET banned=?,ban_expires=NULL WHERE id=?',[true,'owner']);
   expect(await getBillingUser(env,'owner')).toBeNull();expect(await assignBillingCustomer(env,'owner','other')).toBeNull();expect((await findBillingUser(env,{userId:'owner'}))?.stripeCustomerId).toBe('cus');
   await execute("UPDATE users SET ban_expires='2000-01-01T00:00:00Z' WHERE id='owner'");expect(await getBillingUser(env,'owner')).not.toBeNull();
  });
  it('returns the winner of concurrent first customer assignments',async()=>{
   const ids=await Promise.all([assignBillingCustomer(env,'owner','cus-a'),assignBillingCustomer(env,'owner','cus-b')]);expect(ids[0]).toBe(ids[1]);expect(['cus-a','cus-b']).toContain(ids[0]);
  });
  it('atomically records an event and its entitlements, ignoring duplicate deliveries',async()=>{
   const state=await update();await Promise.all([commitStripeEvent(env,event(),state),commitStripeEvent(env,event(),state)]);
   expect(await hasProcessedStripeEvent(env,'evt')).toBe(true);const row=await read();expect(row.plan_code).toBe('pro');expect(Number(row.ai_answers_limit)).toBe(PLAN_CATALOG.pro.entitlements.aiAnswersLimit);
   const revision=(await getBillingUser(env,'owner'))!.revision;await commitStripeEvent(env,event(),{...state,patch:{planCode:'free'}});expect((await getBillingUser(env,'owner'))!.revision).toBe(revision);expect((await read()).plan_code).toBe('pro');
  });
  it('rejects stale snapshots without recording the event and permits a fresh retry',async()=>{
   const state=await update();await assignBillingCustomer(env,'owner','cus');await expect(commitStripeEvent(env,event(),state)).rejects.toBeInstanceOf(BillingStateChangedError);expect(await hasProcessedStripeEvent(env,'evt')).toBe(false);
   await commitStripeEvent(env,event(),await update());expect((await read()).plan_code).toBe('pro');
  });
  it('allows only one distinct event to commit against the same revision',async()=>{
   const state=await update();const results=await Promise.allSettled([commitStripeEvent(env,event('first'),state),commitStripeEvent(env,event('second'),{...state,patch:{planCode:'basic'}})]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const rejected=results.find(r=>r.status==='rejected');expect(rejected?.status==='rejected'&&rejected.reason).toBeInstanceOf(BillingStateChangedError);
   expect(Number(await hasProcessedStripeEvent(env,'first'))+Number(await hasProcessedStripeEvent(env,'second'))).toBe(1);
  });
  it('preserves admin quotas while updating subscription state',async()=>{
   await execute("UPDATE users SET quota_source='admin',ai_answers_limit=17,storage_limit_gb=23 WHERE id='owner'");await commitStripeEvent(env,event(),await update());const row=await read();expect(row.plan_code).toBe('pro');expect(Number(row.ai_answers_limit)).toBe(17);expect(Number(row.storage_limit_gb)).toBe(23);
  });
  it('rolls back the receipt when applying the user update fails',async()=>{
   const state=await update();await failUpdate();await expect(commitStripeEvent(env,event(),state)).rejects.toThrow();expect(await hasProcessedStripeEvent(env,'evt')).toBe(false);expect((await read()).plan_code).toBe('free');
  });
  it('records ignored events once and rejects updates to missing users without a receipt',async()=>{
   await commitStripeEvent(env,event('ignored'),null);await commitStripeEvent(env,event('ignored'),null);expect(await hasProcessedStripeEvent(env,'ignored')).toBe(true);
   const state=await update();await execute("DELETE FROM users WHERE id='owner'");await expect(commitStripeEvent(env,event(),state)).rejects.toBeInstanceOf(BillingStateChangedError);expect(await hasProcessedStripeEvent(env,'evt')).toBe(false);
  });
  if(backend==='d1')it('advances the revision even for same-timestamp changes and ABA updates',async()=>{
   const first=await update();const timestamp=(await read()).updated_at;
   await execute('UPDATE users SET email=?,updated_at=? WHERE id=?',['other@example.test',timestamp,'owner']);await execute('UPDATE users SET email=?,updated_at=? WHERE id=?',['owner@example.test',timestamp,'owner']);
   expect((await getBillingUser(env,'owner'))!.revision).not.toBe(first.expectedRevision);await expect(commitStripeEvent(env,event(),first)).rejects.toBeInstanceOf(BillingStateChangedError);expect(await hasProcessedStripeEvent(env,'evt')).toBe(false);
  });
 });
}
