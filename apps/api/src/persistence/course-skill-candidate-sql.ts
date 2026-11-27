import { currentSkillBuildPredicate, type SkillSqlDriver } from './course-skill-input-sql';
import type { CourseSkillCandidate, CourseSkillCandidateContent, CourseSkillCandidateRepository } from './contracts/course-skill-candidate-repository';
import { validateSkillDraft } from '../domain/learning/course-skill-draft';

type Row = { id: string; course_id: number; build_id: string; build_revision?: number; skill_id: string; content: string; content_hash: string; status: string; approved_hash: string | null };
const decode = (row: Row): CourseSkillCandidate => ({ id: row.id, courseId: Number(row.course_id), buildId: row.build_id, skillId: row.skill_id,
  content: JSON.parse(row.content) as CourseSkillCandidateContent, contentHash: row.content_hash, status: row.status, approvedHash: row.approved_hash, buildRevision: row.build_revision ?? -1 });
const owns = `EXISTS(SELECT 1 FROM video_courses c WHERE c.id=k.course_id AND c.user_id=? AND NOT c.managed_by_lms AND NOT c.native_access_disabled)`;

export function createSqlCourseSkillCandidateRepository(driver: SkillSqlDriver): CourseSkillCandidateRepository {
  const current = currentSkillBuildPredicate(driver);
  const serialize = (content: CourseSkillCandidateContent) => {
    if (content.draft) validateSkillDraft(content.draft, content.facts);
    const text = JSON.stringify(content);
    if (new TextEncoder().encode(text).byteLength > 240_000) throw new Error('SKILL_CANDIDATE_TOO_LARGE');
    return text;
  };
  return {
    async save(lease, candidate, now) {
      const content = serialize(candidate.content);
      const rows = await driver.all(`INSERT INTO course_skill_candidates(id,course_id,build_id,skill_id,content,content_hash)
        SELECT ?,b.course_id,b.id,?,?,? FROM course_skill_builds b WHERE b.id=? AND ${current}
        AND b.state='running' AND b.lease_token=? AND b.generation=? AND b.lease_until>?
        ON CONFLICT(build_id,skill_id) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,status='review_required',approved_hash=NULL
        WHERE course_skill_candidates.status<>'published'
        RETURNING id`, [candidate.id, candidate.content.task.skillId, content, candidate.contentHash, lease.id, lease.ownerId, lease.token, lease.generation, now]);
      return rows.length > 0;
    },
    async list(courseId, ownerId) {
      const rows = await driver.all<Row>(`SELECT k.*,b.revision AS build_revision FROM course_skill_candidates k JOIN course_skill_builds b ON b.id=k.build_id
        WHERE k.course_id=? AND ${owns} ORDER BY b.revision,k.id`, [courseId, ownerId]);
      return rows.map(decode);
    },
    async edit(id, ownerId, expectedHash, content, newHash) {
      const text = serialize(content);
      // Edits may alter draft prose only. Source facts and task identity remain server-derived.
      const [stored] = await driver.all<Row>(`SELECT k.* FROM course_skill_candidates k WHERE k.id=? AND k.content_hash=? AND k.status<>'published' AND ${owns} AND EXISTS(SELECT 1 FROM course_skill_builds b WHERE b.id=k.build_id AND b.state='completed')`, [id, expectedHash, ownerId]);
      if (!stored) return false;
      const original = decode(stored).content;
      if (JSON.stringify(original.task) !== JSON.stringify(content.task) || JSON.stringify(original.facts) !== JSON.stringify(content.facts)) throw new Error('SKILL_EVIDENCE_EDIT_FORBIDDEN');
      const rows = await driver.all(`UPDATE course_skill_candidates AS k SET content=?,content_hash=?,status='review_required',approved_hash=NULL
        WHERE k.id=? AND k.content_hash=? AND k.status<>'published' AND ${owns} AND EXISTS(SELECT 1 FROM course_skill_builds b WHERE b.id=k.build_id AND b.state='completed') RETURNING id`, [text, newHash, id, expectedHash, ownerId]);
      return rows.length > 0;
    },
    async reject(id, ownerId, expectedHash) {
      return (await driver.all(`UPDATE course_skill_candidates AS k SET status='rejected',approved_hash=NULL WHERE k.id=? AND k.content_hash=? AND k.status<>'published' AND ${owns} AND EXISTS(SELECT 1 FROM course_skill_builds b WHERE b.id=k.build_id AND b.state='completed') RETURNING id`, [id, expectedHash, ownerId])).length > 0;
    },
  };
}
