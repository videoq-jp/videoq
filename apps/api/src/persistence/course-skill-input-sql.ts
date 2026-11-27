import type { CourseSkillInputRepository, CourseSkillSource } from './contracts/course-skill-input-repository';

type Value = string | number | null;
export type SkillStatement = { sql: string; values: Value[] };
export interface SkillSqlDriver {
  dialect: 'd1' | 'postgres';
  all<T>(sql: string, values: Value[]): Promise<T[]>;
  batch(statements: SkillStatement[]): Promise<unknown[][]>;
}
type InputRow = {
  course_id: number; owner_id: string; revision: number; source_state: string;
  generation_enabled: number; distribution_enabled: number; language: 'ja' | 'en'; policy_version: string;
};
type BuildRow = {
  id: string; course_id: number; revision: number; input_key: string; input: string;
  state: string; lease_token: string | null; lease_until: number; generation: number; checkpoint: string;
};
const managed = `EXISTS (SELECT 1 FROM video_courses c WHERE c.id=s.course_id AND c.user_id=? AND NOT c.managed_by_lms AND NOT c.native_access_disabled)`;

/** Small source metadata only. D1's source fence is maintained by existing transcript writes. */
export function skillSourceState(dialect: SkillSqlDriver['dialect'], course = 's.course_id'): string {
  const d1 = dialect === 'd1';
  const revision = d1 ? `coalesce(iv.revision,'')` : `md5(v.transcript)`;
  const visual = d1 ? `coalesce(vr.run_id,'')||':'||coalesce(vr.publication_version,'')||':'||coalesce(vr.status,'')` : `coalesce(vr.run_id::text,'')||':'||coalesce(vr.status,'')`;
  const ready = `CASE WHEN v.status='completed' AND length(v.transcript)>0 ${d1 ? 'AND iv.revision IS NOT NULL' : ''} THEN 1 ELSE 0 END`;
  const tuple = `m.id,v.id,v.title,v.status,${revision},${visual},${ready}`;
  const from = `FROM video_course_members m JOIN videos v ON v.id=m.video_id
    JOIN video_courses c ON c.id=m.course_id AND c.user_id=v.user_id
    ${d1 ? 'LEFT JOIN video_index_versions iv ON iv.video_id=v.id' : ''}
    LEFT JOIN video_visual_runs vr ON vr.video_id=v.id AND vr.file_key=v.file
    WHERE m.course_id=${course}`;
  return d1
    ? `(SELECT coalesce(json_group_array(json(a)),'[]') FROM (SELECT json_array(${tuple}) AS a ${from} ORDER BY m.id))`
    : `(SELECT coalesce(json_agg(json_build_array(${tuple}) ORDER BY m.id)::text,'[]') ${from})`;
}

function sources(value: string): CourseSkillSource[] {
  const rows = JSON.parse(value) as [number, number, string, string, string, string, number][];
  return rows.map(([membershipId, videoId, title, status, analysisRevision, visualRevision, ready]) => ({ membershipId, videoId, title, status, analysisRevision, visualRevision, ready: ready === 1 }));
}

export function createSqlCourseSkillInputRepository(driver: SkillSqlDriver): CourseSkillInputRepository {
  const source = skillSourceState(driver.dialect);
  const jsonSource = driver.dialect === 'd1' ? `json_extract(b.input,'$.sourceState')` : `(b.input::jsonb->>'sourceState')`;
  const current = `EXISTS (SELECT 1 FROM course_skill_inputs s WHERE s.course_id=b.course_id
    AND s.generation_enabled=1 AND s.revision=b.revision AND ${managed}
    AND ${source}=${jsonSource})`;
  const stmt = (sql: string, ...values: Value[]): SkillStatement => ({ sql, values });
  const ownedCourse = `SELECT c.id FROM video_courses c WHERE c.id=? AND c.user_id=? AND NOT c.managed_by_lms AND NOT c.native_access_disabled`;
  async function seed(courseId: number, ownerId: string) {
    if (driver.dialect !== 'd1') return;
    // Legacy completed videos may predate the search fence. INSERT never replaces a current revision.
    await driver.all(`INSERT INTO video_index_versions(video_id,revision)
      SELECT v.id,lower(hex(randomblob(16))) FROM videos v JOIN video_course_members m ON m.video_id=v.id
      WHERE m.course_id=? AND v.user_id=? AND EXISTS (${ownedCourse})
      ON CONFLICT(video_id) DO NOTHING`, [courseId, ownerId, courseId, ownerId]);
  }
  return {
    async configure(courseId, ownerId, settings) {
      await seed(courseId, ownerId);
      const rows = await driver.all(`INSERT INTO course_skill_inputs(course_id,generation_enabled,distribution_enabled,policy_version,language)
        SELECT c.id,?,?,?,? FROM video_courses c WHERE c.id IN (${ownedCourse})
        ON CONFLICT(course_id) DO UPDATE SET generation_enabled=excluded.generation_enabled,
          distribution_enabled=excluded.distribution_enabled, policy_version=excluded.policy_version,language=excluded.language,
          revision=course_skill_inputs.revision+1,observed_input='',next_check_at=0
        RETURNING course_id`, [Number(settings.generationEnabled), Number(settings.distributionEnabled), settings.policyVersion, settings.language, courseId, ownerId]);
      return rows.length > 0;
    },
    async snapshot(courseId, ownerId) {
      await seed(courseId, ownerId);
      const [row] = await driver.all<InputRow>(`SELECT s.*, c.user_id AS owner_id,${source} AS source_state
        FROM course_skill_inputs s JOIN video_courses c ON c.id=s.course_id
        WHERE s.course_id=? AND ${managed}`, [courseId, ownerId]);
      if (!row) return null;
      return {
        courseId: Number(row.course_id), ownerId: row.owner_id, revision: row.revision, sourceState: row.source_state,
        sources: sources(row.source_state), settings: {
          generationEnabled: row.generation_enabled === 1, distributionEnabled: row.distribution_enabled === 1,
          policyVersion: row.policy_version, language: row.language,
        },
      };
    },
    async due(now, limit) {
      const rows = await driver.all<{ courseId: number; ownerId: string }>(`SELECT s.course_id AS "courseId", c.user_id AS "ownerId"
        FROM course_skill_inputs s JOIN video_courses c ON c.id=s.course_id
        WHERE s.generation_enabled=1 AND s.next_check_at<=? AND NOT c.managed_by_lms AND NOT c.native_access_disabled
        ORDER BY s.next_check_at,s.course_id LIMIT ?`, [now, limit]);
      return rows.map(row => ({ ...row, courseId: Number(row.courseId) }));
    },
    async affected(videoId) {
      const rows = await driver.all<{ courseId: number; ownerId: string }>(`SELECT s.course_id AS "courseId",c.user_id AS "ownerId"
        FROM course_skill_inputs s JOIN video_courses c ON c.id=s.course_id
        JOIN video_course_members m ON m.course_id=s.course_id
        WHERE m.video_id=? AND s.generation_enabled=1`, [videoId]);
      return rows.map(row => ({ ...row, courseId: Number(row.courseId) }));
    },
    async reconcile(snapshot, build, now) {
      const settings = snapshot.settings;
      const statements = [stmt(`UPDATE course_skill_inputs AS s SET
          revision=revision+CASE WHEN observed_input<>? THEN 1 ELSE 0 END,observed_input=?,next_check_at=?
          WHERE s.course_id=? AND s.revision=? AND s.generation_enabled=1 AND ${managed}
          AND s.policy_version=? AND s.language=? AND s.distribution_enabled=? AND ${source}=? RETURNING revision`,
        snapshot.sourceState, snapshot.sourceState, now + 60_000, snapshot.courseId, snapshot.revision, snapshot.ownerId,
        settings.policyVersion, settings.language, Number(settings.distributionEnabled), snapshot.sourceState)];
      if (build) statements.push(stmt(`INSERT INTO course_skill_builds(id,course_id,revision,input_key,input,created_at)
          SELECT ?,s.course_id,s.revision,?,?,? FROM course_skill_inputs s
          WHERE s.course_id=? AND s.revision BETWEEN ? AND ? AND s.observed_input=? AND s.generation_enabled=1
          AND s.policy_version=? AND s.language=? AND s.distribution_enabled=? AND ${managed} AND ${source}=?
          ON CONFLICT(course_id,input_key) DO UPDATE SET revision=excluded.revision,
            state=CASE WHEN course_skill_builds.state='completed' THEN 'completed' ELSE 'queued' END,
            lease_token=NULL,lease_until=0,generation=course_skill_builds.generation+1
          WHERE course_skill_builds.revision<>excluded.revision`,
        build.id, build.inputKey, build.input, now, snapshot.courseId, snapshot.revision, snapshot.revision + 1,
        snapshot.sourceState, settings.policyVersion, settings.language, Number(settings.distributionEnabled), snapshot.ownerId, snapshot.sourceState));
      const result = await driver.batch(statements);
      return result[0].length > 0;
    },
    async claim(id, ownerId, token, now, leaseMs) {
      if (!token || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 900_000) throw new Error('INVALID_SKILL_LEASE');
      const [row] = await driver.all<BuildRow>(`UPDATE course_skill_builds AS b SET state='running',lease_token=?,lease_until=?,generation=generation+1
        WHERE b.id=? AND (state='queued' OR state='running' AND lease_until<=?) AND ${current} RETURNING *`, [token, now + leaseMs, id, now, ownerId]);
      return row ? { id: row.id, courseId: Number(row.course_id), revision: row.revision, inputKey: row.input_key, input: row.input,
        state: row.state, leaseToken: row.lease_token, leaseUntil: Number(row.lease_until), generation: row.generation, checkpoint: row.checkpoint } : null;
    },
    async checkpoint(id, ownerId, token, generation, value, now) {
      if (value.length > 16_000) throw new Error('SKILL_CHECKPOINT_TOO_LARGE');
      const rows = await driver.all(`UPDATE course_skill_builds AS b SET checkpoint=? WHERE b.id=?
        AND state='running' AND lease_token=? AND generation=? AND lease_until>? AND ${current} RETURNING id`, [value, id, token, generation, now, ownerId]);
      return rows.length > 0;
    },
    async complete(id, ownerId, token, generation, now) {
      const rows = await driver.all(`UPDATE course_skill_builds AS b SET state='completed',lease_token=NULL,lease_until=0 WHERE b.id=?
        AND state='running' AND lease_token=? AND generation=? AND lease_until>? AND ${current} RETURNING id`, [id, token, generation, now, ownerId]);
      return rows.length > 0;
    },
  };
}
