import { currentSkillBuildPredicate, skillSourceState, type SkillSqlDriver } from './course-skill-input-sql';
import type { CourseSkillExecutionRepository } from './contracts/course-skill-execution-repository';
import type { SkillBuildLease } from './contracts/course-skill-knowledge-repository';

export function createSqlCourseSkillExecutionRepository(driver: SkillSqlDriver): CourseSkillExecutionRepository {
  const guard = `${currentSkillBuildPredicate(driver)} AND b.state='running' AND b.lease_token=? AND b.generation=? AND b.lease_until>?`;
  const args = (lease: SkillBuildLease, now: number) => [lease.ownerId, lease.token, lease.generation, now];
  const expected = driver.dialect === 'd1' ? `json_extract(b.input,'$.sourceState')` : `(b.input::jsonb->>'sourceState')`;
  const eligible = `FROM course_skill_builds b JOIN course_skill_inputs s ON s.course_id=b.course_id JOIN video_courses c ON c.id=b.course_id
    WHERE s.generation_enabled=1 AND s.revision=b.revision AND NOT c.managed_by_lms AND NOT c.native_access_disabled
    AND b.state IN ('queued','running') AND ${skillSourceState(driver.dialect)}=${expected}`;
  return {
    async pending(now) {
      const [row] = await driver.all<{ id: string; ownerId: string }>(`SELECT b.id,c.user_id AS "ownerId" FROM course_skill_builds b
        JOIN course_skill_inputs s ON s.course_id=b.course_id JOIN video_courses c ON c.id=b.course_id
        WHERE s.generation_enabled=1 AND s.revision=b.revision AND NOT c.managed_by_lms AND NOT c.native_access_disabled
        AND b.state IN ('queued','running') AND b.lease_until<=? AND ${skillSourceState(driver.dialect)}=${expected}
        ORDER BY b.lease_until,b.created_at,b.id LIMIT 1`, [now]);
      return row ?? null;
    },
    async nextWakeup() {
      const [row] = await driver.all<{ due: number | null }>(`SELECT min(b.lease_until) AS due ${eligible}`, []);
      return row?.due == null ? null : Number(row.due);
    },
    async current(lease, now) {
      return (await driver.all(`SELECT b.id FROM course_skill_builds b WHERE b.id=? AND ${guard}`, [lease.id, ...args(lease, now)])).length > 0;
    },
    async release(lease, checkpoint, state, now, delayMs) {
      if (checkpoint.length > 64_000 || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 900_000) throw new Error('INVALID_SKILL_EXECUTION_STATE');
      const rows = await driver.all(`UPDATE course_skill_builds AS b SET state=?,checkpoint=?,lease_token=NULL,lease_until=?
        WHERE b.id=? AND ${guard} RETURNING id`, [state, checkpoint, now + delayMs, lease.id, ...args(lease, now)]);
      return rows.length > 0;
    },
    async readStep(lease, key, now) {
      const [row] = await driver.all<{ content: string }>(`SELECT k.content FROM course_skill_steps k JOIN course_skill_builds b ON b.id=k.build_id
        WHERE b.id=? AND k.key=? AND ${guard}`, [lease.id, key, ...args(lease, now)]);
      return row?.content ?? null;
    },
    async saveStep(lease, key, content, now) {
      if (new TextEncoder().encode(content).byteLength > 240_000) throw new Error('SKILL_STEP_TOO_LARGE');
      const rows = await driver.all(`INSERT INTO course_skill_steps(key,build_id,content) SELECT ?,b.id,? FROM course_skill_builds b
        WHERE b.id=? AND ${guard} ON CONFLICT(key) DO NOTHING RETURNING key`, [key, content, lease.id, ...args(lease, now)]);
      return rows.length > 0;
    },
    progress: (courseId, ownerId) => driver.all(`SELECT b.id,b.revision,b.state,b.checkpoint FROM course_skill_builds b
      JOIN video_courses c ON c.id=b.course_id WHERE c.id=? AND c.user_id=? ORDER BY b.revision DESC,b.id LIMIT 20`, [courseId, ownerId]),
  };
}
