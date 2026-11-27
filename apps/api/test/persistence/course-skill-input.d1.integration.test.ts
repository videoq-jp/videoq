import { createD1Fixture } from './d1-fixture';
import { createD1CourseSkillInputRepository } from '../../src/persistence/d1/course-skill-input-repository';
import { courseSkillInputContract } from './contracts/course-skill-input.contract';
import { createD1SkillSqlDriver } from '../../src/persistence/d1/course-skill-input-repository';
import { createSqlCourseSkillKnowledgeRepository } from '../../src/persistence/course-skill-knowledge-sql';
import { createSqlCourseSkillCandidateRepository } from '../../src/persistence/course-skill-candidate-sql';
import { createSqlCourseSkillPublicationRepository } from '../../src/persistence/course-skill-publication-sql';

courseSkillInputContract('D1 course skill inputs', async () => {
  const f = await createD1Fixture();
  const execute = async (sql: string, values: (string | number)[] = []) => { await f.database.prepare(sql).bind(...values).run(); };
  for (const id of ['owner', 'other']) await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)', [id, id, `${id}@example.test`]);
  await execute("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (1,'owner','Video','file.mp4','processing','','','2026-11-27','','uploaded','','')");
  await execute("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES (2,'owner','Video 2','file2.mp4','processing','','','2026-11-27','','uploaded','','')");
  await execute("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','Course','','2026-11-27','2026-11-27',0)");
  return { repository: createD1CourseSkillInputRepository(f.database), execute,
    knowledge: createSqlCourseSkillKnowledgeRepository(createD1SkillSqlDriver(f.database)),
    candidates: createSqlCourseSkillCandidateRepository(createD1SkillSqlDriver(f.database)),
    publications: createSqlCourseSkillPublicationRepository(createD1SkillSqlDriver(f.database)),
    jobs: async () => (await f.database.prepare('SELECT id,input FROM course_skill_builds ORDER BY created_at,id').all<{ id: string; input: string }>()).results,
    dispose: f.dispose };
});
