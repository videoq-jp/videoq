import { currentSkillBuildPredicate, skillSourceState, type SkillSqlDriver, type SkillStatement } from './course-skill-input-sql';
import type { CourseSkillPublication, CourseSkillPublicationRepository, SkillPublicationFile } from './contracts/course-skill-publication-repository';

type Row = { id: string; course_id: number; skill_id: string; name: string; description: string; manifest: string };
const decode = (r: Row): CourseSkillPublication => ({ id: r.id, courseId: Number(r.course_id), skillId: r.skill_id, name: r.name, description: r.description, manifest: JSON.parse(r.manifest) as CourseSkillPublication['manifest'] });

/** Read-time source checks revoke old URIs even before asynchronous reconciliation. */
export function publicationSourcesCurrent(driver: SkillSqlDriver): string {
  const actual = skillSourceState(driver.dialect);
  return driver.dialect === 'd1'
    ? `json_array_length(p.sources)>0 AND NOT EXISTS(SELECT 1 FROM json_each(p.sources) dep WHERE NOT EXISTS(SELECT 1 FROM json_each(${actual}) live WHERE json(live.value)=json(dep.value)))`
    : `jsonb_array_length(p.sources::jsonb)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.sources::jsonb) dep WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements((${actual})::jsonb) live WHERE live.value=dep.value))`;
}
export function createSqlCourseSkillPublicationRepository(driver: SkillSqlDriver): CourseSkillPublicationRepository {
  const current = currentSkillBuildPredicate(driver);
  const sourceCurrent = publicationSourcesCurrent(driver);
  const owner = `EXISTS(SELECT 1 FROM video_courses c WHERE c.id=p.course_id AND c.user_id=? AND NOT c.managed_by_lms AND NOT c.native_access_disabled)`;
  const readable = `s.distribution_enabled=1 AND p.state IN ('active','superseded') AND ${sourceCurrent}
    AND EXISTS(SELECT 1 FROM video_courses c WHERE c.id=p.course_id AND NOT c.managed_by_lms AND NOT c.native_access_disabled
      AND (c.user_id=? OR EXISTS(SELECT 1 FROM video_course_memberships m WHERE m.course_id=c.id AND m.user_id=?)))`;
  const hasDraft = driver.dialect === 'd1' ? `json_type(k.content,'$.draft')='object' AND json_array_length(k.content,'$.issues')=0`
    : `jsonb_typeof(k.content::jsonb->'draft')='object' AND jsonb_array_length(k.content::jsonb->'issues')=0`;
  const stmt = (sql: string, ...values: (string | number | null)[]): SkillStatement => ({ sql, values });
  return {
    async approve(candidateId, ownerId, expectedHash) {
      const rows = await driver.all(`UPDATE course_skill_candidates AS k SET status='approved',approved_hash=content_hash
        WHERE k.id=? AND k.content_hash=? AND ${hasDraft} AND k.status IN ('review_required','approved')
        AND EXISTS(SELECT 1 FROM course_skill_builds b WHERE b.id=k.build_id AND b.state='completed' AND ${current}) RETURNING id`, [candidateId, expectedHash, ownerId]);
      return rows.length > 0;
    },
    async stage(ownerId, input) {
      const [candidate] = await driver.all<{ content: string; input: string }>(`SELECT k.content,b.input FROM course_skill_candidates k JOIN course_skill_builds b ON b.id=k.build_id
        WHERE k.id=? AND k.content_hash=? AND k.approved_hash=k.content_hash AND b.state='completed' AND ${current}`, [input.candidateId, input.expectedHash, ownerId]);
      if (!candidate) return false;
      const content = JSON.parse(candidate.content) as { facts: { videoId: number }[] };
      const snapshot = JSON.parse(candidate.input) as { sourceState: string };
      const used = new Set(content.facts.map(f => f.videoId));
      const expectedSources = (JSON.parse(snapshot.sourceState) as unknown[][]).filter(tuple => used.has(Number(tuple[1])));
      if (!expectedSources.length || JSON.stringify(expectedSources) !== JSON.stringify(JSON.parse(input.sources))) throw new Error('INVALID_SKILL_PUBLICATION_SOURCES');
      if (!input.files.some(f => f.path === 'SKILL.md') || input.files.length > 128) throw new Error('INVALID_SKILL_FILES');
      if (input.files.reduce((size, file) => size + new TextEncoder().encode(file.content).byteLength, 0) > 4 * 1024 * 1024) throw new Error('SKILL_FILES_TOO_LARGE');
      for (const f of input.files) {
        const bytes = new TextEncoder().encode(f.content);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (!/^(SKILL\.md|references\/[a-z0-9-]+\.md)$/.test(f.path) || f.size !== bytes.byteLength || f.size > 240_000 || f.digest !== `sha256:${hash}`) throw new Error('INVALID_SKILL_FILE_MANIFEST');
      }
      if (new Set(input.files.map(f => f.path)).size !== input.files.length) throw new Error('DUPLICATE_SKILL_FILE');
      const manifest = JSON.stringify(input.files.map(({ path, digest, size }) => ({ path, digest, size })));
      const statements = [stmt(`INSERT INTO course_skill_publications(id,candidate_id,course_id,skill_id,name,description,content_hash,sources,manifest)
        SELECT ?,k.id,k.course_id,k.skill_id,?,?,?,?,? FROM course_skill_candidates k JOIN course_skill_builds b ON b.id=k.build_id
        WHERE k.id=? AND k.content_hash=? AND k.approved_hash=k.content_hash AND k.status='approved' AND b.state='completed' AND ${current}
        ON CONFLICT(id) DO NOTHING RETURNING id`, input.id, input.name, input.description, input.expectedHash, input.sources, manifest, input.candidateId, input.expectedHash, ownerId)];
      for (const f of input.files) statements.push(stmt(`INSERT INTO course_skill_files(revision_id,path,content,digest,size)
        SELECT p.id,?,?,?,? FROM course_skill_publications p WHERE p.id=? AND p.content_hash=? AND p.state='staged' AND ${owner}
        ON CONFLICT(revision_id,path) DO NOTHING`, f.path, f.content, f.digest, f.size, input.id, input.expectedHash, ownerId));
      const results = await driver.batch(statements);
      if (results[0].length > 0) return true;
      const rows = await driver.all(`SELECT p.id FROM course_skill_publications p WHERE p.id=? AND p.content_hash=? AND ${owner}`, [input.id, input.expectedHash, ownerId]);
      return rows.length > 0;
    },
    async publish(id, ownerId, expectedHash) {
      const completeFiles = driver.dialect === 'd1'
        ? `NOT EXISTS(SELECT 1 FROM json_each(p.manifest) item WHERE NOT EXISTS(SELECT 1 FROM course_skill_files f WHERE f.revision_id=p.id AND f.path=json_extract(item.value,'$.path') AND f.digest=json_extract(item.value,'$.digest') AND f.size=json_extract(item.value,'$.size')))`
        : `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest::jsonb) item WHERE NOT EXISTS(SELECT 1 FROM course_skill_files f WHERE f.revision_id=p.id AND f.path=item->>'path' AND f.digest=item->>'digest' AND f.size=(item->>'size')::integer))`;
      const results = await driver.batch([
        stmt(`UPDATE course_skill_publications AS p SET state='active' WHERE p.id=? AND p.content_hash=? AND p.state='staged'
          AND ${completeFiles} AND EXISTS(SELECT 1 FROM course_skill_candidates k JOIN course_skill_builds b ON b.id=k.build_id
            WHERE k.id=p.candidate_id AND k.content_hash=p.content_hash AND k.approved_hash=k.content_hash AND k.status='approved' AND b.state='completed' AND ${current}) RETURNING id`, id, expectedHash, ownerId),
        stmt(`INSERT INTO course_skill_heads(course_id,skill_id,revision_id)
          SELECT p.course_id,p.skill_id,p.id FROM course_skill_publications p WHERE p.id=? AND p.content_hash=? AND p.state='active' AND ${owner}
          ON CONFLICT(course_id,skill_id) DO UPDATE SET revision_id=excluded.revision_id`, id, expectedHash, ownerId),
        stmt(`UPDATE course_skill_publications AS p SET state='superseded' WHERE p.state='active' AND p.id<>?
          AND EXISTS(SELECT 1 FROM course_skill_heads h WHERE h.course_id=p.course_id AND h.skill_id=p.skill_id AND h.revision_id=?) AND ${owner}`, id, id, ownerId),
        stmt(`UPDATE course_skill_candidates SET status='published' WHERE id IN (SELECT candidate_id FROM course_skill_publications p WHERE p.id=? AND p.state='active' AND ${owner})`, id, ownerId),
        stmt(`SELECT p.id FROM course_skill_publications p JOIN course_skill_heads h ON h.revision_id=p.id WHERE p.id=? AND p.content_hash=? AND ${owner}`, id, expectedHash, ownerId),
      ]);
      return results[4].length > 0;
    },
    async list(userId, limit, after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_SKILL_PAGE');
      const rows = await driver.all<Row>(`SELECT p.* FROM course_skill_publications p JOIN course_skill_heads h ON h.revision_id=p.id
        JOIN course_skill_inputs s ON s.course_id=p.course_id WHERE p.id>? AND ${readable} ORDER BY p.id LIMIT ?`, [after, userId, userId, limit]);
      return rows.map(decode);
    },
    async get(id, userId) {
      const [row] = await driver.all<Row>(`SELECT p.* FROM course_skill_publications p JOIN course_skill_inputs s ON s.course_id=p.course_id
        WHERE p.id=? AND ${readable}`, [id, userId, userId]);
      return row ? decode(row) : null;
    },
    async read(id, path, userId) {
      const [row] = await driver.all<SkillPublicationFile>(`SELECT f.path,f.content,f.digest,f.size FROM course_skill_files f
        JOIN course_skill_publications p ON p.id=f.revision_id JOIN course_skill_inputs s ON s.course_id=p.course_id
        WHERE p.id=? AND f.path=? AND ${readable}`, [id, path, userId, userId]);
      return row ?? null;
    },
    async withdraw(courseId, skillId, ownerId) {
      const rows = await driver.all(`UPDATE course_skill_publications AS p SET state='revoked' WHERE p.course_id=? AND p.skill_id=? AND ${owner} RETURNING id`, [courseId, skillId, ownerId]);
      return rows.length > 0;
    },
    async managed(courseId, ownerId) {
      const rows = await driver.all<{ id: string; skill_id: string; state: string; valid_sources: number }>(`SELECT p.id,p.skill_id,p.state,
        CASE WHEN ${sourceCurrent} THEN 1 ELSE 0 END AS valid_sources FROM course_skill_publications p
        JOIN course_skill_heads h ON h.revision_id=p.id JOIN course_skill_inputs s ON s.course_id=p.course_id
        WHERE p.course_id=? AND ${owner}`, [courseId, ownerId]);
      return rows.map(row => ({ id: row.id, skillId: row.skill_id, state: row.state, validSources: row.valid_sources === 1 }));
    },
  };
}
