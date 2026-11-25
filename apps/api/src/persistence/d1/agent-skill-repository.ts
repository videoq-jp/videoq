import { createD1Connection } from '../../db/d1/connection';
import { agentSkills, agentSkillStateParts, videos } from '../../db/schema/sqlite';
import { and, eq, or, isNull, lt, asc, ne, inArray, exists, sql } from 'drizzle-orm';
import { encodeSkillState, isSkillStatePointer, decodeSkillParts } from '../agent-skill-state';
import type { AgentSkillRepository } from '../contracts/agent-skill-repository';
export function createD1AgentSkillRepository(database: D1Database): AgentSkillRepository {
  const db = createD1Connection(database);
  const run = <T>(operation: (db: ReturnType<typeof createD1Connection>) => Promise<T>) => operation(db);
  return {
    sources: (ownerId, ids) => run(db => db.select({ id: videos.id, title: videos.title, transcript: videos.transcript, status: videos.status }).from(videos).where(and(eq(videos.userId, ownerId), inArray(videos.id, ids)))),
    create: record => run(async db => {
      const packed = encodeSkillState(record.state, crypto.randomUUID());
      const inserts = packed.parts.map((content, part) => db.insert(agentSkillStateParts).values({ skillId: record.id, revision: isSkillStatePointer(packed.state) ? packed.state.revision : '', part, content }));
      await db.batch([db.insert(agentSkills).values({ ...record, state: packed.state, createdAt: new Date().toISOString() }), ...inserts]);
    }),
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
    save: (id, ownerId, token, state) => run(async db => {
      const revision = crypto.randomUUID(), packed = encodeSkillState(state, revision);
      const owned = and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token));
      const inserts = packed.parts.map((content, part) => db.insert(agentSkillStateParts).select(db.select({ skillId: sql<string>`${id}`.as('skill_id'), revision: sql<string>`${revision}`.as('revision'), part: sql<number>`${part}`.as('part'), content: sql<string>`${content}`.as('content') }).from(agentSkills).where(owned)).onConflictDoNothing());
      const results = await db.batch([
        db.update(agentSkills).set({ state: packed.state }).where(owned).returning({ id: agentSkills.id }),
        ...inserts,
        db.delete(agentSkillStateParts).where(and(eq(agentSkillStateParts.skillId, id), ne(agentSkillStateParts.revision, revision), exists(db.select({ id: agentSkills.id }).from(agentSkills).where(owned)))),
      ]);
      const saved = results[0] as { id: string }[];
      return saved.length > 0;
    }),
    release: (id, ownerId, token) => run(async db => {
      await db.update(agentSkills).set({ leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token)));
    }),
  };
}
