import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { canonicalBackgroundJob, executeBackgroundJob, parseBackgroundJob } from '../src/application/background-job';
import type { JobRepository } from '../src/application/job-execution-port';

interface ContractCase {
  name: string;
  message: unknown;
  accepted: boolean;
  canonical?: string;
  sha256?: string;
}
const cases = JSON.parse(readFileSync(new URL('../../../packages/domain/test/fixtures/background-jobs.json', import.meta.url), 'utf8')) as ContractCase[];

it.each(cases)('shared Python/TypeScript job contract: $name', async fixture => {
  const claim = vi.fn<JobRepository['claim']>(async () => ({ status: 'completed' }));
  const execute = vi.fn(async () => {});
  const deps = {
    repository: { claim, complete: vi.fn(), fail: vi.fn(), heartbeat: vi.fn() },
    sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
    execute,
  };
  if (!fixture.accepted) {
    await expect(executeBackgroundJob(fixture.message, deps)).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
    return;
  }
  const parsed = parseBackgroundJob(fixture.message);
  expect(canonicalBackgroundJob(parsed)).toBe(fixture.canonical);
  // Replaying an existing completed delivery must use the same identity barrier.
  await executeBackgroundJob(fixture.message, deps);
  await executeBackgroundJob(fixture.message, deps);
  expect(claim).toHaveBeenCalledTimes(2);
  for (const [identity] of claim.mock.calls) {
    expect(identity).toMatchObject({ jobId: parsed.job_id, payloadSha256: fixture.sha256 });
  }
  expect(execute).not.toHaveBeenCalled();
});
