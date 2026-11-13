import { resolvedLtiConfig } from '../src/features/lti/registrations';
import { courseAccessContext } from '../src/features/lti/course-access';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { nativeLearningRoutes } from '../src/features/lms/native-routes';
import { teachingRoutes } from '../src/features/teaching/routes';
import { digest } from '../src/features/lti/store';
import type { AppEnv } from '../src/types/bindings';
import pg from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import type { Bindings } from '../src/types/bindings';
import { MaterialsClient } from '../src/features/lms/connector-client';
import { connectTeachingCourse, issueTeachingTicket, teachingConnection, type TeachingTicket } from '../src/features/teaching/service';
import { provisionLmsServiceInstallation } from '../src/repositories/lms-installation-repository';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { readAccount } from '../src/features/classroom/oauth';
import { getContext } from '../src/features/classroom/client';
import { encryptServerSecret } from '../src/lib/secret-encryption';
vi.mock('../src/features/classroom/oauth', () => ({ readAccount: vi.fn() }));
vi.mock('../src/features/classroom/client', () => ({ getContext: vi.fn() }));
const url = process.env.QUOTA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('teacher-owned courses on PostgreSQL', () => {
  const database = 'teacher_links_' + crypto.randomUUID().replaceAll('-', '');
  let admin: pg.Pool, pool: pg.Pool, env: Bindings;
  const site = { id: 'school', ownerUserId: 'installer', name: 'School', issuer: 'https://moodle.example', clientId: 'client', deploymentId: '1',
    authorizationUrl: 'https://moodle.example/mod/lti/auth.php', jwksUrl: 'https://moodle.example/mod/lti/certs.php',
    materialsService: { tokenEndpoint: 'https://moodle.example/token', endpoint: 'https://moodle.example/materials' } };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url!);connection.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: connection.toString() });pool.on('error', () => {});
    env = { DATABASE_POOL: pool, FRONTEND_URL: 'https://videoq.example', CLASSROOM_CONFIG: JSON.stringify({ toolOrigin:'https://api.example' }), CLASSROOM_CLIENT_SECRET:'fixture', CLASSROOM_CLIENT_ID: 'google-client', BETTER_AUTH_SECRET: 'teacher-connect-test-secret-0123456789', LTI_CONFIG: JSON.stringify({ toolOrigin: 'https://api.example', databaseRegistrations: true, registrations: [] }), USER_SECRET_ENCRYPTION_KEY: 'A'.repeat(43) } as Bindings;
    const client = await pool.connect();try { await migrateDatabase(client); } finally { client.release(); }
  }, 60000);
  afterAll(async () => { vi.restoreAllMocks();await pool?.end();try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); } finally { await admin?.end(); } });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query('TRUNCATE users, lti_credentials, external_tasks CASCADE');
    for (const id of ['installer','alice','bob']) await pool.query(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES($1::text,$1::text,$2,false,0,0,0,1,2)`, [id,id+'@school.example']);
    await provisionLmsServiceInstallation(env, site);
    vi.spyOn(MaterialsClient.prototype, 'access').mockImplementation(async (contextId, resourceLinkId) => ({ contextId, resourceLinkId, permissions: { manageContent: true, manageOwnHistory: true, viewTranscript: true, viewQa: true, postQa: true, voteQa: true, deleteOwnQa: true, moderateQa: true, instructorQa: true }, resources: [] }));
  });
  const input = (contextId = 'class-a', teacherSubject = 'teacher-a'): TeachingTicket => ({ provider: 'moodle', installationId: site.id,
    contextId, teacherSubject, teacherName: teacherSubject, resourceLinkId: 'entry', title: contextId, returnUrl: site.issuer + '/course/view.php?id=' + contextId });
  async function ticket(value = input()) { return new URL((await issueTeachingTicket(env, value)).url).searchParams.get('ticket')!; }
  const source = (contextId = 'class-a') => ({ contextId, resourceLinkId: 'video', title: 'Lesson', generation: 1, enabled: true,
    file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 100, contentHash: 'a'.repeat(40) } });
  async function course(owner = 'alice') {
    return Number((await pool.query(`INSERT INTO video_courses(user_id,name,description,display_order,created_at,updated_at)
      VALUES($1,'Existing course','',0,now(),now()) RETURNING id`, [owner])).rows[0].id);
  }
  it('links existing native courses without creating courses, importing Moodle videos or charging the installer', async () => {
    const aliceId = await course(), bobId = await course('bob');
    await expect(connectTeachingCourse(env, await ticket(), 'alice')).rejects.toMatchObject({ status:403 });
    await expect(connectTeachingCourse(env, await ticket(), 'bob', aliceId)).rejects.toMatchObject({ status:403 });
    await connectTeachingCourse(env, await ticket(), 'alice', aliceId);
    await connectTeachingCourse(env, await ticket(input('class-b','teacher-b')), 'bob', bobId);
    await expect(syncLmsResource(env, { id: site.id }, 'video-a', source())).rejects.toMatchObject({ code: 'TEACHER_CONNECTION_REQUIRED' });
    expect((await pool.query('SELECT count(*)::int n FROM videos')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM video_courses')).rows[0].n).toBe(2);
    expect((await pool.query('SELECT managed_by_lms,native_access_disabled FROM video_courses')).rows)
      .toEqual([{ managed_by_lms:false,native_access_disabled:false },{ managed_by_lms:false,native_access_disabled:false }]);
    const installer = (await pool.query("SELECT used_storage_bytes,used_processing_seconds,used_ai_answers FROM users WHERE id='installer'")).rows[0];
    expect(Object.values(installer).map(Number)).toEqual([0,0,0]);
    await pool.query("UPDATE users SET is_active=false WHERE id='installer'");
    expect(await teachingConnection(env,'moodle','school','class-a')).toMatchObject({ ownerUserId:'alice',courseId:aliceId,resourceLinkId:'entry' });
  });
  it('loads only the selected platform and rechecks installation revocation without a global cache', async () => {
    await provisionLmsServiceInstallation(env, { ...site, id:'other-school', issuer:'https://other.example', clientId:'other-client',
      authorizationUrl:'https://other.example/auth', jwksUrl:'https://other.example/keys',
      materialsService:{tokenEndpoint:'https://other.example/token',endpoint:'https://other.example/materials'} });
    const platform={issuer:site.issuer,clientId:site.clientId};
    expect((await resolvedLtiConfig(env,platform))?.registrations.map(reg=>reg.id)).toEqual(['db:school']);
    expect((await resolvedLtiConfig(env,{...platform,clientId:'wrong'}))?.registrations).toEqual([]);
    expect((await resolvedLtiConfig(env))?.registrations).toHaveLength(2);
    await pool.query("UPDATE lms_installations SET active=false WHERE id='school'");
    expect((await resolvedLtiConfig(env,platform))?.registrations).toEqual([]);
  });
  it('uses the current native playlist and fails closed after anchor or teacher link revocation', async () => {
    const courseId = await course();
    await connectTeachingCourse(env, await ticket(), 'alice', courseId);
    const id = Number((await pool.query(`INSERT INTO videos(user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES('alice','lesson.mp4','Linked lesson','',now(),'','completed','','upload','','') RETURNING id`)).rows[0].id);
    await pool.query('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES($1,$2,0,now())', [courseId,id]);
    vi.mocked(MaterialsClient.prototype.access).mockResolvedValue({ contextId:'class-a',resourceLinkId:'entry',resources:[],courseEntry:{generation:1},
      permissions:{manageContent:true,viewReports:true,manageOwnHistory:true,viewTranscript:true,viewQa:true,postQa:true,voteQa:true,deleteOwnQa:true,moderateQa:true,instructorQa:true} });
    const reg = (await resolvedLtiConfig(env))!.registrations[0];
    expect(reg.resources).toEqual([expect.objectContaining({ kind:'linked',courseId,resourceLinkId:'entry' })]);
    const grant = { deploymentId:'1',contextId:'class-a',resourceLinkId:'entry',courseId,serviceSubject:'student' };
    expect(await courseAccessContext(reg,grant,env)).toMatchObject({videos:[{videoId:id,title:'Linked lesson',lesson:String(id)}],permissions:{manageContent:false,viewReports:false}});
    expect((await courseAccessContext(reg,{...grant,serviceSubject:'teacher-a'},env))?.ownerHistory).toBe(true);
    expect((await courseAccessContext(reg,{...grant,serviceSubject:'co-teacher'},env))?.ownerHistory).toBe(false);
    expect((await courseAccessContext(reg,grant,env))?.ownerHistory).toBe(false);
    expect((await courseAccessContext(reg,grant,env))?.course).toEqual({id:courseId,userId:'alice',memberVideoIds:[id]});
    await pool.query("UPDATE videos SET status='processing' WHERE id=$1",[id]);
    expect((await courseAccessContext(reg,grant,env))?.course?.memberVideoIds).toEqual([]);
    await pool.query("UPDATE videos SET status='completed',user_id='bob' WHERE id=$1",[id]);
    expect((await courseAccessContext(reg,grant,env))?.videos).toEqual([]);
    await pool.query("UPDATE videos SET user_id='alice' WHERE id=$1",[id]);
    await pool.query("UPDATE users SET is_active=false WHERE id='alice'");
    await expect(courseAccessContext(reg,grant,env)).rejects.toThrow('LMS access denied');
    await pool.query("UPDATE users SET is_active=true WHERE id='alice'");
    await pool.query('DELETE FROM video_course_members WHERE course_id=$1',[courseId]);
    expect((await courseAccessContext(reg,grant,env))?.videos).toEqual([]);
    vi.mocked(MaterialsClient.prototype.access).mockResolvedValue({contextId:'class-a',resourceLinkId:'entry',resources:[]});
    await expect(courseAccessContext(reg,grant,env)).rejects.toThrow('LMS access denied');
    await pool.query('UPDATE teaching_connections SET active=false');
    expect((await resolvedLtiConfig(env))!.registrations[0].resources).toEqual([]);
    await expect(courseAccessContext(reg,grant,env)).rejects.toThrow();
  });
  it('serves playback only for current course members and rejects unenrolled users', async () => {
    const courseId = await course();
    await connectTeachingCourse(env, await ticket(), 'alice', courseId);
    const videoId = Number((await pool.query(`INSERT INTO videos(user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
      VALUES('alice','','Linked video','Lesson description',now(),'','completed','','youtube','','dQw4w9WgXcQ') RETURNING id`)).rows[0].id);
    await pool.query('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES($1,$2,0,now())',[courseId,videoId]);
    vi.mocked(MaterialsClient.prototype.access).mockResolvedValue({contextId:'class-a',resourceLinkId:'entry',resources:[],courseEntry:{generation:1}});
    await pool.query("UPDATE lms_installations SET jwks_url='https://moodle.example/playback-keys'");
    const pair = await generateKeyPair('RS256');
    vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({keys:[{...await exportJWK(pair.publicKey),kid:'playback-key'}]}));
    const app = new Hono<AppEnv>().route('/api/lms/native',nativeLearningRoutes);
    async function operation(operation: string, input: object, subject = 'student') {
      const body = JSON.stringify(input), now = Math.floor(Date.now()/1000);
      const assertion = await new SignJWT({deploymentId:'1',subject,author:{name:'Learner '+subject,email:subject+'@school.example'},contextId:'class-a',resourceLinkId:'entry',
        sessionId:'a'.repeat(64),sessionStartedAt:now-1,sessionExpiresAt:now+3599,bodySha256:await digest(body),locale:'ja',version:1})
        .setProtectedHeader({alg:'RS256',kid:'playback-key',typ:'videoq-native+jwt'}).setIssuer(site.issuer).setSubject(site.clientId)
        .setAudience('https://api.example/api/lms/native/' + operation).setIssuedAt(now).setExpirationTime(now+60).setJti(crypto.randomUUID()).sign(pair.privateKey);
      return app.request('https://api.example/api/lms/native/' + operation,{method:'POST',headers:{Authorization:'Bearer '+assertion,'Content-Type':'application/json'},body},env);
    }
    const request = (id: number) => operation('playback',{videoId:id});
    const response = await request(videoId);expect(response.status).toBe(200);
    const nativeSession = (await pool.query("SELECT payload FROM lti_credentials WHERE kind='session' AND payload->>'serviceSubject'='student'")).rows[0].payload;
    expect(nativeSession.moodleAuthor).toMatchObject({username:'Learner student',email:'student@school.example'});
    expect(nativeSession.moodleAuthor.user_id).toBe('moodle:'+nativeSession.subjectHash);
    expect(await response.json()).toMatchObject({kind:'youtube',title:'Linked video',description:'Lesson description',url:'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'});
    expect((await request(videoId+1)).status).toBe(403);
    vi.mocked(MaterialsClient.prototype.access).mockResolvedValue({contextId:'class-a',resourceLinkId:'entry',resources:[],courseEntry:{generation:1},
      permissions:{manageContent:true,viewReports:true,manageOwnHistory:true,viewTranscript:true,viewQa:true,postQa:true,voteQa:true,deleteOwnQa:true,moderateQa:true,instructorQa:true}});
    const ownerHistory = await operation('course-history',{action:'list'},'teacher-a');
    expect(ownerHistory.status).toBe(200);expect(await ownerHistory.json()).toEqual({count:0,results:[]});
    expect((await operation('course-history',{action:'list'},'co-teacher')).status).toBe(403);
    expect((await operation('course-history',{action:'list'},'student')).status).toBe(403);
    const csv = await operation('course-history',{action:'csv'},'teacher-a');
    expect(csv.status).toBe(200);expect(await csv.text()).toContain('asked_by_email');

    await pool.query('DELETE FROM video_course_members WHERE course_id=$1',[courseId]);
    expect((await request(videoId)).status).toBe(403);
    vi.mocked(MaterialsClient.prototype.access).mockRejectedValue(new Error('Not enrolled'));
    expect((await request(videoId)).status).toBe(403);
  });
  it('consumes tickets once, checks fresh teacher permissions and prevents co-teacher takeover', async () => {
    const code = await ticket();const id = await course();await connectTeachingCourse(env, code, 'alice', id);
    await expect(connectTeachingCourse(env, code, 'alice')).rejects.toThrow();
    await expect(connectTeachingCourse(env, await ticket(input('class-a','teacher-b')), 'bob')).rejects.toMatchObject({ status: 409 });
    vi.mocked(MaterialsClient.prototype.access).mockResolvedValue({ contextId:'class-b',resourceLinkId:'entry',resources:[] });
    await expect(connectTeachingCourse(env, await ticket(input('class-b')), 'bob')).rejects.toMatchObject({ status: 403 });
    expect((await pool.query('SELECT count(*)::int n FROM teaching_connections')).rows[0].n).toBe(1);
  });
  it('disables access after disconnect and never falls back to the installer', async () => {
    await connectTeachingCourse(env, await ticket(), 'alice', await course());
    await pool.query("UPDATE teaching_connections SET active=false");
    expect(await teachingConnection(env,'moodle','school','class-a')).toBeNull();
    await expect(syncLmsResource(env, { id: site.id }, 'video-a', source())).rejects.toMatchObject({ code: 'TEACHER_CONNECTION_REQUIRED' });
    expect((await pool.query('SELECT count(*)::int n FROM videos')).rows[0].n).toBe(0);
  });
  it('binds Classroom only to an owned course after rechecking the Google teacher identity', async () => {
    const courseId = Number((await pool.query(`INSERT INTO video_courses(user_id,name,description,display_order,created_at,updated_at)
      VALUES('alice','Math','',0,now(),now()) RETURNING id`)).rows[0].id);
    vi.mocked(readAccount).mockResolvedValue({ subject: 'google-alice', clientId: 'google-client', accessToken: 'access', expiresAt: Date.now()+3600000 });
    vi.mocked(getContext).mockResolvedValue({ teacherContext: {} });
    const value: TeachingTicket = { ...input(), provider:'classroom',installationId:'google-client',teacherSubject:'google-alice',
      classroomProof: { accountEnvelope: await encryptServerSecret(env, 'account-token', 'teaching-classroom'),
        launch: { courseId:'class-a',itemId:'post',itemType:'courseWork',view:'discovery',addOnToken:'addon' } } };
    await expect(connectTeachingCourse(env, await ticket(value), 'bob', courseId)).rejects.toMatchObject({ status:403 });
    await connectTeachingCourse(env, await ticket(value), 'alice', courseId);
    expect(await teachingConnection(env,'classroom','google-client','class-a')).toMatchObject({ courseId,ownerUserId:'alice' });
    vi.mocked(getContext).mockResolvedValue({ studentContext: {} });
    await expect(connectTeachingCourse(env, await ticket(value), 'alice', courseId)).rejects.toMatchObject({ status:403 });
  });
  it('accepts a signed teacher bootstrap before any course exists and rejects assertion replay', async () => {
    const pair = await generateKeyPair('RS256');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'teacher-key' }] }));
    const now = Math.floor(Date.now()/1000);
    const assertion = await new SignJWT({ deploymentId:'1',subject:'teacher-a',contextId:'class-a',resourceLinkId:'entry',
      sessionId:'a'.repeat(64),sessionStartedAt:now-1,sessionExpiresAt:now+3599,bodySha256:await digest('{}'),locale:'ja',version:1 })
      .setProtectedHeader({ alg:'RS256',kid:'teacher-key',typ:'videoq-native+jwt' }).setIssuer(site.issuer).setSubject(site.clientId)
      .setAudience('https://api.example/api/lms/native/teacher/connect').setIssuedAt(now).setExpirationTime(now+60).setJti(crypto.randomUUID()).sign(pair.privateKey);
    const app = new Hono<AppEnv>().route('/api/lms/native', nativeLearningRoutes);
    const request = () => app.request('https://api.example/api/lms/native/teacher/connect', { method:'POST',headers:{ Authorization:'Bearer '+assertion,'Content-Type':'application/json' },body:'{}' }, env);
    const response = await request();expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: expect.stringMatching(/^https:\/\/videoq.example\/teaching\/connect\?ticket=[a-f0-9]{64}$/) });
    expect((await request()).status).toBe(403);
    expect((await pool.query('SELECT count(*)::int n FROM video_courses')).rows[0].n).toBe(0);
  });
  it('requires a VideoQ browser session and approved Origin at the connection endpoints', async () => {
    const app = new Hono<AppEnv>().route('/api/teaching', teachingRoutes);
    const code = await ticket();
    const request = (origin: string, body: object) => app.request('http://localhost/api/teaching/review', { method:'POST',
      headers:{ 'X-VideoQ-Test-User-Id':'alice',Origin:origin,'Content-Type':'application/json' },body:JSON.stringify(body) }, env);
    expect((await request('https://evil.example', { ticket:code })).status).toBe(403);
    expect((await request('https://videoq.example', { ticket:'wrong' })).status).toBe(400);
    const response = await request('https://videoq.example', { ticket:code });expect(response.status).toBe(200);
    const result = await response.json();expect(result).not.toHaveProperty('classroomProof');expect(result).not.toHaveProperty('teacherSubject');
  });

});
