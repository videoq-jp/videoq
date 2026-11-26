import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
export { traces, timed, measuredD1, type Trace } from './trace';
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function frozenIdentity() {
  const migrations = readdirSync('drizzle-d1').filter(name => name.endsWith('.sql')).sort();
  return { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    productionConfigSha256: digest(readFileSync('wrangler.jsonc')),
    migrationsSha256: digest(migrations.map(name => name + '\n' + readFileSync('drizzle-d1/' + name, 'utf8')).join('\n')),
    harnessSha256: digest(readFileSync('test/persistence/current-configuration.acceptance.test.ts')),
    measurementSha256: digest(readFileSync('scripts/acceptance/measurement.ts')),
    model: '@cf/google/embeddinggemma-2', dimensions: 768, placement: 'local workerd D1/R2; Node agent; simulated external providers' };
}
export function distribution(values: number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measurement');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), sum: values.reduce((a, b) => a + b, 0) };
}
