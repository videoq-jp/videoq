import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { courseTags, type CourseTagScope } from '../src/features/lti/course-tags';
import { manageLtiMaterial, type ManagedMaterialScope } from '../src/features/lti/material-management';
import { pruneLtiAudit } from '../src/features/lti/audit-retention';
import { operationReservationKey, reserveLtiOperation } from '../src/features/lti/operation-reservations';
import { privacySubject, type PrivacyInstallation } from '../src/features/lms/privacy-data';
import { executePrivacyRequest } from '../src/features/lms/privacy-routes';
import type { Bindings } from '../src/types/bindings';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const now = new Date('2026-11-06T00:00:00Z'), cutoff = new Date(now.getTime() - 30 * 86400000);
(databaseUrl ? describe : describe.skip)('Moodle personal audit retention and permanent replay protection', () => {
  const database = 'videoq_audit_' + crypto.randomUUID().replaceAll('-', '');
  const installation: PrivacyInstallation = { id: 'school', ownerUserId: 'owner', issuer: 'https://moodle.example', clientId: 'client', deploymentId: '2' };
  const config = { toolOrigin: 'https://videoq.example', databaseRegistrations: true, privacyEnabled: true, auditRetentionDays: 30, registrations: [] };
  let admin: pg.Pool, pool: pg.Pool, env: Bindings, scope: CourseTagScope, material: ManagedMaterialScope;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl }); admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 }); pool.on('error', () => {});
    env = { DATABASE_POOL: pool, LTI_CONFIG: JSON.stringify(config) } as Bindings;
    const client = await pool.connect(); try { await migrateDatabase(client); } finally { client.release(); }
  }, 60000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE users,external_tasks,lti_credentials,lti_operation_reservations CASCADE;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
        VALUES('owner','owner','owner@example.test',false,0,0,0,1,2);
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
        VALUES('school','owner','Moodle','https://moodle.example','client','2','https://moodle.example/auth','https://moodle.example/keys','${'a'.repeat(64)}');`);
    const resource = await syncLmsResource(env, installation, 'source', { contextId: '2', resourceLinkId: 'launch', generation: 1,
      enabled: true, title: 'Shared lesson', file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: 'a'.repeat(40) } });
    const subject = await privacySubject(installation, '11');
    scope = { installationId: 'school', contextId: '2', courseId: resource.courseId!, ownerUserId: 'owner', actorKey: subject.subjectKey,
      readableVideoIds: [resource.videoId!], manage: true, management: [{ videoId: resource.videoId!, resourceLinkId: 'launch', generation: 1 }] };
    material = { ...scope, resourceLinkId: 'launch', generation: 1, videoId: resource.videoId! };
    await pool.query("UPDATE videos SET status='completed'");
  });
  afterAll(async () => { await pool?.end(); try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); } finally { await admin?.end(); } });
  const tag = (operationId: string = crypto.randomUUID(), name = 'Shared vocabulary') => courseTags(env, scope, { action: 'create', name, color: 'blue', operationId });
  const update = async (operationId = crypto.randomUUID(), revision?: string) => manageLtiMaterial(env, material, { action: 'update',
    videoId: material.videoId, operationId, revision: revision ?? (await manageLtiMaterial(env, material, { action: 'get', videoId: material.videoId })).material.revision,
    fields: { description: 'Shared teaching description' } });
  const expire = async () => {
    for (const table of ['lti_material_operations', 'lti_course_tag_operations'])
      await pool.query(`UPDATE ${table} SET created_at=$1`, [new Date(cutoff.getTime() - 1)]);
  };

  it('requires explicit valid operator configuration and does no database work when disabled', async () => {
    expect(await pruneLtiAudit({} as Bindings, now)).toMatchObject({ enabled: false, backlog: false });
    for (const days of [0, -1, 1.5, 3651, '30']) await expect(pruneLtiAudit({ LTI_CONFIG: JSON.stringify({ ...config, auditRetentionDays: days }) } as Bindings, now)).rejects.toThrow('Invalid LTI_CONFIG');
    const unset = { ...config } as Partial<typeof config>; delete unset.auditRetentionDays;
    expect(await pruneLtiAudit({ LTI_CONFIG: JSON.stringify(unset) } as Bindings, now)).toMatchObject({ enabled: false });
  });

  it('removes expired receipt contents and only LTI moderation actors, retaining exact-boundary/new/shared data', async () => {
    const old = crypto.randomUUID(); await tag(old); await update(); await expire();
    const recent = crypto.randomUUID(); await tag(recent, 'Recent vocabulary');
    const boundary = crypto.randomUUID(); await tag(boundary, 'Boundary vocabulary');
    await pool.query('UPDATE lti_course_tag_operations SET created_at=$1 WHERE id=$2', [cutoff, boundary]);
    const q = (await pool.query("INSERT INTO course_questions(course_id,title,body,author_id) VALUES($1,'Shared question','Peer content','owner') RETURNING id", [scope.courseId])).rows[0].id;
    await pool.query("INSERT INTO course_qa_moderation(course_id,question_id,lti_actor_id,action,created_at) VALUES($1,$2,$3,'feature',$4)",
      [scope.courseId, q, scope.actorKey, new Date(cutoff.getTime() - 1)]);
    await pool.query("INSERT INTO course_qa_moderation(course_id,question_id,actor_user_id,action,created_at) VALUES($1,$2,'owner','unfeature',$3)",
      [scope.courseId, q, new Date(cutoff.getTime() - 1)]);
    expect(await pruneLtiAudit(env, now)).toEqual({ enabled: true, materialOperations: 1, tagOperations: 1, moderationActors: 1, backlog: false });
    expect((await pool.query('SELECT id FROM lti_course_tag_operations ORDER BY id')).rows.map(r => r.id).sort()).toEqual([recent, boundary].sort());
    expect((await pool.query('SELECT lti_actor_id,actor_user_id FROM course_qa_moderation ORDER BY action')).rows).toEqual([
      { lti_actor_id: null, actor_user_id: null }, { lti_actor_id: null, actor_user_id: 'owner' }]);
    expect((await pool.query('SELECT name FROM lti_course_tags')).rows).toHaveLength(3);
    expect((await pool.query('SELECT description FROM videos')).rows[0].description).toBe('Shared teaching description');
    expect((await pool.query('SELECT body FROM course_questions')).rows[0].body).toBe('Peer content');
    expect(await pruneLtiAudit(env, now)).toMatchObject({ materialOperations: 0, tagOperations: 0, moderationActors: 0, backlog: false });
  });

  it('replays recent requests and rejects retired UUIDs without repeating content changes', async () => {
    const id = crypto.randomUUID(), materialId = crypto.randomUUID(); await tag(id);
    expect((await tag(id)).reused).toBe(true);
    const result = await update(materialId);
    const receipt = (await pool.query('SELECT before_revision FROM lti_material_operations WHERE id=$1', [materialId])).rows[0];
    expect((await update(materialId, receipt.before_revision)).reused).toBe(true);
    await expire(); await pruneLtiAudit(env, now);
    await expect(tag(id)).rejects.toMatchObject({ status: 409 });
    await expect(tag(id.toUpperCase())).rejects.toMatchObject({ status: 409 });
    await expect(update(materialId, result.material.revision)).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('SELECT count(*)::int n FROM lti_course_tags')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM lti_material_operations')).rows[0].n).toBe(0);
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='lti_operation_reservations'");
    expect(columns.rows).toEqual([{ column_name: 'key' }]);
    const saved = JSON.stringify((await pool.query('SELECT * FROM lti_operation_reservations')).rows);
    expect(saved).not.toContain(id); expect(saved).not.toContain(scope.actorKey); expect(saved).not.toContain('Shared');
  });

  it('rolls back a reservation with a rejected write and permits a corrected retry', async () => {
    const id = crypto.randomUUID();
    await expect(update(id, '0'.repeat(64))).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('SELECT key FROM lti_operation_reservations WHERE key=$1', [await operationReservationKey('material', id)])).rowCount).toBe(0);
    expect((await update(id)).reused).toBe(false);
  });

  it('backfills old receipts using the actual idempotent data migration and separates operation kinds', async () => {
    const id = crypto.randomUUID(); await tag(id); await update(id);
    await pool.query('DELETE FROM lti_operation_reservations');
    const sql: string = readFileSync(new URL('../drizzle/0058_lti_operation_reservations_backfill.sql', import.meta.url), 'utf8');
    await pool.query(sql); await pool.query(sql);
    const rows = (await pool.query('SELECT key FROM lti_operation_reservations ORDER BY key')).rows.map(r => r.key);
    expect(rows).toEqual([await operationReservationKey('tag', id), await operationReservationKey('material', id)].sort());
    await expire(); await pruneLtiAudit(env, now);
    expect((await pool.query('SELECT count(*)::int n FROM lti_operation_reservations')).rows[0].n).toBe(2);
  });

  it('skips a busy reservation and reports remaining work, then completes after release', async () => {
    const id = crypto.randomUUID(); await tag(id); await expire();
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); expect(await reserveLtiOperation(client, 'tag', id)).toBe(false);
      expect(await pruneLtiAudit(env, now)).toMatchObject({ tagOperations: 0, backlog: true });
      expect((await pool.query('SELECT id FROM lti_course_tag_operations')).rows).toHaveLength(1);
      await client.query('COMMIT');
      expect(await pruneLtiAudit(env, now)).toMatchObject({ tagOperations: 1, backlog: false });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('bounds a large backlog and finishes the remaining records on the next invocation', async () => {
    await pool.query(`INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash,created_at)
      SELECT gen_random_uuid(),$1,$2,'create',$2,$3 FROM generate_series(1,10001)`, [scope.courseId, scope.actorKey, new Date(cutoff.getTime() - 1)]);
    expect(await pruneLtiAudit(env, now)).toMatchObject({ tagOperations: 10000, backlog: true });
    expect((await pool.query('SELECT count(*)::int n FROM lti_course_tag_operations')).rows[0].n).toBe(1);
    expect(await pruneLtiAudit(env, now)).toMatchObject({ tagOperations: 1, backlog: false });
    expect((await pool.query('SELECT count(*)::int n FROM lti_operation_reservations')).rows[0].n).toBe(10001);
  });

  it('rolls back a legacy replay reservation if receipt deletion fails', async () => {
    await tag(); await expire(); await pool.query('DELETE FROM lti_operation_reservations');
    await pool.query(`CREATE FUNCTION reject_audit_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit delete failure'; END $$;
      CREATE TRIGGER reject_audit_delete BEFORE DELETE ON lti_course_tag_operations FOR EACH ROW EXECUTE FUNCTION reject_audit_delete()`);
    try {
      await expect(pruneLtiAudit(env, now)).rejects.toThrow('synthetic audit delete failure');
      expect((await pool.query('SELECT count(*)::int n FROM lti_course_tag_operations')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int n FROM lti_operation_reservations')).rows[0].n).toBe(0);
    } finally { await pool.query('DROP TRIGGER reject_audit_delete ON lti_course_tag_operations; DROP FUNCTION reject_audit_delete()'); }
  });

  it('preserves replay barriers for approved individual privacy deletion and shared tags survive', async () => {
    const id = crypto.randomUUID(); await tag(id); await update();
    await executePrivacyRequest(env, installation, { action: 'erase', subject: '11', contexts: ['2'] });
    await expect(tag(id)).rejects.toMatchObject({ status: 409 });
    await expect(tag(id.toUpperCase())).rejects.toMatchObject({ status: 409 });
    expect((await pool.query('SELECT name FROM lti_course_tags')).rows).toEqual([{ name: 'Shared vocabulary' }]);
    expect((await pool.query('SELECT count(*)::int n FROM lti_operation_reservations')).rows[0].n).toBe(2);
  });
});
