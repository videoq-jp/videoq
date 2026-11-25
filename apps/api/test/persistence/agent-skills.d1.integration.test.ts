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
    await database.prepare("CREATE TRIGGER fail_skill_part BEFORE INSERT ON agent_skill_state_parts WHEN NEW.part = 1 BEGIN SELECT RAISE(ABORT, 'injected part failure'); END").run();
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
