import { readFile } from 'node:fs/promises';
import { describe } from 'vitest';
import { isolatedPostgres } from './isolated-postgres';
import { courseSkillInputContract } from './contracts/course-skill-input.contract';
import { createPostgresCourseSkillInputRepository } from '../../src/persistence/postgres/course-skill-input-repository';
import type { Bindings } from '../../src/types/bindings';

const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('PostgreSQL skill inputs', () => {
  courseSkillInputContract('PostgreSQL', async () => {
    const f = await isolatedPostgres(url!);
    const execute = async (sql: string, values: (string | number)[] = []) => { let index = 0; await f.pool.query(sql.replaceAll('?', () => `$${++index}`), values); };
    await execute(`CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text,managed_by_lms boolean DEFAULT false,native_access_disabled boolean DEFAULT false);
      CREATE TABLE videos(id bigint PRIMARY KEY,user_id text,title text,status text,transcript text,file text);
      CREATE TABLE video_course_members(id bigserial PRIMARY KEY,course_id bigint REFERENCES video_courses,video_id bigint REFERENCES videos,added_at text,"order" integer);
      CREATE TABLE video_visual_runs(video_id bigint PRIMARY KEY,run_id uuid,status text,file_key text);
      INSERT INTO video_courses(id,user_id) VALUES(1,'owner');
      INSERT INTO videos VALUES(1,'owner','Video','processing','','file.mp4');`);
    // The isolated fixture uses search_path; production migrations target public.
    await execute((await readFile(new URL('../../drizzle/0069_course_skill_inputs.sql', import.meta.url), 'utf8')).replaceAll('"public".', ''));
    return { repository: createPostgresCourseSkillInputRepository({ DATABASE_POOL: f.pool } as Bindings), execute,
      jobs: async () => (await f.pool.query<{ id: string; input: string }>('SELECT id,input FROM course_skill_builds ORDER BY created_at,id')).rows,
      dispose: f.dispose };
  });
});
