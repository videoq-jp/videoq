import { currentSkillBuildPredicate, type SkillSqlDriver } from './course-skill-input-sql';
import type { CourseSkillKnowledgeRepository, SkillBuildLease } from './contracts/course-skill-knowledge-repository';
import type { SkillKnowledgeChunk } from '../domain/learning/skill-knowledge';

export function createSqlCourseSkillKnowledgeRepository(driver: SkillSqlDriver): CourseSkillKnowledgeRepository {
  const guard = `${currentSkillBuildPredicate(driver)} AND b.state='running' AND b.lease_token=? AND b.generation=? AND b.lease_until>?`;
  const args = (lease: SkillBuildLease, now: number) => [lease.ownerId, lease.token, lease.generation, now];
  return {
    async readPage(lease, videoId, offset, now) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('INVALID_SKILL_SOURCE_OFFSET');
      const [row] = await driver.all<{ content: string; chars: number; total: number }>(`SELECT substr(v.transcript,?,12000) AS content,
        length(substr(v.transcript,?,12000)) AS chars,length(v.transcript) AS total
        FROM videos v JOIN course_skill_builds b ON b.id=? WHERE v.id=? AND ${guard}
        AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.course_id=b.course_id AND m.video_id=v.id)
        AND v.user_id=? AND v.status='completed'`, [offset + 1, offset + 1, lease.id, videoId, ...args(lease, now), lease.ownerId]);
      return row ? { text: row.content, nextOffset: offset + Number(row.chars), done: offset + Number(row.chars) >= Number(row.total) } : null;
    },
    async visualSource(lease, videoId, now) {
      const [row] = await driver.all<{ id: number | string; file: string; run_id: string; publication_version: string | null }>(`SELECT v.id,v.file,vr.run_id,${driver.dialect === 'd1' ? 'vr.publication_version' : 'NULL'} AS publication_version FROM videos v JOIN video_visual_runs vr ON vr.video_id=v.id AND vr.file_key=v.file AND vr.status='ready' JOIN course_skill_builds b ON b.id=? WHERE v.id=? AND v.user_id=? AND ${guard} AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.course_id=b.course_id AND m.video_id=v.id)`, [lease.id, videoId, lease.ownerId, ...args(lease, now)]);
      if (!row) return null;
      const id = Number(row.id); // PostgreSQL bigint values arrive as strings.
      if (!Number.isSafeInteger(id) || id !== videoId) throw new Error('SKILL_INVALID_VISUAL_SOURCE');
      return { id, fileKey: row.file, expectedRunId: row.run_id, ...(driver.dialect === 'd1' ? { visualRunId: row.run_id, visualManifestVersion: row.publication_version } : {}) };
    },
    async cached(lease, key, now) {
      const [row] = await driver.all<{ content: string }>(`SELECT k.content FROM course_skill_knowledge_chunks k JOIN course_skill_builds b ON b.id=?
        WHERE k.key=? AND k.owner_id=? AND ${guard}
        AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.course_id=b.course_id AND m.video_id=k.video_id)`, [lease.id, key, lease.ownerId, ...args(lease, now)]);
      return row ? JSON.parse(row.content) as SkillKnowledgeChunk : null;
    },
    async save(lease, key, chunk, now) {
      const content = JSON.stringify(chunk);
      if (new TextEncoder().encode(content).byteLength > 240_000) throw new Error('SKILL_KNOWLEDGE_CHUNK_TOO_LARGE');
      const rows = await driver.all(`INSERT INTO course_skill_knowledge_chunks(key,owner_id,video_id,content)
        SELECT ?,?,?,? FROM course_skill_builds b WHERE b.id=? AND ${guard}
        AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.course_id=b.course_id AND m.video_id=?)
        ON CONFLICT(key) DO NOTHING RETURNING key`, [key, lease.ownerId, chunk.videoId, content, lease.id, ...args(lease, now), chunk.videoId]);
      return rows.length > 0 || await this.cached(lease, key, now) !== null;
    },
  };
}
