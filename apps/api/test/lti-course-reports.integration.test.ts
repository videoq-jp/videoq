import pg from 'pg';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { withDb } from '../src/db/pool';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { createChatLogWithDb } from '../src/repositories/chat-repository';
import { resolvedLtiConfig } from '../src/features/lti/registrations';
import { courseReport, type CourseReportScope } from '../src/features/lti/course-reports';
import { mountLtiReports } from '../src/features/lti/report-routes';
import { coursePermissionsSchema } from '../src/features/lti/course-permissions';
import { sessionRecord } from '../src/features/lti/protocol';
import { privacySubject, type PrivacyInstallation } from '../src/features/lms/privacy-data';
import { executePrivacyRequest } from '../src/features/lms/privacy-routes';
import { pruneLtiAudit } from '../src/features/lti/audit-retention';
import type { Bindings } from '../src/types/bindings';
import type { AppEnv } from '../src/types/bindings';

const url = process.env.QUOTA_TEST_DATABASE_URL;
const period = { action: 'summary' as const, from: '2026-11-01', to: '2026-11-02' };
const installation: PrivacyInstallation = { id: 'school', ownerUserId: 'owner', issuer: 'https://lms.example', clientId: 'client', deploymentId: '2' };
(url ? describe : describe.skip)('Moodle capability-scoped aggregate reports on PostgreSQL', () => {
  const database = 'videoq_reports_' + crypto.randomUUID().replaceAll('-', '');
  const config = { toolOrigin: 'https://videoq.example', databaseRegistrations: true, registrations: [], privacyEnabled: true, auditRetentionDays: 30 };
  let admin: pg.Pool, pool: pg.Pool, env: Bindings, scope: CourseReportScope, subjectKey: string;
  let ids: number[], logIds: number[];
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url!); connection.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: connection.toString(), max: 5 }); pool.on('error', () => {});
    env = { DATABASE_POOL: pool, LTI_CONFIG: JSON.stringify(config) } as Bindings;
    const client = await pool.connect(); try { await migrateDatabase(client); } finally { client.release(); }
  }, 60000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE users,external_tasks,lti_credentials CASCADE;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','owner','owner@example.invalid',false,0,0,0,1,2);
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
      VALUES('school','owner','Moodle','https://lms.example','client','2','https://lms.example/auth','https://lms.example/keys','${'a'.repeat(64)}');`);
    const resources = [];
    for (const name of ['first', 'second']) resources.push(await syncLmsResource(env, installation, name,
      { contextId: 'course', resourceLinkId: name, generation: 1, enabled: true, title: name,
        file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: (name === 'first' ? 'a' : 'c').repeat(40) } }));
    ids = resources.map(row => row.videoId!);
    await pool.query("UPDATE videos SET status='completed'");
    const subject = await privacySubject(installation, '11'); subjectKey = subject.subjectKey;
    const sessionProof = { sessionHash: 'b'.repeat(64), registrationId: subject.registrationId, subjectHash: subject.subjectHash };
    scope = { installationId: 'school', ownerUserId: 'owner', contextId: 'course', courseId: resources[0].courseId!, sessionProof,
      readable: ids.map((videoId, index) => ({ videoId, generation: 1, resourceLinkId: ['first', 'second'][index] })) };
    await pool.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES($1,'session',$2,now()+interval '1 hour')`,
      [sessionProof.sessionHash, JSON.stringify({ ...sessionProof, contextId: scope.contextId, courseId: scope.courseId })]);
    logIds = [];
  });
  afterAll(async () => { await pool?.end(); try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); } finally { await admin?.end(); } });
  async function log(resources = ids, at = '2026-11-01T12:00:00Z', feedback: 'good' | 'bad' | null = null, verified = true) {
    const row = await withDb(env, db => createChatLogWithDb(db, { userId: 'owner', courseId: scope.courseId,
      question: 'PRIVATE question and learner details', answer: { segments: [{ text: 'PRIVATE answer', sourceIds: [] }], sources: [] },
      isShared: true, retrievedContexts: ['PRIVATE context'], ltiSubject: { subjectKey, resourceVideoIds: resources,
        ...(verified ? { sessionProof: scope.sessionProof } : {}) } }));
    logIds.push(row.id); await pool.query('UPDATE chat_logs SET created_at=$1,feedback=$2 WHERE id=$3', [at, feedback, row.id]); return row.id;
  }
  const report = (override: Partial<CourseReportScope> = {}) => courseReport(env, { ...scope, ...override }, period);
  const audits = async () => (await pool.query('SELECT * FROM lti_report_accesses')).rows;
  it('persists namespace from the verified stored session and exposes only bounded UTC aggregates', async () => {
    await log([ids[0]], '2026-11-01T00:00:00Z', 'good');
    await log([ids[1]], '2026-11-02T23:59:59.999Z', 'bad');
    await log(ids, '2026-11-01T12:00:00Z');
    await log(ids, '2026-10-31T23:59:59.999Z'); await log(ids, '2026-11-03T00:00:00Z');
    expect((await pool.query('SELECT registration_id,context_id FROM lti_chat_log_subjects')).rows)
      .toEqual(Array(5).fill({ registration_id: 'db:school', context_id: 'course' }));
    const result = await report();
    expect(result).toEqual({ period: { from: period.from, to: period.to, timezone: 'UTC' },
      totals: { questions: 3, good: 1, bad: 1, none: 1 }, days: [
        { date: '2026-11-01', questions: 2, good: 1, bad: 0, none: 1 },
        { date: '2026-11-02', questions: 1, good: 0, bad: 1, none: 0 }], coverage: 'verified-moodle-resource-scope' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|owner|subject|actor|resourceVideoIds|registrationId|contextId|logId/);
    expect((await audits())[0]).toMatchObject({ installation_id: 'school', context_id: 'course', actor_key: subjectKey, resource_count: 2 });
    expect(JSON.stringify(await audits())).not.toMatch(/PRIVATE/);
  });
  it('excludes unverified/legacy, other-installation and other-context records without inferring provenance', async () => {
    await log(); await log(ids, undefined, null, false);
    const foreign = await log(), context = await log();
    await pool.query("UPDATE lti_chat_log_subjects SET registration_id='db:another' WHERE chat_log_id=$1", [foreign]);
    await pool.query("UPDATE lti_chat_log_subjects SET context_id='another' WHERE chat_log_id=$1", [context]);
    expect((await report()).totals.questions).toBe(1);
    expect((await pool.query('SELECT registration_id,context_id FROM lti_chat_log_subjects WHERE chat_log_id=$1', [logIds[1]])).rows[0])
      .toEqual({ registration_id: null, context_id: null });
  });
  it('requires the entire original scope and every citation to remain readable', async () => {
    await log([ids[0]]); await log([ids[1]]); await log(ids);
    const stray = await log([ids[0]]);
    await pool.query('UPDATE chat_logs SET response=$1 WHERE id=$2', [JSON.stringify({ sources: [{ video_id: ids[1] }] }), stray]);
    const result = await report({ readable: scope.readable.slice(0, 1) });
    expect(result.totals.questions).toBe(1); expect((await audits())[0].resource_count).toBe(1);
    expect((await report({ readable: [] })).totals.questions).toBe(0);
  });
  it.each(['membership', 'disabled', 'generation', 'processing'])('rechecks current %s after Moodle authorization', async change => {
    await log([ids[0]]); await log([ids[1]]);
    if (change === 'membership') await pool.query('DELETE FROM video_course_members WHERE course_id=$1 AND video_id=$2', [scope.courseId, ids[0]]);
    if (change === 'disabled') await pool.query('UPDATE lms_resources SET enabled=false WHERE video_id=$1', [ids[0]]);
    if (change === 'generation') await pool.query('UPDATE lms_resources SET generation=2 WHERE video_id=$1', [ids[0]]);
    if (change === 'processing') await pool.query("UPDATE videos SET status='indexing' WHERE id=$1", [ids[0]]);
    expect((await report()).totals.questions).toBe(1);
  });
  it.each(['expired', 'wrong-context', 'wrong-course', 'wrong-registration'])('rejects %s stored sessions before auditing', async change => {
    if (change === 'expired') await pool.query("UPDATE lti_credentials SET expires_at=now()-interval '1 second'");
    else await pool.query('UPDATE lti_credentials SET payload=payload||$1::jsonb', [JSON.stringify({
      [change === 'wrong-context' ? 'contextId' : change === 'wrong-course' ? 'courseId' : 'registrationId']: 'another' })]);
    await expect(report()).rejects.toMatchObject({ status: 403 }); expect(await audits()).toEqual([]);
  });
  it('fails closed if the audit insert fails', async () => {
    await log();
    await pool.query(`CREATE FUNCTION report_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_report_audit BEFORE INSERT ON lti_report_accesses FOR EACH ROW EXECUTE FUNCTION report_audit_failure()`);
    try { await expect(report()).rejects.toThrow('Synthetic audit failure'); expect(await audits()).toEqual([]); }
    finally { await pool.query('DROP TRIGGER reject_report_audit ON lti_report_accesses; DROP FUNCTION report_audit_failure()'); }
  });
  it('exports/erases access receipts for the approved actor/context and retains other actors and shared course content', async () => {
    await log(); await report();
    await pool.query(`INSERT INTO lti_report_accesses(installation_id,course_id,context_id,actor_key,from_date,to_date,resource_count,scope_hash)
      SELECT installation_id,course_id,context_id,$1,from_date,to_date,resource_count,scope_hash FROM lti_report_accesses`, ['c'.repeat(64)]);
    const part = await executePrivacyRequest(env, installation, { action: 'export', subject: '11', contexts: ['course'], collection: 'report_accesses' });
    expect(part).toHaveProperty('part.chunk');
    const json = JSON.parse((part as { part: { chunk: string } }).part.chunk);
    expect(json).toMatchObject({ from: period.from, to: period.to, resourceCount: 2 }); expect(JSON.stringify(json)).not.toMatch(/PRIVATE|actor_key/);
    await executePrivacyRequest(env, installation, { action: 'erase', subject: '11', contexts: ['course'] });
    expect((await audits()).map(row => row.actor_key)).toEqual(['c'.repeat(64)]);
    expect((await pool.query('SELECT count(*)::int n FROM videos')).rows[0].n).toBe(2);
    await expect(report()).rejects.toMatchObject({ status: 403 });
  });
  it('prunes expired report audit metadata without deleting answer provenance or boundary/new receipts', async () => {
    await log(); await report(); await report();
    const rows = await audits(), now = new Date('2026-12-01T00:00:00Z'), cutoff = new Date('2026-11-01T00:00:00Z');
    await pool.query('UPDATE lti_report_accesses SET created_at=$1 WHERE id=$2', [new Date(cutoff.getTime() - 1), rows[0].id]);
    await pool.query('UPDATE lti_report_accesses SET created_at=$1 WHERE id=$2', [cutoff, rows[1].id]);
    expect(await pruneLtiAudit(env, now)).toMatchObject({ reportAccesses: 1, backlog: false });
    expect(await audits()).toHaveLength(1); expect((await pool.query('SELECT count(*)::int n FROM lti_chat_log_subjects')).rows[0].n).toBe(1);
  });
  it('requires the fresh dedicated capability, rejects browser-selected scopes and clears access on the next request', async () => {
    await log(); let permission: boolean | undefined = true;
    const app = new Hono<AppEnv>();
    mountLtiReports(app, async () => ({ sessionHash: scope.sessionProof.sessionHash,
      reg: (await resolvedLtiConfig(env))!.registrations[0], course: { userId: 'owner', memberVideoIds: ids },
      grant: sessionRecord.parse({ ...scope.sessionProof, registrationHash: 'registration', deploymentId: '2', contextId: 'course',
        resourceLinkId: 'first', courseId: scope.courseId, roles: ['Instructor'] }),
      current: { permissions: coursePermissionsSchema.parse({ viewReports: permission }), videos: ids.map((videoId, i) => ({ videoId, title: 'Lesson', lesson: ['first', 'second'][i] })) } }));
    const call = (body: unknown) => app.request('/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    expect((await call(period)).status).toBe(200);
    permission = false; expect((await call(period)).status).toBe(403);
    permission = undefined; expect((await call(period)).status).toBe(403);
    permission = true;
    for (const body of [{ ...period, courseId: scope.courseId }, { ...period, videoId: ids[0] }, { ...period, from: '2026-02-30' },
      { ...period, from: '0000-01-01' }, { ...period, from: '2024-01-01', to: '2026-11-02' }, { ...period, from: '2026-11-03' }])
      expect((await call(body)).status).toBe(400);
    expect((await call({ ...period, excess: 'x'.repeat(9000) })).status).toBe(413);
    expect(await audits()).toHaveLength(1);
  });
});
