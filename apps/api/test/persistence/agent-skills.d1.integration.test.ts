import { it, expect } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { createD1AgentSkillRepository } from '../../src/persistence/d1/agent-skill-repository';
import { skillChunks, checkedFacts } from '../../src/features/skills/core';
import { skillMaterial, extractedSkillFacts, generatedSkillDraft, skillFixtureId } from '../fixtures/agent-skill';

it('persists skill progress in D1, fences concurrent workers, and cascades account deletion', async () => {
  const { database, dispose } = await createD1Fixture();
  try {
    await database.prepare('INSERT INTO users (id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES (?, ?, ?, 0, 0, 0, 0)').bind('skill-owner', 'skill-owner', 'skill-owner@example.test').run();
    const repository = createD1AgentSkillRepository(database), chunks = skillChunks(skillMaterial);
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
    await database.prepare('DELETE FROM users WHERE id = ?').bind('skill-owner').run();
    expect(await repository.get(skillFixtureId, 'skill-owner')).toBeNull();
  } finally { await dispose(); }
}, 30_000);
