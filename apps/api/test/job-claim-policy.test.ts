import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { jobClaimDecision, jobReclaimAllowed } from '../src/domain/operations/job-execution';
const cases = JSON.parse(readFileSync(new URL('../../../packages/domain/test/fixtures/job-claim-policy.json', import.meta.url), 'utf8')) as { sameIdentity: boolean; status: string; leaseActive: boolean; result: string }[];
it.each(cases)('shared job state contract: %j', c => {
  expect(jobClaimDecision(c.sameIdentity, c.status, c.leaseActive)).toBe(c.result);
  expect(jobReclaimAllowed({ sameIdentity: c.sameIdentity, notCompleted: c.status !== 'completed', notRunning: c.status !== 'running', noLease: false, expired: !c.leaseActive },
    { and: (...terms) => terms.every(Boolean), or: (...terms) => terms.some(Boolean) })).toBe(c.result === 'claimable');
});

import { jobLeaseMutationAllowed, type JobLeaseOperation } from '../src/domain/operations/job-execution';
const leaseCases = JSON.parse(readFileSync(new URL('../../../packages/domain/test/fixtures/job-lease-policy.json', import.meta.url), 'utf8')) as { operation: JobLeaseOperation; running: boolean; tokenMatches: boolean; leaseActive: boolean; allowed: boolean }[];
it.each(leaseCases)('shared job mutation contract: %j', c => {
  expect(jobLeaseMutationAllowed(c.operation, c, { and: (...terms) => terms.every(Boolean) })).toBe(c.allowed);
});
