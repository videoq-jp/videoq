import { expect, it } from 'vitest';
import { adminAssignedRole, adminBooleanRoleLogic, adminDeletionAllowed, adminRoleIncludes, adminSelfLockout, planAdminQuotaEdit } from '../src/application/admin';
import { entitlementsForSubscription, PLAN_CATALOG } from '../src/application/billing-catalog';
it.each([['admin',true],['user,admin',true],['admin,user',true],['administrator',false],['user, admin',false],['Admin',false],[null,false]] as const)('matches an exact comma-separated administrator role: %s', (role,expected) => {
  expect(adminRoleIncludes(role,adminBooleanRoleLogic)).toBe(expected);
  expect(adminDeletionAllowed(expected,{not:value=>!value})).toBe(!expected);
});
it('refuses self lockout while allowing changes to others and harmless self edits', () => {
  expect(adminSelfLockout('a','a',{is_admin:false})).toBe(true);
  expect(adminSelfLockout('a','a',{is_active:false})).toBe(true);
  expect(adminSelfLockout('a','b',{is_admin:false,is_active:false})).toBe(false);
  expect(adminSelfLockout('a','a',{is_admin:true,is_active:true})).toBe(false);
  expect(adminSelfLockout('a','a',{})).toBe(false);
  expect(adminAssignedRole(true)).toBe('admin');expect(adminAssignedRole(false)).toBe('user');
});
it('keeps omitted quota edits unchanged and records zero/unlimited overrides as admin', () => {
  expect(planAdminQuotaEdit({})).toEqual({kind:'unchanged'});
  expect(planAdminQuotaEdit({ai_answers_limit:undefined})).toEqual({kind:'unchanged'});
  expect(planAdminQuotaEdit({storage_limit_gb:null,ai_answers_limit:0})).toEqual({kind:'manual',fields:{storageLimitGb:null,aiAnswersLimit:0,quotaSource:'admin'}});
  expect(planAdminQuotaEdit({quota_source:'admin'})).toEqual({kind:'manual',fields:{quotaSource:'admin'}});
  expect(planAdminQuotaEdit({quota_source:'plan',ai_answers_limit:99})).toEqual({kind:'restorePlan'});
});
it('uses paid limits only for exact paid plans and usable subscription states', () => {
  for(const plan of ['free','basic','pro','PRO','legacy'])for(const status of ['active','trialing','past_due','canceled','paused','ACTIVE',null]) {
    const expected=(plan==='basic'||plan==='pro')&&(status==='active'||status==='trialing'||status==='past_due')?plan:'free';
    expect(entitlementsForSubscription(plan,status)).toBe(PLAN_CATALOG[expected].entitlements);
  }
});
