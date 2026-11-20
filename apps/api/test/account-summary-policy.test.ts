import { expect, it } from 'vitest';
import { accountEntitlementSummary } from '../src/application/account-summary';

it.each([
  ['user,admin', 'pro', 'admin', true, 'pro', 'admin'],
  ['administrator', 'basic', 'plan', false, 'basic', 'plan'],
  ['user, admin', 'PRO', 'onprem', false, 'free', 'plan'],
  [null, 'legacy', 'legacy', false, 'free', 'plan'],
] as const)('preserves exact role and plan projection: %s/%s/%s', (role, planCode, quotaSource, admin, plan, source) => {
  expect(accountEntitlementSummary({ role, planCode, quotaSource, monthlyLimitGb: null, storageLimitGb: null, processingLimitMinutes: null })).toMatchObject({
    is_admin: admin, plan_code: plan, quota_source: source,
    monthly_upload_limit_bytes: null, storage_limit_bytes: null, processing_limit_seconds: null,
  });
});

it('preserves separate monthly floor, storage truncation and minute conversion', () => {
  const summary = accountEntitlementSummary({ role: 'admin', planCode: 'free', quotaSource: 'plan',
    monthlyLimitGb: 5.9 / 1024 ** 3, storageLimitGb: 5.9 / 1024 ** 3, processingLimitMinutes: 1.5 });
  expect(summary).toMatchObject({ monthly_upload_limit_bytes: 5, storage_limit_bytes: 5, processing_limit_seconds: 90 });
  expect(summary.max_video_upload_size_mb).toBeGreaterThan(0);
  const zero = accountEntitlementSummary({ role: '', planCode: 'free', quotaSource: 'plan', monthlyLimitGb: 0, storageLimitGb: 0, processingLimitMinutes: 0 });
  expect(zero).toMatchObject({ monthly_upload_limit_bytes: 0, storage_limit_bytes: 0, processing_limit_seconds: 0 });
});
