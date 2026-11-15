import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {billingRoutes} from '../../src/features/billing/routes';
import {createD1Fixture} from './d1-fixture';
import {PLAN_CATALOG} from '../../src/features/billing/catalog';
import type {Bindings} from '../../src/types/bindings';
const mocks=vi.hoisted(()=>({verify:vi.fn(),retrieve:vi.fn()}));
vi.mock('../../src/features/billing/stripe',async original=>({...await original<typeof import('../../src/features/billing/stripe')>(),requireStripeClient:()=>({webhooks:{constructEventAsync:mocks.verify},subscriptions:{retrieve:mocks.retrieve}})}));
describe('D1 billing webhook through Hono',()=>{
 let f:Awaited<ReturnType<typeof createD1Fixture>>,env:Bindings;
 const subscription=()=>({id:'sub',customer:'cus',created:100,status:'active',metadata:{userId:'owner'},items:{data:[{price:{lookup_key:'pro_monthly'}}]}});
 beforeEach(async()=>{
  f=await createD1Fixture();env={DB:f.database,DEPLOYMENT_EDITION:'cloud',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'} as Bindings;
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,stripe_customer_id) VALUES('owner','owner','owner@example.test',0,0,0,0,'cus')").run();
  mocks.verify.mockReset().mockResolvedValue({id:'evt',type:'customer.subscription.updated',data:{object:subscription()}});mocks.retrieve.mockReset().mockResolvedValue(subscription());
 });
 afterEach(async()=>{await f?.dispose();vi.restoreAllMocks();});
 const deliver=()=>billingRoutes.request('/webhook',{method:'POST',headers:{'stripe-signature':'fixture-signature'},body:'{ "untouched": true }'},env);
 const receipt=()=>f.database.prepare("SELECT id FROM stripe_events WHERE id='evt'").first();
 it('selects D1 in cloud, verifies the untouched body, grants quotas and deduplicates delivery',async()=>{
  expect((await deliver()).status).toBe(200);expect(mocks.verify).toHaveBeenCalledWith('{ "untouched": true }','fixture-signature','whsec_fixture');
  const user=await f.database.prepare("SELECT plan_code,ai_answers_limit FROM users WHERE id='owner'").first();expect(user).toEqual({plan_code:'pro',ai_answers_limit:PLAN_CATALOG.pro.entitlements.aiAnswersLimit});expect(await receipt()).not.toBeNull();
  expect((await deliver()).status).toBe(200);expect(mocks.retrieve).toHaveBeenCalledTimes(1);
 });
 it('reloads changed billing state and preserves a concurrent administrator quota override',async()=>{
  mocks.retrieve.mockImplementationOnce(async()=>{await f.database.prepare("UPDATE users SET quota_source='admin',ai_answers_limit=17 WHERE id='owner'").run();return subscription();});
  expect((await deliver()).status).toBe(200);expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  expect(await f.database.prepare("SELECT plan_code,ai_answers_limit FROM users WHERE id='owner'").first()).toEqual({plan_code:'pro',ai_answers_limit:17});expect(await receipt()).not.toBeNull();
 });
 it('leaves failed Stripe lookups unacknowledged and accepts their later redelivery',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});mocks.retrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));
  expect((await deliver()).status).toBe(500);expect(await receipt()).toBeNull();expect((await deliver()).status).toBe(200);expect(await receipt()).not.toBeNull();
 });
});
