import { createD1Connection } from '../../db/d1/connection';
import { agentSkills } from '../../db/schema/sqlite';
import { and, eq, or, isNull, lt } from 'drizzle-orm';
import type { AgentSkillRepository } from '../contracts/agent-skill-repository';
export function createD1AgentSkillRepository(database: D1Database): AgentSkillRepository {
  const db = createD1Connection(database);
  const run = <T>(operation: (db: ReturnType<typeof createD1Connection>) => Promise<T>) => operation(db);
  return {
    create: record => run(async db => { await db.insert(agentSkills).values({ ...record, createdAt: new Date().toISOString() }); }),
    get: (id, ownerId) => run(async db => {
      const [row] = await db.select().from(agentSkills).where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId))).limit(1);
      return row ? { id: row.id, ownerId: row.ownerId, state: row.state } : null;
    }),
    claim: (id, ownerId, token, now, expiresAt) => run(async db => {
      const rows = await db.update(agentSkills).set({ leaseToken: token, leaseExpiresAt: expiresAt })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), or(isNull(agentSkills.leaseToken), lt(agentSkills.leaseExpiresAt, now))))
        .returning({ id: agentSkills.id });
      return rows.length > 0;
    }),
    save: (id, ownerId, token, state) => run(async db => {
      const rows = await db.update(agentSkills).set({ state })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token)))
        .returning({ id: agentSkills.id });
      return rows.length > 0;
    }),
    release: (id, ownerId, token) => run(async db => {
      await db.update(agentSkills).set({ leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(agentSkills.id, id), eq(agentSkills.ownerId, ownerId), eq(agentSkills.leaseToken, token)));
    }),
  };
}
