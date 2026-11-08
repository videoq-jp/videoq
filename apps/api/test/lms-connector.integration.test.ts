import pg from 'pg';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { plainChatAnswer } from '@videoq/trpc/chat';
import type { AppEnv, Bindings } from '../src/types/bindings';
import { migrateDatabase } from '../scripts/migrate-database';
import { setupConversationCheckpoints } from '../scripts/migrations/conversation/setup';
import { lockConversationTestRoles } from './helpers/conversation-role-lock';
import { provisionLmsInstallation, provisionLmsServiceInstallation } from '../src/repositories/lms-installation-repository';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { lmsRoutes } from '../src/features/lms/routes';
import { privacySubject } from '../src/features/lms/privacy-data';
import { digest } from '../src/features/lti/store';
import { toolJwks } from '../src/features/lti/tool-keys';
import { MaterialsClient } from '../src/features/lms/connector-client';
import { createMemoryRateLimitBackend } from '../src/lib/rate-limit';
import { resourceManifestSchema } from '../src/features/lms/resource';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
const subject = '8f11307b-c408-4d9f-a361-7b4418af1970', peer = 'Peer/CaseSensitive';
const contextId = 'urn:course:mathematics/2026', entry = 'entry:common', activity = 'activity/opaque-id';
const connectors = ['a', 'b'].map(id => ({ id: 'connector:' + id, ownerUserId: 'owner', name: 'External connector ' + id,
  issuer: 'https://connector-' + id + '.example', clientId: 'client-' + id, deploymentId: 'tenant:' + id,
  authorizationUrl: 'https://connector-' + id + '.example/authorize', jwksUrl: 'https://connector-' + id + '.example/keys',
  materialsService: { tokenEndpoint: 'https://connector-' + id + '.example/oauth/token', endpoint: 'https://connector-' + id + '.example/context-api' } }));
const courseManifest = resourceManifestSchema.parse({ kind: 'course', contextId, resourceLinkId: entry, generation: 1, enabled: true, title: 'External course' });
const fileManifest = resourceManifestSchema.parse({ contextId, resourceLinkId: activity, generation: 1, enabled: true, title: 'External lesson',
  file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: 'a'.repeat(64) } });

(databaseUrl ? describe : describe.skip)('Independent connector contract on PostgreSQL', () => {
  const database = 'videoq_connector_' + crypto.randomUUID().replaceAll('-', '');
  let admin: pg.Pool, pool: pg.Pool, env: Bindings;
  let releaseRoleLock: (() => Promise<void>) | undefined;
  const closedConnections: Promise<void>[] = [];
  const keys: Awaited<ReturnType<typeof generateKeyPair>>[] = [];
  const publicKeys: Awaited<ReturnType<typeof exportJWK>>[] = [];
  let resources: Awaited<ReturnType<typeof syncLmsResource>>[];
  let started: number;
  let allowedReports: boolean;
  const app = new Hono<AppEnv>().route('/api/lms', lmsRoutes);

  beforeAll(async () => {
    releaseRoleLock = await lockConversationTestRoles(databaseUrl!);
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
    pool.on('connect', client => closedConnections.push(new Promise(resolve => client.once('end', resolve))));
    const client = await pool.connect(); try { await migrateDatabase(client); } finally { client.release(); }
    await setupConversationCheckpoints(pool);
    for (const _ of connectors) {
      const pair = await generateKeyPair('RS256', { extractable: true }); keys.push(pair);
      publicKeys.push({ ...await exportJWK(pair.publicKey), alg: 'RS256', kid: 'connector-key' });
    }
    const tool = await generateKeyPair('RS256', { extractable: true });
    env = { RUNTIME: 'node', DATABASE_POOL: pool, USE_S3_STORAGE: 'false',
      LTI_TOOL_KEYS: JSON.stringify({ current: await exportJWK(tool.privateKey), previous: [] }),
      LTI_CONFIG: JSON.stringify({ toolOrigin: 'https://api.example', databaseRegistrations: true, privacyEnabled: true, registrations: [] }) } as Bindings;
  }, 60000);

  beforeEach(async () => {
    started = Math.floor(Date.now() / 1000) - 5; allowedReports = true;
    env.RATE_LIMIT_BACKEND = createMemoryRateLimitBackend();
    await pool.query(`TRUNCATE users,external_tasks,lti_credentials CASCADE;
      TRUNCATE chat_memory.checkpoints,chat_memory.checkpoint_blobs,chat_memory.checkpoint_writes;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES('owner','owner','owner@example.test',false,0,0,0)`);
    resources = [];
    for (const connector of connectors) {
      const result = await provisionLmsServiceInstallation(env, connector);
      expect(result).toEqual({ installationId: connector.id, mode: 'service' });
      await syncLmsResource(env, connector, 'course:opaque', courseManifest);
      resources.push(await syncLmsResource(env, connector, 'file:opaque', fileManifest));
    }
    await pool.query("UPDATE videos SET status='completed',transcript='1\n00:00:00,000 --> 00:00:01,000\nContract lesson\n'");
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const index = connectors.findIndex(c => url.startsWith(c.issuer + '/'));
      if (index < 0 || url.includes('/local/videoq/')) throw new Error('Unexpected provider endpoint');
      const connector = connectors[index];
      if (url === connector.jwksUrl) return Response.json({ keys: [publicKeys[index]] });
      if (url === connector.materialsService.tokenEndpoint) {
        const body = init?.body;
        if (!(body instanceof URLSearchParams) && typeof body !== 'string') throw new Error('Expected an OAuth form');
        const form = new URLSearchParams(body);
        await jwtVerify(form.get('client_assertion')!, createLocalJWKSet(await toolJwks(env)), {
          algorithms: ['RS256'], issuer: connector.clientId, subject: connector.clientId, audience: url,
        });
        return Response.json({ access_token: 'controlled-token-' + index, token_type: 'Bearer', expires_in: 60,
          scope: 'https://videoq.org/spec/lti-materials/v1' });
      }
      expect(url).toBe(connector.materialsService.endpoint);
      if (typeof init?.body !== 'string') throw new Error('Expected a serialized connector request');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer controlled-token-' + index);
      const body = JSON.parse(init.body);
      if (body.action === 'manifest') return Response.json({ contextId, complete: true, resources: [
        { externalId: 'course:opaque', manifest: courseManifest }, { externalId: 'file:opaque', manifest: fileManifest },
      ] });
      expect(body.action).toBe('access');
      expect(body.contextId).toBe(contextId); expect(body.resourceLinkId).toBe(entry);
      return Response.json({ contextId, resourceLinkId: entry, courseEntry: { generation: 1 },
        permissions: { viewTranscript: true, manageOwnHistory: true, viewQa: true, postQa: true, voteQa: true,
          deleteOwnQa: true, manageContent: false, viewReports: body.subject === subject && allowedReports },
        resources: [{ externalId: 'file:opaque', resourceLinkId: activity, lesson: 'Opaque lesson / A',
          title: 'External lesson', generation: 1, management: { generation: 1 } }] });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await pool?.end(); await Promise.all(closedConnections);
    try { await admin?.query(`DROP DATABASE IF EXISTS "${database}"`); }
    finally { try { await admin?.end(); } finally { await releaseRoleLock?.(); } }
  });

  async function native(index: number, actor: string, operation: string, body: unknown = {}, signingIndex = index) {
    const connector = connectors[index], bytes = JSON.stringify(body), now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: connector.issuer, sub: connector.clientId,
      aud: 'https://api.example/api/lms/native/' + operation, deploymentId: connector.deploymentId,
      subject: actor, contextId, resourceLinkId: entry, sessionId: await digest(JSON.stringify([connector.id, actor])),
      sessionStartedAt: started, sessionExpiresAt: started + 3500, bodySha256: await digest(bytes),
      locale: 'en', version: 1, iat: now, exp: now + 60, jti: crypto.randomUUID(),
    }).setProtectedHeader({ alg: 'RS256', kid: 'connector-key', typ: 'videoq-native+jwt' }).sign(keys[signingIndex].privateKey);
    return app.request('https://api.example/api/lms/native/' + operation, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: bytes }, env);
  }
  async function privacy(index: number, request: unknown) {
    const connector = connectors[index], now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: connector.issuer, sub: connector.clientId,
      aud: 'https://api.example/api/lms/privacy', deploymentId: connector.deploymentId,
      version: 1, request, iat: now, exp: now + 60, jti: crypto.randomUUID(),
    }).setProtectedHeader({ alg: 'RS256', kid: 'connector-key', typ: 'videoq-privacy+jwt' }).sign(keys[index].privateKey);
    return app.request('https://api.example/api/lms/privacy', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assertion: token }) }, env);
  }

  it('uses non-Moodle OAuth/JWKS, opaque material IDs and SHA-256 revisions with real database bindings', async () => {
    const client = new MaterialsClient(env, connectors[0]);
    const snapshot = await client.manifest(contextId);
    for (const source of snapshot.resources) await syncLmsResource(env, connectors[0], source.externalId, source.manifest);
    const response = await native(0, subject, 'materials'); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.nativeProtocol).toBe(1); expect(body.videos).toHaveLength(1);
    expect(body.videos[0].videoId).toBe(resources[0].videoId);
    expect(body.videos[0].videoId).not.toBe(resources[1].videoId);
    expect(JSON.stringify(body)).not.toMatch(/subjectHash|sessionHash|Bearer|ownerUserId/);
    expect((await pool.query('SELECT content_hash FROM lms_resources WHERE installation_id=$1 AND external_id=$2',
      [connectors[0].id, 'file:opaque'])).rows[0].content_hash).toBe('a'.repeat(64));
  });

  it('rechecks current capabilities and never accepts one connector signature for another tenant', async () => {
    const period = { action: 'summary', from: '2026-11-01', to: '2026-11-02' };
    expect((await native(0, subject, 'reports', period)).status).toBe(200);
    allowedReports = false;
    expect((await native(0, subject, 'reports', period)).status).toBe(403);
    expect((await native(0, subject, 'management', { action: 'get', videoId: resources[0].videoId })).status).toBe(403);
    expect((await native(1, subject, 'materials', {}, 0)).status).toBe(403);
    expect((await native(1, subject, 'materials')).status).toBe(200);
  });

  it('exports and erases an opaque subject without erasing a peer or the same subject in another connector', async () => {
    expect((await native(0, subject, 'materials')).status).toBe(200);
    for (const [index, actor, thread] of [[0, subject, 'own'], [0, peer, 'peer'], [1, subject, 'other-connector']] as const) {
      const identity = await privacySubject(connectors[index], actor), course = resources[index].courseId;
      const log = await pool.query(`INSERT INTO chat_logs(user_id,course_id,question,response,retrieved_contexts,is_shared_origin,created_at)
        VALUES('owner',$1,$2,$3,'[]',true,now()) RETURNING id`, [course, thread + ' private question', JSON.stringify(plainChatAnswer('fixture answer'))]);
      await pool.query(`INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids,registration_id,context_id)
        VALUES($1,$2,$3,$4,$5)`, [log.rows[0].id, identity.subjectKey, JSON.stringify([resources[index].videoId]), identity.registrationId, contextId]);
      await pool.query(`INSERT INTO chat_conversations(thread_id,owner_user_id,course_id,expires_at,title)
        VALUES($1,'owner',$2,now()+interval '1 day',$1)`, [thread, course]);
      await pool.query("INSERT INTO lti_conversation_scopes VALUES($1,$2,$3)", [thread, identity.subjectKey, JSON.stringify([resources[index].videoId])]);
      await pool.query("INSERT INTO chat_memory.checkpoints(thread_id,checkpoint_id,checkpoint) VALUES($1,'point','{\"messages\":[\"fixture memory\"]}')", [thread]);
      await pool.query("INSERT INTO chat_memory.checkpoint_blobs(thread_id,channel,version,type,blob) VALUES($1,'messages','v1','json',$2)", [thread, Buffer.from('fixture memory')]);
      await pool.query("INSERT INTO chat_memory.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) VALUES($1,'point','task',0,'messages','json',$2)", [thread, Buffer.from('fixture write')]);
    }
    const exported = await privacy(0, { action: 'export', subject, contexts: [contextId], collection: 'logs' });
    expect(exported.status).toBe(200); const data = await exported.json();
    expect(data.part.chunk).toContain('own private question'); expect(data.part.chunk).not.toContain('other-connector private question');
    const erased = await privacy(0, { action: 'erase', subject, contexts: [contextId] }); expect(erased.status).toBe(200);
    expect((await pool.query('SELECT question FROM chat_logs ORDER BY question')).rows.map(r => r.question))
      .toEqual(['other-connector private question', 'peer private question']);
    for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
      expect((await pool.query(`SELECT DISTINCT thread_id FROM chat_memory.${table} ORDER BY thread_id`)).rows.map(r => r.thread_id))
        .toEqual(['other-connector', 'peer']);
    }
    expect((await native(0, subject, 'materials')).status).toBe(403);
    expect((await native(0, peer, 'materials')).status).toBe(200);
    expect((await native(1, subject, 'materials')).status).toBe(200);
  });

  it('accepts opaque source identities on the existing authenticated push interface', async () => {
    const legacy = await provisionLmsInstallation(env, { id: 'push-connector', ownerUserId: 'owner', name: 'Push connector',
      issuer: 'https://push.example', clientId: 'push-client', deploymentId: 'deployment:opaque',
      authorizationUrl: 'https://push.example/authorize', jwksUrl: 'https://push.example/keys' });
    const response = await app.request('https://api.example/api/lms/resources/' + encodeURIComponent('course:opaque-id'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + legacy.token },
      body: JSON.stringify(courseManifest),
    }, env);
    expect(response.status).toBe(200);
    expect((await pool.query('SELECT external_id,context_id FROM lms_resources WHERE installation_id=$1', ['push-connector'])).rows)
      .toEqual([{ external_id: 'course:opaque-id', context_id: contextId }]);
  });
});
