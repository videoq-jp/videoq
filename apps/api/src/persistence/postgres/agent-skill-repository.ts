import { withDb } from '../../db/pool';
import { agentSkills, agentSkillStateParts, videos } from '../../db/schema';
import type { Bindings } from '../../types/bindings';
import { and, eq, or, isNull, lt, asc, ne, inArray } from 'drizzle-orm';
import { encodeSkillState, isSkillStatePointer, decodeSkillParts } from '../agent-skill-state';
import type { AgentSkillRepository } from '../contracts/agent-skill-repository';
export function createPostgresAgentSkillRepository(env: Bindings): AgentSkillRepository {

  const run = <T>(operation: (db: import('../../db/pool').Db) => Promise<T>) => withDb(env, async db => operation(db));
  return {
    sources: (ownerId, ids) => run(db => db.select({ id: videos.id, title: videos.title, transcript: videos.transcript, status: videos.status }).from(videos).where(and(eq(videos.userId, ownerId), inArray(videos.id, ids)))),
    create: record => run(db => db.transaction(async tx => {
      const packed = encodeSkillState(record.state, crypto.randomUUID());
      await tx.insert(agentSkills).values({ ...record, state: packed.state, createdAt: new Date().toISOString() });
      for (const [part, content] of packed.parts.entries()) await tx.insert(agentSkillStateParts).values({ skillId: record.id, revision: isSkillStatePointer(packed.state) ? packed.state.revision : '', part, content });
    })),
    get: (id, ownerId) => run(async db => {
      // A committed writer may retire the revision read just before its commit.
      // Retry the pointer instead of serving partial state or a stale revision.
      for (let attempt = 0; attempt < 3; attempt++) {
        const [row] = await db.select().from(agentSkills).where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId))).limit(1);
        if (!row) return null;
        if (!isSkillStatePointer(row.state)) return { id: row.id, ownerId: row.ownerId, state: row.state };
        const rows = await db.select({ part: agentSkillStateParts.part, content: agentSkillStateParts.content }).from(agentSkillStateParts)
          .where(and(eq(agentSkillStateParts.skillId, id), eq(agentSkillStateParts.revision, row.state.revision))).orderBy(asc(agentSkillStateParts.part));
        const state = decodeSkillParts(row.state, rows);
        if (state) return { id: row.id, ownerId: row.ownerId, state };
      }
      throw new Error('Skill progress changed while reading. Retry.');
    }),
    claim: (id, ownerId, token, now, expiresAt) => run(async db => {
      const rows = await db.update(agentSkills).set({ leaseToken: token, leaseExpiresAt: expiresAt })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), or(isNull(agentSkills.leaseToken), lt(agentSkills.leaseExpiresAt, now))))
        .returning({ id: agentSkills.id });
      return rows.length > 0;
    }),
    save: (id, ownerId, token, state) => run(db => db.transaction(async tx => {
      const revision = crypto.randomUUID(), packed = encodeSkillState(state, revision);
      const rows = await tx.update(agentSkills).set({ state: packed.state }).where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token))).returning({ id: agentSkills.id });
      if (!rows.length) return false;
      for (const [part, content] of packed.parts.entries()) await tx.insert(agentSkillStateParts).values({ skillId: id, revision, part, content });
      await tx.delete(agentSkillStateParts).where(and(eq(agentSkillStateParts.skillId, id), ne(agentSkillStateParts.revision, revision)));
      return true;
    })),
    release: (id, ownerId, token) => run(async db => {
      await db.update(agentSkills).set({ leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token)));
    }),
  };
}
