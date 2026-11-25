import { it, expect } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, agentSkills, agentSkillStateParts } from '../../src/db/schema';
import { createPostgresAgentSkillRepository } from '../../src/persistence/postgres/agent-skill-repository';
import { isolatedPostgres } from './isolated-postgres';
import { skillChunks } from '../../src/features/skills/core';
import { skillFixtureId } from '../fixtures/agent-skill';
import type { Bindings } from '../../src/types/bindings';
import type { AgentSkillState } from '../../src/persistence/contracts/agent-skill-repository';
const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? it : it.skip)('atomically partitions PostgreSQL snapshots, rolls back failed writes and cascades parts', async () => {
  const fixture = await isolatedPostgres(url!);
  try {
    const sql = await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ users, agentSkills, agentSkillStateParts }));
    await fixture.pool.query(sql.map(statement => statement.replaceAll('"public".', '')).join('\n'));
    await fixture.pool.query('INSERT INTO users(id, username, email, is_over_quota, used_ai_answers, used_processing_seconds, used_storage_bytes) VALUES ($1,$2,$3,false,0,0,0)', ['owner', 'owner', 'owner@example.test']);
    const repository = createPostgresAgentSkillRepository({ DATABASE_POOL: fixture.pool } as Bindings);
    const state: AgentSkillState = { version: 1, target: { kind: 'course', resourceId: 42 }, objective: '', automatic: true, language: 'ja', resourceTitle: 'Large', fingerprint: 'original', stage: 'extracting', chunks: skillChunks({ title: 'Large', sources: [{ id: 1, title: 'Large', transcript: '知恵🙂'.repeat(100_000) }] }), completedChunks: 0, sourceVideos: 1, facts: [], draft: null, issues: [] };
    await repository.create({ id: skillFixtureId, ownerId: 'owner', state });
    expect((await repository.get(skillFixtureId, 'owner'))?.state).toEqual(state);
    expect(await repository.get(skillFixtureId, 'other')).toBeNull();
    expect(await repository.claim(skillFixtureId, 'owner', 'lease', 1000, 2000)).toBe(true);
    await fixture.pool.query("CREATE FUNCTION fail_skill_part() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.part=1 THEN RAISE EXCEPTION 'injected part failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_skill_part BEFORE INSERT ON agent_skill_state_parts FOR EACH ROW EXECUTE FUNCTION fail_skill_part()");
    await expect(repository.save(skillFixtureId, 'owner', 'lease', { ...state, completedChunks: 1 })).rejects.toThrow();
    expect((await repository.get(skillFixtureId, 'owner'))?.state.completedChunks).toBe(0);
    await fixture.pool.query('DROP TRIGGER fail_skill_part ON agent_skill_state_parts');
    expect(await repository.save(skillFixtureId, 'owner', 'lease', { ...state, completedChunks: 1 })).toBe(true);
    expect(await repository.claim(skillFixtureId, 'owner', 'new-lease', 2001, 3000)).toBe(true);
    expect(await repository.save(skillFixtureId, 'owner', 'lease', state)).toBe(false);
    expect((await repository.get(skillFixtureId, 'owner'))?.state.completedChunks).toBe(1);
    expect((await fixture.pool.query('SELECT count(DISTINCT revision)::int AS count FROM agent_skill_state_parts')).rows[0].count).toBe(1);
    await fixture.pool.query('DELETE FROM users WHERE id=$1', ['owner']);
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM agent_skill_state_parts')).rows[0].count).toBe(0);
  } finally { await fixture.dispose(); }
}, 30_000);
