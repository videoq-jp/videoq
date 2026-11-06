import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { plainChatAnswer } from '@videoq/trpc/chat';
import { lockConversationTestRoles } from './helpers/conversation-role-lock';
import { migrateDatabase } from '../scripts/migrate-database';
import { setupConversationCheckpoints } from '../scripts/migrations/conversation/setup';
import { syncLmsResource } from '../src/repositories/lms-resource-repository';
import { executePrivacyRequest, verifyPrivacyAssertion, moodlePrivacyRoutes } from '../src/features/lms/privacy-routes';
import { privacyCollections, privacyRequest, privacySubject, type PrivacyInstallation } from '../src/features/lms/privacy-data';
import { digest, putLtiFeedback } from '../src/features/lti/store';
import { courseTags } from '../src/features/lti/course-tags';
import { appendCourseHistory } from '../src/features/lti/history';
import { lockLtiDataSession } from '../src/features/lti/data-lock';
import { withDb } from '../src/db/pool';
import { createChatLogWithDb } from '../src/repositories/chat-repository';
import type { Bindings } from '../src/types/bindings';

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('Moodle approved external privacy on PostgreSQL', () => {
  const database = 'videoq_privacy_' + crypto.randomUUID().replaceAll('-', '');
  const installation: PrivacyInstallation = { id: 'school', ownerUserId: 'owner', issuer: 'https://lms.example', clientId: 'client', deploymentId: '2' };
  let admin: pg.Pool, pool: pg.Pool, env: Bindings;
  let releaseRoleLock: (() => Promise<void>) | undefined;
  let resource: Awaited<ReturnType<typeof syncLmsResource>>, second: typeof resource;
  let own: Awaited<ReturnType<typeof privacySubject>>, peer: typeof own, question: string, ownLog: number;
  const sessionHash = 'a'.repeat(64), peerSession = 'b'.repeat(64), otherSession = 'd'.repeat(64);
  const proof = () => ({ sessionHash, registrationId: own.registrationId, subjectHash: own.subjectHash });
  const run = (request: unknown) => executePrivacyRequest(env, installation, privacyRequest.parse(request)) as Promise<{ contexts: string[]; subjects: string[]; part: { id: string; chunk: string; revision: string } | null; next: { record?: { id: string; offset: number; revision: string }; after?: string } | null }>;
  beforeAll(async () => {
    releaseRoleLock = await lockConversationTestRoles(databaseUrl!);
    admin = new pg.Pool({ connectionString: databaseUrl }); admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6 }); pool.on('error', () => {});
    env = { DATABASE_POOL: pool, LTI_CONFIG: JSON.stringify({ toolOrigin: 'https://tool.example', databaseRegistrations: true, privacyEnabled: true, registrations: [] }) } as Bindings;
    const client = await pool.connect(); try { await migrateDatabase(client); } finally { client.release(); }
    await setupConversationCheckpoints(pool);
  }, 60000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE users, external_tasks, lti_credentials CASCADE;
      INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','owner','owner@example.test',false,0,0,0,1,2);
      INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash)
      VALUES('school','owner','Moodle','https://lms.example','client','2','https://lms.example/auth','https://lms.example/keys','${'c'.repeat(64)}');`);
    const sync = (contextId: string) => syncLmsResource(env, installation, contextId, { contextId, resourceLinkId: contextId,
      generation: 1, enabled: true, title: 'Shared lesson', file: { filename: 'lesson.mp4', contentType: 'video/mp4', size: 10, contentHash: 'a'.repeat(40) } });
    resource = await sync('2'); second = await sync('3');
    own = await privacySubject(installation, '11'); peer = await privacySubject(installation, '22');
    for (const [id, subject, contextId] of [[sessionHash, own, '2'], [peerSession, peer, '2'], [otherSession, own, '3']] as const) {
      await pool.query("INSERT INTO lti_credentials VALUES($1,'session',$2,now()+interval '1 hour')", [id, JSON.stringify({ registrationId: subject.registrationId, subjectHash: subject.subjectHash, contextId, registrationHash: 'r', deploymentId: '2', resourceLinkId: contextId,
        courseId: contextId === '2' ? resource.courseId : second.courseId, roles: [] })]);
    }
    for (const [subject, course, thread] of [[own, resource.courseId!, 'own'], [peer, resource.courseId!, 'peer'], [own, second.courseId!, 'other']] as const) {
      const result = await pool.query(`INSERT INTO chat_logs(user_id,course_id,question,response,retrieved_contexts,is_shared_origin,created_at)
        VALUES('owner',$1,$2,$3,'["own retrieved evidence"]',true,now()) RETURNING id`, [course, thread + ' private question', JSON.stringify(plainChatAnswer('answer'))]);
      const log = Number(result.rows[0].id); if (thread === 'own') ownLog = log;
      await pool.query("INSERT INTO lti_chat_log_subjects VALUES($1,$2,'[]')", [log, subject.subjectKey]);
      await pool.query("INSERT INTO chat_log_evaluations(chat_log_id,status,error_message,created_at) VALUES($1,'pending','',now())", [log]);
      await pool.query(`INSERT INTO chat_conversations(thread_id,owner_user_id,course_id,expires_at,title)
        VALUES($1,'owner',$2,now()+interval '1 day',$1)`, [thread, course]);
      await pool.query("INSERT INTO lti_conversation_scopes VALUES($1,$2,'[]')", [thread, subject.subjectKey]);
      await pool.query("INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response,chat_log_id) VALUES($1,'checkpoint',$1,$2,$3)", [thread, JSON.stringify(plainChatAnswer('answer')), log]);
      await pool.query("INSERT INTO chat_memory.checkpoints(thread_id,checkpoint_id,checkpoint) VALUES($1,'checkpoint','{\"messages\":[\"own memory\"]}')", [thread]);
      await pool.query("INSERT INTO chat_memory.checkpoint_blobs(thread_id,channel,version,type,blob) VALUES($1,'messages','v1','json',$2)", [thread, Buffer.from('own model messages')]);
      await pool.query("INSERT INTO chat_memory.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) VALUES($1,'checkpoint','task',0,'messages','json',$2)", [thread, Buffer.from('own pending model writes')]);
      const qa = await digest(JSON.stringify(['lti-course-qa-v1', subject.registrationId, subject.subjectHash, course]));
      const q = await pool.query("INSERT INTO course_questions(course_id,title,body,lti_author_id) VALUES($1,$2::text,$2::text,$3) RETURNING id", [course, thread + ' published question', qa]);
      if (thread === 'own') question = q.rows[0].id;
      await pool.query("INSERT INTO course_question_replies(question_id,body,lti_author_id) VALUES($1,$2,$3)", [q.rows[0].id, thread + ' reply', qa]);
      await pool.query('INSERT INTO course_question_lti_votes(question_id,lti_author_id) VALUES($1,$2)', [q.rows[0].id, qa]);
      await pool.query("INSERT INTO course_qa_moderation(course_id,question_id,lti_actor_id,action) VALUES($1,$2,$3,'feature')", [course, q.rows[0].id, qa]);
      await pool.query("INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash) VALUES(gen_random_uuid(),$1,$2,'create',$3)", [course, subject.subjectKey, 'e'.repeat(64)]);
    }
    const peerQa = await digest(JSON.stringify(['lti-course-qa-v1', peer.registrationId, peer.subjectHash, resource.courseId!]));
    await pool.query("INSERT INTO course_question_replies(question_id,body,lti_author_id) VALUES($1,'peer reply must survive',$2)", [question, peerQa]);
    await pool.query("INSERT INTO course_question_lti_votes(question_id,lti_author_id) VALUES($1,$2)", [question, peerQa]);
    const source = (await pool.query('SELECT id FROM lms_resources WHERE video_id=$1', [resource.videoId])).rows[0].id;
    await pool.query(`INSERT INTO lti_material_operations(id,resource_id,video_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision)
      VALUES(gen_random_uuid(),$1,$2,$3,1,$4,'update',$5,$5,$5)`, [source, resource.videoId, resource.courseId, own.subjectKey, 'e'.repeat(64)]);
    await pool.query("INSERT INTO lti_credentials VALUES($1,'lti-feedback',$2,now()+interval '1 hour')", ['f'.repeat(64), JSON.stringify({ sessionHash: 'already-pruned-session', logId: ownLog })]);
    await appendCourseHistory(env, { ...own, courseId: resource.courseId!, contextId: '2', sessionProof: proof() }, 'recent private question', ownLog, []);
    await pool.query("UPDATE videos SET status='completed'");
  });
  afterAll(async () => { await pool?.end(); try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); } finally { try { await admin?.end(); } finally { await releaseRoleLock?.(); } } });

  it('finds former-user contexts and exports all collections without peer content or authentication keys', async () => {
    expect((await run({ action: 'contexts', subject: '11' })).contexts).toEqual(['2', '3']);
    expect((await run({ action: 'users', subjects: ['11', '22', '33'], contexts: ['2'] })).subjects).toEqual(['11', '22']);
    expect((await run({ action: 'contexts', subject: '33' })).contexts).toEqual([]);
    const exports: Record<string, string> = {};
    for (const collection of privacyCollections) {
      const response = await run({ action: 'export', subject: '11', contexts: ['2'], collection });
      expect(response.part, collection).not.toBeNull();
      exports[collection] = JSON.stringify(response.part);
    }
    expect(JSON.stringify(exports)).not.toMatch(/peer private|peer reply|other private|client|subjectHash|sessionHash|owner@example/);
    expect(exports.checkpoint_blobs).toContain(Buffer.from('own model messages').toString('base64'));
  });
  it('erases only the approved subject/course and preserves peer replies, votes and shared material', async () => {
    await run({ action: 'erase', subject: '11', contexts: ['2'] });
    expect((await run({ action: 'contexts', subject: '11' })).contexts).toEqual(['3']);
    expect((await pool.query('SELECT thread_id FROM chat_memory.checkpoints ORDER BY thread_id')).rows).toEqual([{ thread_id: 'other' }, { thread_id: 'peer' }]);
    for (const table of ['checkpoint_blobs', 'checkpoint_writes']) expect((await pool.query(`SELECT thread_id FROM chat_memory.${table} ORDER BY thread_id`)).rows).toEqual([{ thread_id: 'other' }, { thread_id: 'peer' }]);
    expect((await pool.query('SELECT title,body,lti_author_id FROM course_questions WHERE id=$1', [question])).rows[0]).toEqual({ title: '[deleted]', body: '[deleted]', lti_author_id: '0'.repeat(64) });
    expect((await pool.query('SELECT body FROM course_question_replies WHERE question_id=$1 ORDER BY body', [question])).rows.map(row => row.body)).toEqual(['[deleted]', 'peer reply must survive']);
    expect((await pool.query('SELECT count(*)::int n FROM course_question_lti_votes WHERE question_id=$1', [question])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT id FROM lti_credentials WHERE id=ANY($1)', [[sessionHash, 'f'.repeat(64)]])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM lti_credentials WHERE id=ANY($1)', [[peerSession, otherSession]])).rowCount).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM videos')).rows[0].n).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM lti_material_operations')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM lti_course_tag_operations')).rows[0].n).toBe(2);
    expect((await pool.query('SELECT lti_actor_id FROM course_qa_moderation WHERE question_id=$1', [question])).rows[0].lti_actor_id).toBeNull();
    expect(await run({ action: 'erase', subject: '11', contexts: ['2'] })).toHaveProperty('erased');
  });
  it('exports long Unicode without truncation and rejects a changed record between fragments', async () => {
    const text = '漢字😀'.repeat(30000);
    await pool.query('UPDATE chat_logs SET question=$1 WHERE id=$2', [text, ownLog]);
    const request = { action: 'export', subject: '11', contexts: ['2'], collection: 'logs' };
    let response = await run(request), combined = '';
    const first = response;
    while (response.part) {
      combined += response.part.chunk;
      if (!response.next?.record) break;
      response = await run({ ...request, cursor: response.next });
    }
    expect(JSON.parse(combined).question).toBe(text);
    expect(await digest(combined)).toBe(first.part!.revision);
    expect([...first.part!.chunk]).toHaveLength(65536);
    await pool.query("UPDATE chat_logs SET question=question||'changed' WHERE id=$1", [ownLog]);
    await expect(run({ ...request, cursor: first.next })).rejects.toMatchObject({ status: 409 });
    expect((await run({ ...request, contexts: ['3'] })).part!.chunk).not.toContain('own private');
  });
  it('handles residual contexts and permits recovery for inactive, over-quota installations', async () => {
    await pool.query("UPDATE lms_installations SET active=false; UPDATE users SET is_over_quota=true; DELETE FROM lms_courses WHERE context_id='2'");
    expect((await run({ action: 'contexts', subject: '11' })).contexts).toEqual(['3', '@orphan', '2'].sort());
    await run({ action: 'erase', subject: '11', contexts: ['@orphan', '2'] });
    expect((await run({ action: 'contexts', subject: '11' })).contexts).toEqual(['3']);
  });
  it('pages every external context in a stable byte order without dropping records', async () => {
    await pool.query(`WITH courses AS(
      INSERT INTO video_courses(user_id,name,description,created_at,updated_at,display_order)
      SELECT 'owner','Page '||n,'',now(),now(),n FROM generate_series(1000,1104) n RETURNING id,name)
      INSERT INTO lms_courses(id,installation_id,context_id,course_id)
      SELECT gen_random_uuid(),'school',substring(name FROM 6),id FROM courses`);
    await pool.query(`INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash)
      SELECT gen_random_uuid(),course_id,$1,'create',$2 FROM lms_courses WHERE context_id>='1000' AND length(context_id)=4`, [own.subjectKey, 'e'.repeat(64)]);
    for (const action of ['catalog', 'contexts']) {
      let after = '', found: string[] = [];
      do {
        const response = await run({ action, ...(action === 'contexts' ? { subject: '11' } : {}), after });
        found = [...found, ...response.contexts];
        after = (response as unknown as { nextAfter: string | null }).nextAfter ?? '';
      } while (after);
      expect(found).toEqual([...new Set(found)].sort());
      expect(found).toHaveLength(action === 'catalog' ? 108 : 107);
      expect(found).toContain('1104');
    }
  });
  it('rejects old history attribution during rollout instead of guessing its subject', async () => {
    await pool.query("INSERT INTO lti_credentials VALUES('old-cache','lti-history','{}',now()+interval '1 hour')");
    await expect(run({ action: 'erase', subject: '11', contexts: ['2'] })).rejects.toMatchObject({ code: 'PRIVACY_UPGRADE_PENDING' });
    expect((await pool.query('SELECT id FROM chat_logs WHERE id=$1', [ownLog])).rowCount).toBe(1);
  });
  it('requires the registered platform signature, purpose, audience, lifetime and single-use nonce', async () => {
    const pair = await generateKeyPair('RS256'), wrong = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(pair.publicKey), kid: 'platform', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] }), now = Math.floor(Date.now() / 1000);
    const claims = { iss: installation.issuer, sub: installation.clientId, aud: 'https://tool.example/api/lms/privacy',
      deploymentId: '2', iat: now, exp: now + 60, jti: crypto.randomUUID(), version: 1, request: { action: 'contexts', subject: '11' } };
    const sign = (patch = {}, typ = 'videoq-privacy+jwt', key = pair.privateKey) => new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'platform', typ }).sign(key);
    const valid = await sign(); expect((await verifyPrivacyAssertion(env, valid, keys)).installation.id).toBe('school');
    await expect(verifyPrivacyAssertion(env, valid, keys)).rejects.toMatchObject({ status: 403 });
    for (const patch of [{ iss: 'https://unregistered.example' }, { deploymentId: '3' }, { sub: 'other' }, { aud: 'https://evil.example' },
      { exp: now + 121 }, { iat: now + 60, exp: now + 120 }, { iat: now - 200, exp: now - 140 }, { request: { action: 'erase', subject: '11', contexts: ['2'], actor: '22' } }]) {
      await expect(verifyPrivacyAssertion(env, await sign(patch), keys)).rejects.toMatchObject({ status: 403 });
    }
    await expect(verifyPrivacyAssertion(env, await sign({}, 'JWT'), keys)).rejects.toMatchObject({ status: 403 });
    await expect(verifyPrivacyAssertion(env, await sign({}, 'videoq-privacy+jwt', wrong.privateKey), keys)).rejects.toMatchObject({ status: 403 });
    const disabled = { ...env, LTI_CONFIG: env.LTI_CONFIG!.replace('"privacyEnabled":true', '"privacyEnabled":false') };
    await expect(verifyPrivacyAssertion(disabled, await sign(), keys)).rejects.toMatchObject({ status: 503 });
    const bearer = await moodlePrivacyRoutes.request('/', { method: 'POST', headers: { Authorization: 'Bearer ' + sessionHash, 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(bearer.status).toBe(403);
  });
  it('serializes erasure after an in-flight writer and refuses late data or memory recreation', async () => {
    const client = await pool.connect();
    try {
      await putLtiFeedback(env, '9'.repeat(64), sessionHash, resource.courseId!, ownLog);
      await client.query('BEGIN'); await lockLtiDataSession(client, 'owner', proof());
      const erasing = run({ action: 'erase', subject: '11', contexts: ['2'] });
      await client.query('COMMIT'); await erasing;
      await expect(putLtiFeedback(env, 'c'.repeat(64), sessionHash, resource.courseId!, ownLog)).rejects.toMatchObject({ status: 403 });
      await expect(appendCourseHistory(env, { ...own, courseId: resource.courseId!, contextId: '2', sessionProof: proof() }, 'late private question', ownLog, [])).rejects.toMatchObject({ status: 403 });
      await expect(withDb(env, db => createChatLogWithDb(db, { userId: 'owner', courseId: resource.courseId!, question: 'late log',
        answer: plainChatAnswer('answer'), retrievedContexts: [], isShared: true, ltiSubject: { subjectKey: own.subjectKey, resourceVideoIds: [], sessionProof: proof() } }))).rejects.toBeDefined();
      await expect(courseTags(env, { installationId: 'school', contextId: '2', courseId: resource.courseId!, ownerUserId: 'owner', actorKey: own.subjectKey,
        readableVideoIds: [resource.videoId!], manage: true, management: [], sessionProof: proof() }, { action: 'create', name: 'late', color: 'blue', operationId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(pool.query("INSERT INTO chat_memory.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,blob) VALUES('own','late','task',0,'messages','x')")).rejects.toMatchObject({ code: '23503' });
      expect((await run({ action: 'contexts', subject: '11' })).contexts).toEqual(['3']);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
