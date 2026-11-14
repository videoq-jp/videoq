import pg from 'pg';
import { afterAll, beforeAll, expect, it, describe } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';
import { withDb } from '../src/db/pool';
import {getCourseChatHistory, iterateCourseChatHistoryForExport} from '../src/repositories/chat-repository';
import {createChatLogWithDb} from '../src/persistence/postgres/chat-repository';
import { streamChatHistoryCsv } from '../src/shared/csv';
import type { Bindings } from '../src/types/bindings';
const url = process.env.QUOTA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Classroom question attribution and owner CSV on PostgreSQL', () => {
  const database = 'videoq_classroom_' + crypto.randomUUID().replaceAll('-', '');
  let admin: pg.Pool, pool: pg.Pool, env: Bindings, courseId: number;
  const author = { user_id: 'classroom:' + 'a'.repeat(64), username: '=生徒 A', email: 'student@school.example' };
  const proof = { sessionHash: 'b'.repeat(64), subjectHash: 'c'.repeat(64), registrationId: 'classroom:course' };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });admin.on('error', () => {});
    await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(url!);connection.pathname = '/' + database;
    pool = new pg.Pool({ connectionString: connection.toString() });pool.on('error', () => {});
    env = { DATABASE_POOL: pool } as Bindings;
    const client = await pool.connect();try { await migrateDatabase(client); } finally { client.release(); }
    await pool.query(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,storage_limit_gb,monthly_upload_limit_gb)
      VALUES('owner','Owner','owner@example.invalid',false,0,0,0,1,2),('outsider','Other','other@example.invalid',false,0,0,0,1,2)`);
    courseId = Number((await pool.query(`INSERT INTO video_courses(name,description,created_at,updated_at,user_id,display_order)
      VALUES('Classroom','',now(),now(),'owner',0) RETURNING id`)).rows[0].id);
    await pool.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES($1,'session',$2,now()+interval '1 hour')`,
      [proof.sessionHash, JSON.stringify({ ...proof, transport: 'classroom', courseId, classroomAuthor: author })]);
  }, 60000);
  afterAll(async () => { await pool?.end();try { await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); } finally { await admin?.end(); } });
  const save = (sessionProof = proof) => withDb(env, db => createChatLogWithDb(db, {
    userId: 'owner', courseId, question: '二つの動画の違いは？', answer: { segments: [{ text: '回答', sourceIds: [] }], sources: [] },
    isShared: true, retrievedContexts: [], ltiSubject: { subjectKey: 'a'.repeat(64), resourceVideoIds: [1, 2], sessionProof },
  }));
  it('saves verified attribution atomically and exports the same identity through the existing owner history and CSV', async () => {
    const saved = await save();
    expect((await pool.query('SELECT classroom_author FROM lti_chat_log_subjects WHERE chat_log_id=$1', [saved.id])).rows[0].classroom_author).toEqual(author);
    const history = await getCourseChatHistory(env, courseId, 'owner', 10, 0);
    expect('results' in history && history.results[0].asked_by).toEqual(author);
    const csv = await new Response(streamChatHistoryCsv(iterateCourseChatHistoryForExport(env, courseId, 'owner'))).text();
    expect(csv).toContain(author.user_id);expect(csv).toContain("'=生徒 A");expect(csv).toContain(author.email);expect(csv).toContain('二つの動画の違いは？');
    expect(await getCourseChatHistory(env, courseId, 'outsider', 10, 0)).toEqual({ notFound: true });
    const foreign = await new Response(streamChatHistoryCsv(iterateCourseChatHistoryForExport(env, courseId, 'outsider'))).text();
    expect(foreign).not.toContain(author.email);
    // The historical snapshot remains after OAuth/session credentials expire or are removed.
    await pool.query('DELETE FROM lti_credentials WHERE id=$1', [proof.sessionHash]);
    const retained = await getCourseChatHistory(env, courseId, 'owner', 10, 0);
    expect('results' in retained && retained.results[0].asked_by).toEqual(author);
    const count = (await pool.query('SELECT count(*) FROM chat_logs')).rows[0].count;
    await expect(save()).rejects.toThrow();
    expect((await pool.query('SELECT count(*) FROM chat_logs')).rows[0].count).toBe(count);
  });
  it('does not attribute Moodle or share-link questions to the connected owner', async () => {
    await pool.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES($1,'session',$2,now()+interval '1 hour')`,
      [proof.sessionHash, JSON.stringify({ ...proof, transport: 'native', courseId, classroomAuthor: author })]);
    const saved = await save();
    expect((await pool.query('SELECT classroom_author FROM lti_chat_log_subjects WHERE chat_log_id=$1', [saved.id])).rows[0].classroom_author).toBeNull();
    const history = await getCourseChatHistory(env, courseId, 'owner', 10, 0);
    expect('results' in history && history.results.find(row => row.id === saved.id)?.asked_by).toBeNull();
  });
  it('preserves the Moodle server-verified learner name and email in owner history and CSV', async () => {
    const moodleAuthor = { user_id: 'moodle:' + proof.subjectHash, username: '検証 生徒', email: 'learner@example.test' };
    await pool.query(`UPDATE lti_credentials SET payload=$2 WHERE id=$1`,
      [proof.sessionHash, JSON.stringify({ ...proof, transport: 'native', courseId, moodleAuthor })]);
    const saved = await save();
    const history = await getCourseChatHistory(env, courseId, 'owner', 10, 0);
    expect('results' in history && history.results.find(row => row.id === saved.id)?.asked_by).toEqual(moodleAuthor);
    const csv = await new Response(streamChatHistoryCsv(iterateCourseChatHistoryForExport(env, courseId, 'owner'))).text();
    expect(csv).toContain(moodleAuthor.username); expect(csv).toContain(moodleAuthor.email);
  });

});
