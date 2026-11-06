import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { getCourseDetail, getCourseDetailByShareSlug, listCoursesPage, setShareSlug, clearShareSlug,
  updateCourse, deleteCourse, reorderVideos } from '../src/repositories/course-repository';
import { getCourseWithMembers, shareSlugExists, updateChatLogFeedback } from '../src/repositories/chat-repository';
import { addVideoToCourse, addVideosBulk, removeVideoFromCourse } from '../src/repositories/membership-repository';
import { createPendingCourseInvitations, getCourseInvitationByTokenHash, acceptCourseInvitation,
  rotatePendingCourseInvitation, revokePendingCourseInvitation } from '../src/repositories/course-invitation-repository';
import { conversationScope } from '../src/features/chat/conversation-service';
import { qaInputSchemas } from '../../../packages/trpc/src/qa';
import { listQuestions } from '../src/features/qa/service';
import { deliverInvitationEmail } from '../src/lib/invitation-delivery';
import { getMediaPathAccess } from '../src/repositories/media-repository';
import { mediaRoutes } from '../src/features/media/routes';
import * as auth from '../src/middleware/auth';
import * as mail from '../src/lib/mail';
import type { Bindings } from '../src/types/bindings';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Moodle course authority across native entry points', () => {
  const database = 'videoq_authority_' + crypto.randomUUID().replaceAll('-', '');
  let admin: pg.Pool, pool: pg.Pool, env: Bindings;
  const read = { includeFileUrls: false, includeTags: false };
  const pending = 'a'.repeat(64), accepted = 'b'.repeat(64), native = 'c'.repeat(64);
  const citedAnswer = JSON.stringify({ segments: [{ text: 'Earlier Moodle answer', sourceIds: [1] }],
    sources: [{ id: 1, video_id: 100, title: 'Moodle lesson', start_time: null, end_time: null }] });
  const backfill: string = readFileSync(new URL('../drizzle/0054_backfill_lms_video_authority.sql', import.meta.url), 'utf8');
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl }); admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 }); pool.on('error', () => {});
    const client = await pool.connect();
    try { await migrateDatabase(client); } finally { client.release(); }
    env = { DATABASE_POOL: pool } as Bindings;
  }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query(`TRUNCATE users CASCADE; TRUNCATE external_tasks;
      INSERT INTO users(id,username,email,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
        VALUES('owner','owner','owner@example.test',true,false,0,0,0),
        ('member','member','member@example.test',true,false,0,0,0),
        ('candidate','candidate','candidate@example.test',true,false,0,0,0),
        ('other','other','other@example.test',true,false,0,0,0);
      INSERT INTO videos(id,user_id,title,description,file,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
        VALUES(100,'owner','Moodle lesson','','source.mp4',now(),'','completed','','uploaded','',''),
        (101,'owner','Native lesson','','native.mp4',now(),'','completed','','uploaded','',''),
        (200,'other','Other owner lesson','','other.mp4',now(),'','completed','','uploaded','','');
      INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order,share_slug,managed_by_lms)
        VALUES(10,'owner','Moodle course','',now(),now(),0,'moodle-old-link',true),
        (20,'owner','Legacy mixed course','',now(),now(),1,'mixed-old-link',false),
        (30,'owner','Independent course','',now(),now(),2,'native-link',false),
        (40,'other','Other account','',now(),now(),0,'other-link',false),
        (50,'owner','Earlier answer course','',now(),now(),3,'history-link',false),
        (60,'owner','Earlier discussion course','',now(),now(),4,'forum-link',false),
        (70,'owner','Earlier memory course','',now(),now(),5,'memory-link',false);
      INSERT INTO video_course_members(course_id,video_id,"order",added_at)
        VALUES(10,100,0,now()),(20,100,0,now()),(20,101,1,now()),(30,101,0,now()),(40,200,0,now()),
        (50,101,0,now()),(60,101,0,now()),(70,101,0,now());
      INSERT INTO video_course_memberships(course_id,user_id,joined_at)
        VALUES(10,'member',now()),(20,'member',now()),(30,'member',now()),(50,'member',now()),(60,'member',now()),(70,'member',now());
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
        VALUES('platform','owner','Moodle','https://lms.example','client','deployment','https://lms.example/auth','https://lms.example/keys','${'e'.repeat(64)}');
      INSERT INTO lms_courses(id,installation_id,context_id,course_id) VALUES('${crypto.randomUUID()}','platform','course',10);
      INSERT INTO lms_resources(id,installation_id,external_id,context_id,resource_link_id,generation,manifest_hash,enabled,course_id,video_id)
        VALUES('${crypto.randomUUID()}','platform','source','course','activity',1,'seed',true,10,100),
        ('${crypto.randomUUID()}','platform','foreign','foreign','foreign-activity',1,'seed',true,40,200);
      INSERT INTO video_course_invitations(id,course_id,email,invited_by_user_id,token_hash,status,accepted_by_user_id,expires_at,created_at,updated_at)
        VALUES(400,10,'candidate@example.test','owner','${pending}','pending',NULL,now()+interval '1 day',now(),now()),
        (401,20,'member@example.test','owner','${accepted}','accepted','member',now()+interval '1 day',now(),now()),
        (402,30,'candidate@example.test','owner','${native}','pending',NULL,now()+interval '1 day',now(),now());
    `);
    await pool.query(`INSERT INTO chat_logs(course_id,user_id,question,response,retrieved_contexts,is_shared_origin,created_at)
      VALUES(50,'member','Earlier question',$1::jsonb,'[]',false,now())`, [citedAnswer]);
    await pool.query(`INSERT INTO course_questions(course_id,source_video_id,author_id,title,body)
      VALUES(60,100,'member','Earlier lesson question','Published before the source was detached');
      INSERT INTO chat_conversations(thread_id,owner_user_id,actor_user_id,course_id,expires_at,committed_checkpoint_id)
        VALUES('legacy-memory','owner','member',70,now()+interval '1 day','legacy-checkpoint')`);
    await pool.query(`INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response)
      VALUES('legacy-memory','legacy-checkpoint','Earlier saved question',$1::jsonb)`, [citedAnswer]);
    await pool.query(backfill);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); await pool?.end();
    try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); }
    finally { await admin?.end(); }
  });

  it('backfills recoverable provenance without relabelling another account or native materials', async () => {
    expect((await pool.query('SELECT id::int,managed_by_lms FROM videos ORDER BY id')).rows).toEqual([
      { id: 100, managed_by_lms: true }, { id: 101, managed_by_lms: false }, { id: 200, managed_by_lms: false },
    ]);
    expect((await pool.query('SELECT id::int,native_access_disabled FROM video_courses ORDER BY id')).rows).toEqual([
      { id: 10, native_access_disabled: true }, { id: 20, native_access_disabled: true },
      { id: 30, native_access_disabled: false }, { id: 40, native_access_disabled: false },
      { id: 50, native_access_disabled: true }, { id: 60, native_access_disabled: true }, { id: 70, native_access_disabled: true },
    ]);
    await pool.query(backfill); // Idempotent data migration.
  });
  it('excludes protected course titles, totals, details and media from stale native memberships', async () => {
    expect(await listCoursesPage(env, 'member', 20, 0)).toMatchObject({ count: 1, results: [{ id: 30 }] });
    expect((await listCoursesPage(env, 'owner', 20, 0)).results.map(c => c.id)).toEqual([10,20,30,50,60,70]);
    for (const id of [10,20]) {
      expect(await getCourseDetail(env, id, 'member', read)).toBeNull();
      expect(await getCourseDetail(env, id, 'owner', read)).not.toBeNull();
    }
    expect(await getCourseDetailByShareSlug(env, 'moodle-old-link', read)).toBeNull();
    expect(await getCourseDetailByShareSlug(env, 'mixed-old-link', read)).toBeNull();
    expect(await getCourseDetailByShareSlug(env, 'native-link', read)).not.toBeNull();
    expect(await getMediaPathAccess(env, 'source.mp4', { userId: 'member' })).toBe(false);
    expect(await getMediaPathAccess(env, 'source.mp4', { shareSlug: 'moodle-old-link' })).toBeNull();
    expect(await getMediaPathAccess(env, 'source.mp4', { shareSlug: 'mixed-old-link' })).toBeNull();
    expect(await getMediaPathAccess(env, 'source.mp4', { userId: 'owner' })).toBe(true);
    expect(await getMediaPathAccess(env, 'native.mp4', { userId: 'member' })).toBe(true);
    expect(await getMediaPathAccess(env, 'native.mp4', { shareSlug: 'native-link' })).toBe(true);
  });
  it.each([[50,'history-link'],[60,'forum-link'],[70,'memory-link']] as const)(
    'quarantines course %s with recoverable historical sources even after the source membership is gone', async (id, slug) => {
      expect((await pool.query('SELECT video_id::int FROM video_course_members WHERE course_id=$1', [id])).rows).toEqual([{ video_id: 101 }]);
      expect(await getCourseDetail(env, id, 'member', read)).toBeNull();
      expect(await getCourseDetail(env, id, 'owner', read)).not.toBeNull();
      expect(await getCourseDetailByShareSlug(env, slug, read)).toBeNull();
      await expect(conversationScope(env, 'member', { courseId: id })).rejects.toMatchObject({ status: 404 });
      await expect(listQuestions(env, 'member', qaInputSchemas['qa.list'].parse({ courseId: id }))).rejects.toMatchObject({ status: 404 });
    });
  it('denies shared/member chat and saved-conversation entry while preserving checked LTI and owner access', async () => {
    for (const [id, slug] of [[10,'moodle-old-link'],[20,'mixed-old-link']] as const) {
      expect(await getCourseWithMembers(env, { courseId: id, userId: 'member' })).toBeNull();
      expect(await getCourseWithMembers(env, { courseId: id, shareToken: slug })).toBeNull();
      expect(await shareSlugExists(env, slug)).toBe(false);
      await expect(conversationScope(env, 'member', { courseId: id })).rejects.toMatchObject({ status: 404 });
      await expect(conversationScope(env, null, { courseId: id, shareSlug: slug }, 'visitor')).rejects.toMatchObject({ status: 404 });
      expect(await getCourseWithMembers(env, { courseId: id, userId: 'owner' })).not.toBeNull();
    }
    expect(await getCourseWithMembers(env, { courseId: 10, ltiCourseGrant: 10, ltiVideoGrant: [100] })).toMatchObject({ memberVideoIds: [100] });
    expect(await shareSlugExists(env, 'native-link')).toBe(true);
  });
  it('rejects both legacy public media query aliases before reading storage or issuing a redirect', async () => {
    vi.spyOn(auth, 'sessionMethod').mockResolvedValue({ kind: 'absent' });
    const get = vi.fn();
    const requestEnv = { ...env, ENVIRONMENT: 'development', VIDEO_BUCKET: { get } } as Bindings;
    for (const parameter of ['share_slug','share_token']) {
      for (const slug of ['moodle-old-link','mixed-old-link']) {
        const response = await mediaRoutes.request('/api/media/source.mp4?'+parameter+'='+slug, {}, requestEnv);
        expect(response.status).toBe(401);
        expect(response.headers.has('location')).toBe(false);
      }
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects old public feedback grants while keeping the independently authenticated data owner', async () => {
    const answer = JSON.stringify({ segments: [{ text: 'Stored answer', sourceIds: [] }], sources: [] });
    const result = await pool.query(`INSERT INTO chat_logs(course_id,user_id,question,response,retrieved_contexts,is_shared_origin,created_at)
      VALUES(20,'owner','Stored question',$1::jsonb,'[]',true,now()) RETURNING id::int`, [answer]);
    const id: number = result.rows[0].id;
    expect(await updateChatLogFeedback(env, id, 'good', { shareSlug: 'mixed-old-link' })).toEqual({ forbidden: true });
    expect(await updateChatLogFeedback(env, id, 'good', { userId: 'owner' })).toMatchObject({ id, feedback: 'good' });
  });
  it('rejects new share links and invitations, including legacy mixed courses, while allowing revocation', async () => {
    const now = new Date();
    for (const id of [10,20]) {
      expect(await setShareSlug(env, id, 'owner', 'new-link-'+id)).toEqual({ notFound: true });
      expect(await createPendingCourseInvitations(env, id, 'owner', [{ email: 'new@example.test', tokenHash: 'd'.repeat(64),
        createdAt: now, expiresAt: new Date(now.getTime()+86400000) }])).toEqual({ notFound: true });
      expect(await clearShareSlug(env, id, 'owner')).toEqual({ ok: true });
    }
    expect(await revokePendingCourseInvitation(env, 10, 400, 'owner', now)).toEqual({ ok: true });
    expect((await pool.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n).toBe(0);
  });
  it('denies old invitation previews, acceptance replays, resend and queued delivery before contacting mail', async () => {
    expect(await getCourseInvitationByTokenHash(env, pending)).toBeNull();
    expect(await getCourseInvitationByTokenHash(env, accepted)).toBeNull();
    expect(await acceptCourseInvitation(env, pending, 'candidate', new Date())).toEqual({ notFound: true });
    expect(await acceptCourseInvitation(env, accepted, 'member', new Date())).toEqual({ notFound: true });
    expect(await rotatePendingCourseInvitation(env, 10, 400, 'owner', 'd'.repeat(64), new Date(Date.now()+86400000), new Date())).toEqual({ notFound: true });
    const task = await pool.query(`INSERT INTO external_tasks(kind,payload,dedupe_key,attempts,locked_at)
      VALUES('invitation_email','{}','old-invitation',1,now()) RETURNING id::int`);
    const send = vi.spyOn(mail, 'sendMail').mockResolvedValue();
    expect(await deliverInvitationEmail(env, 400, { id: task.rows[0].id, attempt: 1 })).toEqual({ skipped: true, reason: 'notFound' });
    expect(send).not.toHaveBeenCalled();
    expect(await getCourseInvitationByTokenHash(env, native)).toMatchObject({ course_id: 30 });
    expect(await acceptCourseInvitation(env, native, 'candidate', new Date())).toEqual({ ok: true, courseId: 30 });
  });
  it('preserves Moodle-owned course lifecycle and prevents native fan-out of its videos', async () => {
    expect(await updateCourse(env, 10, 'owner', { name: 'Outside rename' })).toEqual({ notFound: true });
    expect(await deleteCourse(env, 10, 'owner')).toEqual({ notFound: true });
    expect(await reorderVideos(env, 10, 'owner', [100])).toEqual({ notFound: true });
    expect(await addVideoToCourse(env, 10, 101, 'owner')).toEqual({ notFound: 'Course not found' });
    expect(await removeVideoFromCourse(env, 10, 100, 'owner')).toEqual({ notFound: 'Course not found' });
    expect(await addVideoToCourse(env, 30, 100, 'owner')).toEqual({ notFound: 'Video not found' });
    expect(await addVideosBulk(env, 30, [101,100], 'owner')).toEqual({ notFound: 'Some videos not found' });
    expect((await pool.query('SELECT video_id::int FROM video_course_members WHERE course_id=30')).rows).toEqual([{ video_id: 101 }]);
  });
  it('does not reopen stored answers, model memory or Q&A after source detachment or installation removal', async () => {
    expect(await removeVideoFromCourse(env, 20, 100, 'owner')).toEqual({ ok: true });
    await pool.query("DELETE FROM lms_installations WHERE id='platform'");
    expect((await pool.query('SELECT managed_by_lms FROM videos WHERE id=100')).rows[0].managed_by_lms).toBe(true);
    expect(await getCourseDetailByShareSlug(env, 'mixed-old-link', read)).toBeNull();
    expect(await getCourseWithMembers(env, { courseId: 20, userId: 'member' })).toBeNull();
    for (const id of [10,20]) {
      await expect(listQuestions(env, 'member', qaInputSchemas['qa.list'].parse({ courseId: id }))).rejects.toMatchObject({ status: 404 });
      await expect(listQuestions(env, null, qaInputSchemas['qa.list'].parse({ courseId: id, shareSlug: id===10?'moodle-old-link':'mixed-old-link' }))).rejects.toMatchObject({ status: 404 });
      expect(await listQuestions(env, 'owner', qaInputSchemas['qa.list'].parse({ courseId: id }))).toMatchObject({ items: [] });
    }
    // The old mixed course is still independently owned, not a phantom LMS course.
    expect(await deleteCourse(env, 20, 'owner')).toEqual({ ok: true });
  });
});
