import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { courseTags, courseTagInput, type CourseTagScope } from '../src/features/lti/course-tags';
import type { Bindings } from '../src/types/bindings';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Moodle course tags on PostgreSQL', () => {
  const database = 'videoq_tags_' + crypto.randomUUID().replaceAll('-', '');
  const errors: Error[] = [];
  let admin: pg.Pool, pool: pg.Pool, env: Bindings, scope: CourseTagScope, other: CourseTagScope, first: number, second: number;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl }); admin.on('error', error => errors.push(error));
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 }); pool.on('error', error => errors.push(error));
    env = { DATABASE_POOL: pool } as Bindings;
    const client = await pool.connect(); try { await migrateDatabase(client); } finally { client.release(); }
  }, 60000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE users,external_tasks CASCADE;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','owner','owner@example.test',false,0,0,0,1,2);
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
      VALUES('school','owner','Moodle','https://lms.example','client','deployment','https://lms.example/auth','https://lms.example/keys','${'c'.repeat(64)}');`);
    async function resource(id: string, contextId = 'course') {
      return syncLmsResource(env, { id: 'school', ownerUserId: 'owner' }, id, { contextId, resourceLinkId: id,
        generation: 1, enabled: true, title: id, file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: 'a'.repeat(40) } });
    }
    const a = await resource('first'), b = await resource('second'), c = await resource('other', 'other-course');
    first = a.videoId!; second = b.videoId!;
    scope = { installationId: 'school', contextId: 'course', courseId: a.courseId!, ownerUserId: 'owner', actorKey: 'b'.repeat(64),
      readableVideoIds: [first,second], manage: true, management: [{ videoId: first,resourceLinkId: 'first',generation: 1 },{ videoId: second,resourceLinkId: 'second',generation: 1 }] };
    other = { ...scope,contextId: 'other-course',courseId: c.courseId!,readableVideoIds: [c.videoId!],management: [{ videoId: c.videoId!,resourceLinkId: 'other',generation: 1 }] };
    await pool.query("UPDATE videos SET status='completed'");
    await pool.query("INSERT INTO tags(name,color,created_at,user_id) VALUES('Private global tag','red',now(),'owner')");
  });
  afterAll(async () => { await pool?.end(); try { await admin?.query(`DROP DATABASE IF EXISTS "${database}"`); } finally { await admin?.end(); } expect(errors).toEqual([]); });
  const run = (input: unknown, principal = scope) => courseTags(env, principal, courseTagInput.parse(input));
  const list = (principal = scope) => run({ action: 'list' }, principal);
  const create = (name = 'Concept', principal = scope, operationId = crypto.randomUUID()) => run({ action: 'create',name,color: 'blue',operationId }, principal);
  async function assign(videoId: number, tagIds: string[], principal = scope, revision?: string) {
    return run({ action: 'assign',videoId,tagIds,revision: revision ?? (await list(principal)).videos.find(v => v.videoId === videoId)!.revision,operationId: crypto.randomUUID() }, principal);
  }
  it('isolates course and global vocabularies while projecting no account, actor or resource identities', async () => {
    expect((await list()).tags).toEqual([]);
    await create(); const result = await create('Other private vocabulary', other);
    expect((await list()).tags.map(t => t.name)).toEqual(['Concept']);
    expect(result.tags.map(t => t.name)).toEqual(['Other private vocabulary']);
    expect(JSON.stringify(await list())).not.toMatch(/owner|actorKey|installation|resource|Private global/);
    expect((await pool.query('SELECT name FROM tags')).rows).toEqual([{ name: 'Private global tag' }]);
  });
  it('supports create, color/name edits, assignment, removal and safe repeated deletion', async () => {
    const created = await create(), tag = created.tags[0];
    const assigned = await assign(first,[tag.id]);
    expect(assigned.tags[0].videoIds).toEqual([first]);
    const updated = await run({ action: 'update',id: tag.id,revision: tag.revision,name: 'Revised',color: 'green',operationId: crypto.randomUUID() });
    expect(updated.tags[0]).toMatchObject({ name: 'Revised',color: 'green',editable: true });
    const input = { action: 'delete',id: tag.id,revision: updated.tags[0].revision,operationId: crypto.randomUUID() };
    expect((await run(input)).tags).toEqual([]);
    expect((await run(input)).reused).toBe(true);
    expect((await pool.query('SELECT * FROM lti_course_video_tags')).rows).toEqual([]);
    expect((await pool.query('SELECT name FROM tags')).rows[0].name).toBe('Private global tag');
  });
  it('learners see only tags and counts attached to their currently readable materials', async () => {
    const tag = (await create()).tags[0], hidden = (await create('Hidden material name')).tags.find(t => t.name.startsWith('Hidden'))!;
    await create('Unused teacher vocabulary'); await assign(first,[tag.id]); await assign(second,[tag.id,hidden.id]);
    const learner = { ...scope,manage: false,management: [],readableVideoIds: [first] };
    const result = await list(learner);
    expect(result.tags).toEqual([{ ...tag,videoIds: [first],editable: false }]);
    expect(result.videos.map(v => v.videoId)).toEqual([first]);
    expect(result.canManage).toBe(false);
    expect((await list({ ...learner,readableVideoIds: [] })).tags).toEqual([]);
    await expect(create('Forbidden',learner)).rejects.toMatchObject({ status: 403 });
  });
  it('a partial manager may tag their material but cannot rename/delete vocabulary shared with an unmanageable source', async () => {
    const tag = (await create()).tags[0]; await assign(first,[tag.id]); await assign(second,[tag.id]);
    const partial = { ...scope,readableVideoIds: [first],management: scope.management.slice(0,1) };
    expect((await list(partial)).tags[0]).toMatchObject({ videoIds: [first],editable: false });
    for (const action of ['update','delete']) await expect(run({ action,id: tag.id,revision: tag.revision,
      ...(action === 'update' ? { name: 'Overreach',color: 'red' } : {}),operationId: crypto.randomUUID() },partial)).rejects.toMatchObject({ status: 403 });
    await assign(first,[],partial);
    expect((await list(partial)).tags).toEqual([]);
    await expect(assign(second,[],partial,'a'.repeat(64))).rejects.toMatchObject({ status: 403 });
  });
  it('rejects foreign-course tag IDs, source generations, disabled sources, changed owners and missing memberships', async () => {
    const foreign = (await create('Foreign',other)).tags[0];
    await expect(assign(first,[foreign.id])).rejects.toMatchObject({ status: 403 });
    const tag = (await create()).tags[0];
    const staleRevision = (await list()).videos.find(video => video.videoId === first)!.revision;
    await pool.query('UPDATE lms_resources SET generation=2 WHERE video_id=$1',[first]);
    await expect(assign(first,[tag.id],scope,staleRevision)).rejects.toMatchObject({ status: 403 });
    await pool.query('UPDATE lms_resources SET generation=1,enabled=false WHERE video_id=$1',[first]);
    await expect(assign(first,[tag.id],scope,staleRevision)).rejects.toMatchObject({ status: 403 });
    await pool.query('UPDATE lms_resources SET enabled=true WHERE video_id=$1',[first]);
    await pool.query('DELETE FROM video_course_members WHERE video_id=$1',[first]);
    await expect(assign(first,[tag.id],scope,staleRevision)).rejects.toMatchObject({ status: 403 });
    await expect(list({ ...scope,ownerUserId: 'unknown' })).rejects.toMatchObject({ status: 403 });
    expect((await pool.query('SELECT * FROM lti_course_video_tags')).rows).toEqual([]);
  });
  it('preserves a newer tag edit and a newer assignment when stale forms are submitted', async () => {
    const tag = (await create()).tags[0], revision = (await list()).videos.find(v => v.videoId === first)!.revision;
    await run({ action: 'update',id: tag.id,revision: tag.revision,name: 'New name',color: 'red',operationId: crypto.randomUUID() });
    await expect(run({ action: 'delete',id: tag.id,revision: tag.revision,operationId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    await assign(first,[tag.id]);
    await expect(assign(first,[],scope,revision)).rejects.toMatchObject({ status: 409 });
    expect((await list()).tags[0]).toMatchObject({ name: 'New name',videoIds: [first] });
  });
  it('serializes concurrent duplicate creates and binds replay to actor, course and request contents', async () => {
    const id = crypto.randomUUID(); const original = { action: 'create',name: 'Concept',color: 'gray',operationId: id };
    const results = await Promise.all([run(original),run(original)]);
    expect(results.map(r => r.reused).sort()).toEqual([false,true]);
    await expect(run(original,{ ...scope,actorKey: 'd'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(run({ ...original,name: 'Forged' })).rejects.toMatchObject({ status: 409 });
    await expect(run(original,other)).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('SELECT * FROM lti_course_tag_operations')).rows).toHaveLength(1);
    expect(JSON.stringify((await pool.query('SELECT * FROM lti_course_tag_operations')).rows)).not.toMatch(/Concept|gray|owner@example/);
  });
  it('caps course vocabulary, rejects duplicate assignment IDs and cascades course/material cleanup', async () => {
    await pool.query("INSERT INTO lti_course_tags(id,course_id,name,color) SELECT gen_random_uuid(),$1,'Tag '||n,'gray' FROM generate_series(0,199) n",[scope.courseId]);
    await expect(create()).rejects.toMatchObject({ status: 413 });
    const tag = (await list()).tags[0];
    expect(courseTagInput.safeParse({ action: 'assign',videoId: first,tagIds: [tag.id,tag.id],revision: 'a'.repeat(64),operationId: crypto.randomUUID() }).success).toBe(false);
    await assign(first,[tag.id]);
    await pool.query('DELETE FROM videos WHERE id=$1',[first]);
    expect((await pool.query('SELECT * FROM lti_course_video_tags')).rows).toEqual([]);
    await pool.query('DELETE FROM video_courses WHERE id=$1',[scope.courseId]);
    expect((await pool.query('SELECT * FROM lti_course_tags WHERE course_id=$1',[scope.courseId])).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM lti_course_tag_operations WHERE course_id=$1',[scope.courseId])).rows).toEqual([]);
  });
  it('rechecks read bindings after authorization and leaves course vocabulary behind when a source moves', async () => {
    const tag = (await create()).tags[0]; await assign(first,[tag.id]);
    const learner = {...scope,manage:false,management:[],readableVideoIds:[first]};
    await pool.query("UPDATE videos SET status='indexing' WHERE id=$1",[first]);
    expect((await list(learner)).tags).toEqual([]);
    expect((await list(learner)).videos).toEqual([]);
    await pool.query("UPDATE videos SET status='completed' WHERE id=$1",[first]);
    const moved = await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'first',{
      contextId:'other-course',resourceLinkId:'moved',generation:2,enabled:true,title:'Moved source',
      file:{filename:'lesson.mp4',contentType:'video/mp4',size:10,contentHash:'a'.repeat(40)},
    });
    expect(moved.videoId).toBe(first);
    expect((await list(learner)).tags).toEqual([]);
    expect((await list(learner)).videos).toEqual([]);
    expect((await list()).tags[0]).toMatchObject({id:tag.id,videoIds:[],editable:true});
    expect((await list(other)).tags).toEqual([]);
    expect((await pool.query('SELECT * FROM lti_course_video_tags')).rows).toEqual([]);
  });
  it('keeps the same course assignments through an ordinary resync and temporary disable/re-enable', async () => {
    const tag=(await create()).tags[0];await assign(first,[tag.id]);
    const manifest={contextId:'course',resourceLinkId:'first',title:'Updated Moodle title',
      file:{filename:'lesson.mp4',contentType:'video/mp4',size:10,contentHash:'a'.repeat(40)}};
    await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'first',{...manifest,generation:2,enabled:true});
    expect((await pool.query('SELECT video_id FROM lti_course_video_tags WHERE tag_id=$1',[tag.id])).rows).toEqual([{video_id:String(first)}]);
    await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'first',{...manifest,generation:3,enabled:false});
    expect((await list({...scope,manage:false,management:[],readableVideoIds:[first]})).tags).toEqual([]);
    const restored=await syncLmsResource(env,{id:'school',ownerUserId:'owner'},'first',{...manifest,generation:4,enabled:true});
    expect(restored.videoId).toBe(first);
    const current={...scope,management:scope.management.map(source=>source.videoId===first?{...source,generation:4}:source)};
    expect((await list(current)).tags[0]).toMatchObject({id:tag.id,videoIds:[first],editable:true});
  });
});
