import type { Bindings } from '../types/bindings';
import type { MaintenanceWakeup } from '../persistence/contracts/maintenance-repository';
import { persistenceBackend } from '../persistence/backend';
import { withClient } from '../db/pool';

export async function courseSkillWakeup(env: Bindings, base: MaintenanceWakeup): Promise<MaintenanceWakeup> {
  const sql = `SELECT min(next_check_at) AS due FROM course_skill_inputs WHERE generation_enabled=1`;
  const due = persistenceBackend(env) === 'd1'
    ? await env.DB!.prepare(sql).first<number | null>('due')
    : await withClient(env, async client => (await client.query<{ due: string | null }>(sql)).rows[0]?.due);
  if (due == null) return base;
  const next = new Date(Number(due));
  const earlier = (a: Date | null, b: Date) => a && a < b ? a : b;
  return { nextAt: earlier(base.nextAt, next), nextFutureAt: next.getTime() > Date.now() ? earlier(base.nextFutureAt, next) : base.nextFutureAt };
}
