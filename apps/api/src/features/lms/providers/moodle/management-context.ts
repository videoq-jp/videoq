import { and, eq } from 'drizzle-orm';
import { moodleManagementRequest } from '@videoq/trpc/moodle-management';
import type { z } from 'zod';
import { withDb } from '../../../../db/pool';
import { lmsInstallations, users } from '../../../../db/schema';
import { features } from '../../../../lib/deployment';
import type { Bindings } from '../../../../types/bindings';

/** Independent account authentication is mandatory; Moodle roles are not inputs. */
export async function managementContext(env: Bindings, userId: string, input: z.infer<typeof moodleManagementRequest>) {
  return withDb(env, async db => {
    const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;
    const [connection] = await db.select({ active: lmsInstallations.active }).from(lmsInstallations)
      .where(and(eq(lmsInstallations.ownerUserId, userId), eq(lmsInstallations.issuer, input.issuer),
        eq(lmsInstallations.clientId, input.clientId), eq(lmsInstallations.deploymentId, input.deploymentId))).limit(1);
    // Inactive connections still belong to their owner. Navigation never
    // reactivates them or grants course access, including for system admins.
    const owned = Boolean(connection);
    return { connection: { owned, active: connection?.active ?? null },
      permissions: { account: owned, billing: owned && features(env).billing, systemAdmin: user.role === 'admin' } };
  });
}
