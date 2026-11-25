import { it, expect } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { createD1AgentSkillRepository } from '../../src/persistence/d1/agent-skill-repository';
import { skillChunks, checkedFacts } from '../../src/features/skills/core';
import { skillMaterial, extractedSkillFacts, generatedSkillDraft, skillFixtureId } from '../fixtures/agent-skill';

it('persists skill progress in D1, fences concurrent workers, and cascades account deletion', async () => {
  const { database, dispose } = await createD1Fixture();
  try {
    await database.prepare('INSERT INTO users (id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES (?, ?, ?, 0, 0, 0, 0)').bind('skill-owner', 'skill-owner', 'skill-owner@example.test').run();
    await database.prepare('INSERT INTO users (id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES (?, ?, ?, 0, 0, 0, 0)').bind('other-owner', 'other-owner', 'other-owner@example.test').run();
    for (const [id, owner] of [[7, 'skill-owner'], [8, 'other-owner']]) await database.prepare("INSERT INTO videos (id, file, title, description, uploaded_at, transcript, status, error_message, user_id, source_type, source_url, youtube_video_id) VALUES (?, '', 'Source', '', '2026-11-25', 'Private transcript', 'completed', '', ?, 'uploaded', '', '')").bind(id, owner).run();
    const repository = createD1AgentSkillRepository(database), chunks = skillChunks(skillMaterial);
    expect((await repository.sources('skill-owner', [7, 8])).map(source => source.id)).toEqual([7]);
    const state = { automatic: true, members: [{ objective: 'Implement the lab client', factIds: ['chunk-0-fact-0'], draft: generatedSkillDraft, attempts: 2, status: 'passed' as const, issues: [] }], version: 1 as const, target: { kind: 'course' as const, resourceId: 42 }, objective: 'Implement the API client lab', language: 'en' as const,
      resourceTitle: skillMaterial.title, fingerprint: 'fingerprint', stage: 'review' as const, chunks, completedChunks: 1, sourceVideos: 1,
      facts: checkedFacts(extractedSkillFacts, chunks[0], 0), draft: generatedSkillDraft, issues: [] };
    await repository.create({ id: skillFixtureId, ownerId: 'skill-owner', state });
    expect(await repository.get(skillFixtureId, 'another-owner')).toBeNull();
    expect(await repository.claim(skillFixtureId, 'skill-owner', 'first', 1000, 2000)).toBe(true);
    expect(await repository.claim(skillFixtureId, 'skill-owner', 'second', 1500, 2500)).toBe(false);
    expect(await repository.claim(skillFixtureId, 'skill-owner', 'second', 2001, 3000)).toBe(true);
    expect(await repository.save(skillFixtureId, 'skill-owner', 'first', state)).toBe(false);
    await repository.release(skillFixtureId, 'skill-owner', 'first');
    expect(await repository.claim(skillFixtureId, 'skill-owner', 'third', 2100, 3100)).toBe(false);
    expect(await repository.save(skillFixtureId, 'skill-owner', 'second', { ...state, stage: 'published' })).toBe(true);
    const saved = (await repository.get(skillFixtureId, 'skill-owner'))?.state;
    expect(saved?.stage).toBe('published');
    expect(saved?.members).toEqual(state.members); expect(saved?.automatic).toBe(true);
    await database.prepare('DELETE FROM videos WHERE user_id = ?').bind('skill-owner').run();
    await database.prepare('DELETE FROM users WHERE id = ?').bind('skill-owner').run();
    expect(await repository.get(skillFixtureId, 'skill-owner')).toBeNull();
  } finally { await dispose(); }
}, 30_000);

it('stores state larger than a D1 row across parts and preserves snapshots against stale writers', async () => {
  const { database, dispose } = await createD1Fixture();
  try {
    await database.prepare('INSERT INTO users (id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES (?, ?, ?, 0, 0, 0, 0)').bind('large-owner', 'large-owner', 'large-owner@example.test').run();
    const repository = createD1AgentSkillRepository(database);
    const text = '知恵🙂'.repeat(230_000);
    const material = { title: 'Large', sources: [{ id: 1, title: 'Large', transcript: text }] };
    const state = { version: 1 as const, target: { kind: 'course' as const, resourceId: 42 }, objective: '', automatic: true, language: 'ja' as const, resourceTitle: 'Large', fingerprint: 'large', stage: 'extracting' as const, chunks: skillChunks(material), completedChunks: 0, sourceVideos: 1, facts: [], draft: null, issues: [] };
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeGreaterThan(2_000_000);
    await repository.create({ id: skillFixtureId, ownerId: 'large-owner', state });
    const saved = await repository.get(skillFixtureId, 'large-owner');
    expect(saved?.state.chunks.flat().map(cue => cue.text).join('')).toBe(text);
    expect(await repository.get(skillFixtureId, 'another-owner')).toBeNull();
    const sizes = await database.prepare('SELECT MAX(length(CAST(content AS BLOB))) AS size, COUNT(*) AS count FROM agent_skill_state_parts').first<{ size: number; count: number }>();
    expect(sizes!.size).toBeLessThan(256_000); expect(sizes!.count).toBeGreaterThan(1);
    expect(await repository.claim(skillFixtureId, 'large-owner', 'first', 1000, 2000)).toBe(true);
    expect(await repository.save(skillFixtureId, 'large-owner', 'first', { ...state, completedChunks: 1 })).toBe(true);
    await database.prepare("CREATE TRIGGER fail_skill_part BEFORE INSERT ON agent_skill_state_parts WHEN NEW.part = 9 BEGIN SELECT RAISE(ABORT, 'injected part failure'); END").run();
    await expect(repository.save(skillFixtureId, 'large-owner', 'first', { ...state, completedChunks: 99 })).rejects.toThrow();
    expect((await repository.get(skillFixtureId, 'large-owner'))?.state.completedChunks).toBe(1);
    await database.prepare('DROP TRIGGER fail_skill_part').run();
    expect(await repository.claim(skillFixtureId, 'large-owner', 'second', 2001, 3000)).toBe(true);
    expect(await repository.save(skillFixtureId, 'large-owner', 'first', { ...state, completedChunks: 99 })).toBe(false);
    expect((await repository.get(skillFixtureId, 'large-owner'))?.state.completedChunks).toBe(1);
    expect(await repository.save(skillFixtureId, 'large-owner', 'second', { ...state, completedChunks: 2 })).toBe(true);
    expect((await repository.get(skillFixtureId, 'large-owner'))?.state.completedChunks).toBe(2);
    expect((await database.prepare('SELECT COUNT(DISTINCT revision) AS count FROM agent_skill_state_parts').first<{ count: number }>())!.count).toBe(1);
    await database.prepare('DELETE FROM users WHERE id = ?').bind('large-owner').run();
    expect((await database.prepare('SELECT COUNT(*) AS count FROM agent_skill_state_parts').first<{ count: number }>())!.count).toBe(0);
  } finally { await dispose(); }
}, 30_000);


/** Model the remote D1 RPC envelope, which Miniflare does not limit itself. */
function rpcBounded(database: D1Database, onBatch?: () => Promise<void>) {
  const statements = new WeakMap<D1PreparedStatement, { statement: D1PreparedStatement; parameters: unknown[] }>();
  let maximumBytes = 0;
  const check = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    maximumBytes = Math.max(maximumBytes, bytes);
    if (bytes > 32 * 1024 * 1024) throw new Error('D1_ERROR: Serialized RPC arguments or return values are limited to 32MiB');
  };
  const wrap = (statement: D1PreparedStatement, parameters: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), args);
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (['raw', 'all', 'first'].includes(String(key))) return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args); check(result); return result;
      };
      return value.bind(target);
    } });
    statements.set(proxy, { statement, parameters }); return proxy;
  };
  return { maximumBytes: () => maximumBytes, database: new Proxy(database, { get(target, key) {
    if (key === 'prepare') return (query: string) => wrap(target.prepare(query));
    if (key === 'batch') return async (batch: D1PreparedStatement[]) => {
      check(batch.map(statement => statements.get(statement)?.parameters ?? []));
      const result = await target.batch(batch.map(statement => statements.get(statement)?.statement ?? statement));
      check(result); await onBatch?.(); return result;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

it('uploads and reads a course snapshot beyond the remote 32MiB RPC envelope without exposing partial revisions', async () => {
  const { database, dispose } = await createD1Fixture();
  try {
    await database.prepare("INSERT INTO users (id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('rpc-owner','rpc-owner','rpc@example.test',0,0,0,0)").run();
    const state = { version: 1 as const, target: { kind: 'course' as const, resourceId: 51 }, objective: '', automatic: true, language: 'ja' as const,
      resourceTitle: 'Large course', fingerprint: 'rpc', stage: 'extracting' as const,
      chunks: Array.from({ length: 282 }, (_, chunk) => Array.from({ length: 333 }, (_, cue) => ({ id: `v${chunk}-c${cue}`, videoId: chunk, title: '講座から学ぶ具体的なエンジニアリングの意思決定', start: '00:01:00.000', end: '00:01:05.000', text: '講師が説明する手順と適用条件。'.repeat(5) }))),
      completedChunks: 0, sourceVideos: 177, facts: [], draft: null, issues: [] };
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeGreaterThan(32 * 1024 * 1024);
    const raw = createD1AgentSkillRepository(database);
    let phase: 'create' | 'save' | 'done' = 'create', observedCreate = false, observedSave = false;
    const bounded = rpcBounded(database, async () => {
      if (phase === 'create' && !observedCreate) { observedCreate = true; expect(await raw.get(skillFixtureId, 'rpc-owner')).toBeNull(); }
      if (phase === 'save' && !observedSave) { observedSave = true; expect((await raw.get(skillFixtureId, 'rpc-owner'))?.state.completedChunks).toBe(0); }
    });
    const repository = createD1AgentSkillRepository(bounded.database);
    await repository.create({ id: skillFixtureId, ownerId: 'rpc-owner', state });
    phase = 'done';
    expect((await repository.get(skillFixtureId, 'rpc-owner'))?.state.chunks).toEqual(state.chunks);
    expect(await repository.claim(skillFixtureId, 'rpc-owner', 'lease', 1000, 2000)).toBe(true);
    phase = 'save';
    await database.prepare('INSERT INTO agent_skill_state_parts(skill_id,revision,part,content) VALUES(?,?,0,?)').bind(skillFixtureId, 'abandoned-upload', 'not published').run();
    expect(await repository.save(skillFixtureId, 'rpc-owner', 'lease', { ...state, completedChunks: 1 })).toBe(true);
    phase = 'done';
    expect((await repository.get(skillFixtureId, 'rpc-owner'))?.state.completedChunks).toBe(1);
    expect(observedCreate && observedSave).toBe(true);
    expect(bounded.maximumBytes()).toBeLessThan(4 * 1024 * 1024);
    expect((await database.prepare('SELECT COUNT(DISTINCT revision) AS count FROM agent_skill_state_parts').first<{count:number}>())?.count).toBe(1);
  } finally { await dispose(); }
}, 60_000);

it('cleans an interrupted initial upload and fences a writer whose lease changes between part batches', async () => {
  const { database, dispose } = await createD1Fixture();
  try {
    await database.prepare("INSERT INTO users (id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('staged-owner','staged-owner','staged@example.test',0,0,0,0)").run();
    const state = { version: 1 as const, target: { kind: 'course' as const, resourceId: 42 }, objective: '', automatic: true, language: 'ja' as const,
      resourceTitle: 'Staged', fingerprint: 'staged', stage: 'extracting' as const, chunks: skillChunks({ title: 'Staged', sources: [{id: 1, title: 'Source', transcript: '講座の字幕'.repeat(150_000)}] }),
      completedChunks: 0, sourceVideos: 1, facts: [], draft: null, issues: [] };
    const raw = createD1AgentSkillRepository(database);
    await database.prepare("CREATE TRIGGER fail_staged_part BEFORE INSERT ON agent_skill_state_parts WHEN NEW.part = 9 BEGIN SELECT RAISE(ABORT, 'later upload failed'); END").run();
    await expect(raw.create({ id: skillFixtureId, ownerId: 'staged-owner', state })).rejects.toThrow();
    expect(await raw.get(skillFixtureId, 'staged-owner')).toBeNull();
    expect(await database.prepare('SELECT COUNT(*) AS count FROM agent_skill_state_parts').first('count')).toBe(0);
    await database.prepare('DROP TRIGGER fail_staged_part').run();
    await raw.create({ id: skillFixtureId, ownerId: 'staged-owner', state });
    expect(await raw.claim(skillFixtureId, 'staged-owner', 'old', 1000, 2000)).toBe(true);
    let replaced = false;
    const wrapped = rpcBounded(database, async () => {
      if (replaced) return; replaced = true;
      expect((await raw.get(skillFixtureId, 'staged-owner'))?.state.completedChunks).toBe(0);
      expect(await raw.claim(skillFixtureId, 'staged-owner', 'new', 2001, 3000)).toBe(true);
      expect(await raw.save(skillFixtureId, 'staged-owner', 'new', {...state, completedChunks: 2})).toBe(true);
    });
    expect(await createD1AgentSkillRepository(wrapped.database).save(skillFixtureId, 'staged-owner', 'old', {...state, completedChunks: 1})).toBe(false);
    expect((await raw.get(skillFixtureId, 'staged-owner'))?.state.completedChunks).toBe(2);
    expect(await database.prepare('SELECT COUNT(DISTINCT revision) AS count FROM agent_skill_state_parts').first('count')).toBe(1);
    const lostAcknowledgement = rpcBounded(database, async () => {
      if ((await raw.get(skillFixtureId, 'staged-owner'))?.state.completedChunks === 3) throw new Error('lost commit acknowledgement');
    });
    await expect(createD1AgentSkillRepository(lostAcknowledgement.database).save(skillFixtureId, 'staged-owner', 'new', {...state, completedChunks: 3})).rejects.toThrow('lost commit acknowledgement');
    expect((await raw.get(skillFixtureId, 'staged-owner'))?.state.completedChunks).toBe(3);
    expect(await database.prepare('SELECT COUNT(DISTINCT revision) AS count FROM agent_skill_state_parts').first('count')).toBe(1);
  } finally { await dispose(); }
}, 30_000);
