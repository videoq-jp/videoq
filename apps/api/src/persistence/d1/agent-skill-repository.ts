import { createD1Connection } from '../../db/d1/connection';
import { agentSkills, agentSkillStateParts, videos } from '../../db/schema/sqlite';
import { and, eq, or, isNull, lt, asc, gte, ne, inArray, exists, notExists, sql } from 'drizzle-orm';
import { encodeSkillState, isSkillStatePointer, decodeSkillParts } from '../agent-skill-state';
import type { AgentSkillRepository } from '../contracts/agent-skill-repository';
// D1's RPC ceiling applies to the whole call, even when every SQL row is small.
const PARTS_PER_CALL = 8;
export function createD1AgentSkillRepository(database: D1Database): AgentSkillRepository {
  const db = createD1Connection(database);
  const run = <T>(operation: (db: ReturnType<typeof createD1Connection>) => Promise<T>) => operation(db);
  return {
    sources: (ownerId, ids) => run(db => db.select({ id: videos.id, title: videos.title, transcript: videos.transcript, status: videos.status }).from(videos).where(and(eq(videos.userId, ownerId), inArray(videos.id, ids)))),
    create: record => run(async db => {
      const packed = encodeSkillState(record.state, crypto.randomUUID());
      if (!isSkillStatePointer(packed.state)) {
        await db.insert(agentSkills).values({ ...record, state: packed.state, createdAt: new Date().toISOString() });
        return;
      }
      const pointer = packed.state, pending = { ...pointer, pending: true as const };
      const provisional = and(eq(agentSkills.id, record.id), eq(agentSkills.ownerId, record.ownerId), eq(agentSkills.state, pending));
      await db.insert(agentSkills).values({ ...record, state: pending, createdAt: new Date().toISOString() });
      try {
        for (let offset = 0; offset < packed.parts.length; offset += PARTS_PER_CALL) {
          const inserts = packed.parts.slice(offset, offset + PARTS_PER_CALL).map((content, index) => db.insert(agentSkillStateParts).values({ skillId: record.id, revision: pointer.revision, part: offset + index, content }));
          await db.batch([inserts[0], ...inserts.slice(1)]);
        }
        await db.update(agentSkills).set({ state: pointer }).where(provisional);
      } catch (error) {
        // A failed upload is never visible as a resumable job. If publication
        // committed but its acknowledgement was lost, preserve that full state.
        await db.delete(agentSkills).where(provisional);
        throw error;
      }
    }),
    get: (id, ownerId) => run(async db => {
      // A committed writer may retire the revision read just before its commit.
      // Retry the pointer instead of serving partial state or a stale revision.
      for (let attempt = 0; attempt < 3; attempt++) {
        const [row] = await db.select().from(agentSkills).where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId))).limit(1);
        if (!row) return null;
        if (!isSkillStatePointer(row.state)) return { id: row.id, ownerId: row.ownerId, state: row.state };
        if (row.state.pending) return null;
        const rows: { part: number; content: string }[] = [];
        for (let offset = 0; offset < row.state.count; offset += PARTS_PER_CALL) {
          const page = await db.select({ part: agentSkillStateParts.part, content: agentSkillStateParts.content }).from(agentSkillStateParts)
            .where(and(eq(agentSkillStateParts.skillId, id), eq(agentSkillStateParts.revision, row.state.revision), gte(agentSkillStateParts.part, offset)))
            .orderBy(asc(agentSkillStateParts.part)).limit(PARTS_PER_CALL);
          rows.push(...page);
          if (page.length < PARTS_PER_CALL) break;
        }
        const state = decodeSkillParts(row.state, rows);
        if (state) return { id: row.id, ownerId: row.ownerId, state };
      }
      throw new Error('Skill progress changed while reading. Retry.');
    }),
    claim: (id, ownerId, token, now, expiresAt) => run(async db => {
      const rows = await db.update(agentSkills).set({ leaseToken: token, leaseExpiresAt: expiresAt })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), sql`coalesce(json_extract(${agentSkills.state}, '$.pending'), 0) != 1`, or(isNull(agentSkills.leaseToken), lt(agentSkills.leaseExpiresAt, now))))
        .returning({ id: agentSkills.id });
      return rows.length > 0;
    }),
    save: (id, ownerId, token, state) => run(async db => {
      const owned = and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token));
      const [previous] = await db.select({ state: agentSkills.state }).from(agentSkills).where(owned);
      if (!previous || isSkillStatePointer(previous.state) && previous.state.pending) return false;
      const revision = crypto.randomUUID(), packed = encodeSkillState(state, revision);
      const unchanged = and(owned, eq(agentSkills.state, previous.state));
      let saved = false;
      try {
        for (let offset = 0; offset < packed.parts.length; offset += PARTS_PER_CALL) {
          const inserts = packed.parts.slice(offset, offset + PARTS_PER_CALL).map((content, index) => db.insert(agentSkillStateParts).select(db.select({ skillId: sql<string>`${id}`.as('skill_id'), revision: sql<string>`${revision}`.as('revision'), part: sql<number>`${offset + index}`.as('part'), content: sql<string>`${content}`.as('content') }).from(agentSkills).where(unchanged)).onConflictDoNothing());
          await db.batch([inserts[0], ...inserts.slice(1)]);
        }
        // Publish only a complete staged revision under the unchanged lease and
        // pointer. Retire replaced/abandoned uploads only if publication won.
        const complete = sql`(select count(*) from ${agentSkillStateParts} where ${agentSkillStateParts.skillId} = ${id} and ${agentSkillStateParts.revision} = ${revision}) = ${packed.parts.length}`;
        const results = await db.batch([
          db.update(agentSkills).set({ state: packed.state }).where(and(unchanged, complete)).returning({ id: agentSkills.id }),
          db.delete(agentSkillStateParts).where(and(eq(agentSkillStateParts.skillId, id), ne(agentSkillStateParts.revision, revision), exists(db.select({ id: agentSkills.id }).from(agentSkills).where(and(owned, eq(agentSkills.state, packed.state)))))),
        ]);
        saved = (results[0] as { id: string }[]).length > 0;
        return saved;
      } finally {
        if (!saved && packed.parts.length) await db.delete(agentSkillStateParts).where(and(eq(agentSkillStateParts.skillId, id), eq(agentSkillStateParts.revision, revision), notExists(db.select({ id: agentSkills.id }).from(agentSkills).where(and(eq(agentSkills.id, id), sql`json_extract(${agentSkills.state}, '$.revision') = ${revision}`)))));
      }
    }),
    release: (id, ownerId, token) => run(async db => {
      await db.update(agentSkills).set({ leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token)));
    }),
  };
}
