import { beforeAll, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, videos, videoCourses, mcpIdempotencyRecords, externalTasks } from '../../src/db/schema';
import { createCourse } from '../../src/persistence/postgres/course-repository';
import { createPostgresVideoUploadRepository } from '../../src/persistence/postgres/video-upload-repository';
import type { Bindings } from '../../src/types/bindings';
import { assertPostgresColumnContract } from '../helpers/postgres-column-contract';
import { isolatedPostgres } from './isolated-postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('production-derived PostgreSQL input constraints', () => {
  let ddl: string;
  beforeAll(async () => { ddl=(await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,videoCourses,mcpIdempotencyRecords,externalTasks}))).map(s=>s.replaceAll('"public".','')).join('\n'); });
  async function setup() {
    const f=await isolatedPostgres(url!);
    try {
      await f.pool.query(ddl);
      await f.pool.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',false,0,0,0)");
      return {...f,env:{DATABASE_POOL:f.pool} as Bindings};
    } catch(error) { await f.dispose();throw error; }
  }
  it('enforces course length/nullability and the functional share uniqueness constraint', async () => {
    const f=await setup();try {
      await assertPostgresColumnContract(f.pool,videoCourses,['name','description','shareSlug']);
      await expect(createCourse(f.env,'owner','x'.repeat(255),'日本語 😀')).resolves.toMatchObject({ok:true});
      await expect(createCourse(f.env,'owner','x'.repeat(256),'')).rejects.toMatchObject({cause:{code:'22001'}});
      await f.pool.query("UPDATE video_courses SET share_slug='Shared' WHERE user_id='owner'");
      await createCourse(f.env,'owner','Other','');
      await expect(f.pool.query("UPDATE video_courses SET share_slug='shared' WHERE name='Other'")).rejects.toMatchObject({code:'23505'});
      await expect(f.pool.query('UPDATE video_courses SET name=NULL')).rejects.toMatchObject({code:'23502'});
    }finally{await f.dispose();}
  });
  it.each([
    ['title',255], ['sourceUrl',200],
  ] as const)('enforces actual video %s boundaries and rolls back rejection', async (field,max) => {
    const f=await setup();try {
      await assertPostgresColumnContract(f.pool,videos,['file','title','description','sourceUrl']);
      const repo=createPostgresVideoUploadRepository(f.env);
      const input={userId:'owner',sourceUrl:'https://youtu.be/abcdefghijk',youtubeVideoId:'abcdefghijk',title:'Clip',description:''};
      await expect(repo.createYoutube({...input,[field]:'x'.repeat(max)})).resolves.toMatchObject({videoId:1,reused:false});
      await expect(repo.createYoutube({...input,[field]:'x'.repeat(max+1)})).rejects.toMatchObject({cause:{code:'22001'}});
      expect(Number((await f.pool.query('SELECT count(*) AS n FROM videos')).rows[0].n)).toBe(1);
      await expect(f.pool.query('UPDATE videos SET file=$1',['x'.repeat(101)])).rejects.toMatchObject({code:'22001'});
    }finally{await f.dispose();}
  });
  it('detects a deliberately weakened fixture instead of accepting text as varchar', async () => {
    const f=await setup();try {
      await f.pool.query('ALTER TABLE video_courses ALTER COLUMN name TYPE text');
      await expect(assertPostgresColumnContract(f.pool,videoCourses,['name'])).rejects.toThrow('Fixture constraint drift');
    }finally{await f.dispose();}
  });
});
